use crate::db::{deploy_flows_repo, deploy_trackings_repo, settings_repo, DbPool};
use crate::deploy::ci::{self, CiRun, CiStatus};
use crate::deploy::cluster;
use crate::deploy::excerpt::tail_redacted;
use crate::deploy::machine::{self, Effect, NotifyKind, Observation};
use crate::deploy::reflog::PushDetector;
use crate::deploy::runner::{shell_runner, CommandRunner, SystemRunner};
use crate::deploy::{
    vpn, BLOCKED_POLL, BUILD_POLL, CLUSTER_POLL, DEPLOY_CHANGED_EVENT, PUSH_POLL,
    TRACKING_HISTORY, VPN_SETTING_KEY,
};
use crate::domain::deploy::{DeployChangedEvent, DeployFlow, Tracking};
use crate::error::AppResult;
use crate::state::AppState;
use futures_util::future::join_all;
use parking_lot::Mutex;
use rusqlite::Connection;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

const LOG_EXCERPT_LINES: usize = 60;

pub trait TrackerSink: Send + Sync {
    fn changed(&self, repo_path: Option<&str>);
    fn notify(&self, kind: NotifyKind, tracking: &Tracking, flow: &DeployFlow);
}

type VpnName = Box<dyn Fn() -> Option<String> + Send + Sync>;

#[derive(Clone, Copy)]
struct Schedule {
    next_ci: i64,
    next_cluster: i64,
}

#[derive(Default)]
struct Ledger {
    detector: PushDetector,
    schedule: HashMap<i64, Schedule>,
    in_flight: HashSet<i64>,
    forced: HashSet<i64>,
}

pub struct DeployTracker {
    db: DbPool,
    runner: OnceLock<Arc<dyn CommandRunner>>,
    sink: Arc<dyn TrackerSink>,
    vpn_name: VpnName,
    ledger: Mutex<Ledger>,
    wake: Notify,
}

struct Selection {
    tracking: Tracking,
    flow: DeployFlow,
    ci: bool,
    cluster: bool,
}

struct InFlight<'a> {
    tracker: &'a DeployTracker,
    id: i64,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.tracker.ledger.lock().in_flight.remove(&self.id);
    }
}

struct Outcome {
    tracking: Tracking,
    notices: Vec<NotifyKind>,
    vpn_tried: bool,
}

impl DeployTracker {
    fn new(db: DbPool, sink: Arc<dyn TrackerSink>, vpn_name: VpnName) -> Self {
        DeployTracker {
            db,
            runner: OnceLock::new(),
            sink,
            vpn_name,
            ledger: Mutex::new(Ledger::default()),
            wake: Notify::new(),
        }
    }

    pub fn start(app: AppHandle, db: DbPool) -> Arc<DeployTracker> {
        let settings = db.clone();
        let sink = Arc::new(AppSink { app: app.clone() });
        let tracker = Arc::new(Self::new(db, sink, Box::new(move || read_vpn_name(&settings))));
        let ready = tracker.clone();
        tauri::async_runtime::spawn(async move {
            let built = tauri::async_runtime::spawn_blocking(move || {
                shell_runner(&app.state::<AppState>())
            })
            .await;
            let runner = built.unwrap_or_else(|error| {
                eprintln!("deploy: the shell environment could not be loaded: {error}");
                SystemRunner::new(std::env::vars().collect())
            });
            let _ = ready.runner.set(Arc::new(runner));
            ready.wake.notify_one();
        });
        spawn_loop(tracker.clone());
        tracker
    }

    pub fn with_parts(
        db: DbPool,
        runner: Arc<dyn CommandRunner>,
        sink: Arc<dyn TrackerSink>,
        vpn_name: impl Fn() -> Option<String> + Send + Sync + 'static,
    ) -> Arc<DeployTracker> {
        let tracker = Self::new(db, sink, Box::new(vpn_name));
        let _ = tracker.runner.set(runner);
        Arc::new(tracker)
    }

    pub async fn tick(&self, now: i64) {
        let runner = self.runner.get().cloned();
        let mut changed = BTreeSet::new();
        let selections = match self.prepare(now, runner.is_some(), &mut changed) {
            Ok(selections) => selections,
            Err(error) => {
                eprintln!("deploy: tracker tick failed: {error}");
                Vec::new()
            }
        };
        self.settle(&changed);
        let Some(runner) = runner else { return };
        let rounds = selections.into_iter().map(|selection| {
            let guard = InFlight { tracker: self, id: selection.tracking.id };
            self.round(runner.as_ref(), selection, guard, now)
        });
        let changed: BTreeSet<String> = join_all(rounds).await.into_iter().flatten().collect();
        self.settle(&changed);
    }

    pub fn retry(&self, tracking_id: i64) {
        self.ledger.lock().forced.insert(tracking_id);
        self.wake.notify_one();
    }

    pub fn flows_changed(&self) {
        self.wake.notify_one();
    }

    fn prepare(
        &self,
        now: i64,
        observe: bool,
        changed: &mut BTreeSet<String>,
    ) -> AppResult<Vec<Selection>> {
        let conn = self.db.get()?;
        let flows = deploy_flows_repo::list_enabled(&conn)?;
        let mut ledger = self.ledger.lock();
        for (flow, push) in ledger.detector.poll(&flows) {
            match start_tracking(&conn, &flow, &push.commit, now) {
                Ok(()) => {
                    changed.insert(flow.repo_path.clone());
                }
                Err(error) => eprintln!("deploy: starting a tracking failed: {error}"),
            }
        }
        let open = deploy_trackings_repo::open(&conn)?;
        let open_ids: HashSet<i64> = open.iter().map(|tracking| tracking.id).collect();
        ledger.schedule.retain(|id, _| open_ids.contains(id));
        ledger.forced.retain(|id| open_ids.contains(id));

        let mut selections = Vec::new();
        for tracking in open {
            let Some(flow) = flows.iter().find(|flow| flow.repo_path == tracking.repo_path) else {
                match deploy_trackings_repo::update(&conn, &machine::supersede(&tracking, now)) {
                    Ok(()) => {
                        changed.insert(tracking.repo_path.clone());
                    }
                    Err(error) => eprintln!("deploy: closing a tracking failed: {error}"),
                }
                continue;
            };
            if !observe || ledger.in_flight.contains(&tracking.id) {
                continue;
            }
            let forced = ledger.forced.remove(&tracking.id);
            let due = ledger.schedule.get(&tracking.id).copied();
            let needs = machine::needs(&tracking, flow);
            ledger.in_flight.insert(tracking.id);
            selections.push(Selection {
                ci: needs.ci && (forced || due.is_none_or(|due| due.next_ci <= now)),
                cluster: needs.cluster && (forced || due.is_none_or(|due| due.next_cluster <= now)),
                flow: flow.clone(),
                tracking,
            });
        }
        Ok(selections)
    }

    async fn round(
        &self,
        runner: &dyn CommandRunner,
        selection: Selection,
        _guard: InFlight<'_>,
        now: i64,
    ) -> Option<String> {
        let outcome = self.observe(runner, &selection, now).await;
        if !self.persist(&selection, &outcome, now) {
            return None;
        }
        for kind in &outcome.notices {
            self.sink.notify(*kind, &outcome.tracking, &selection.flow);
        }
        Some(outcome.tracking.repo_path)
    }

    async fn observe(&self, runner: &dyn CommandRunner, selection: &Selection, now: i64) -> Outcome {
        let Selection { tracking: original, flow, ci, cluster } = selection;
        let new_pods_since = original.build_finished_at.unwrap_or(original.started_at);
        let (ci_observation, cluster_observation) = tokio::join!(
            async {
                if *ci {
                    Some(ci::observe(runner, flow, &original.commit).await)
                } else {
                    None
                }
            },
            async {
                if *cluster {
                    Some(cluster::observe(runner, flow, new_pods_since).await)
                } else {
                    None
                }
            },
        );
        let observations = ci_observation
            .map(Observation::Ci)
            .into_iter()
            .chain(cluster_observation.map(Observation::Cluster))
            .chain([Observation::Tick]);
        let mut tracking = original.clone();
        let mut effects = Vec::new();
        for observation in observations {
            let step = machine::advance(&tracking, flow, observation, now);
            tracking = step.tracking;
            effects.extend(step.effects);
        }
        let mut outcome = Outcome { tracking, notices: Vec::new(), vpn_tried: false };
        for effect in effects {
            self.apply(runner, flow, effect, &mut outcome).await;
        }
        outcome
    }

    async fn apply(
        &self,
        runner: &dyn CommandRunner,
        flow: &DeployFlow,
        effect: Effect,
        outcome: &mut Outcome,
    ) {
        match effect {
            Effect::Notify(kind) => outcome.notices.push(kind),
            Effect::FetchBuildLog => {
                let log = match failed_run(&outcome.tracking) {
                    Some(run) => ci::failure_log(runner, flow, &run).await,
                    None => None,
                };
                attach_log(&mut outcome.tracking, log);
            }
            Effect::FetchPodLog { pod } => {
                let log = cluster::pod_log(runner, flow, &pod).await;
                attach_log(&mut outcome.tracking, log);
            }
            Effect::ConnectVpn => {
                if !vpn::supported() {
                    return;
                }
                let Some(name) = (self.vpn_name)()
                    .map(|name| name.trim().to_string())
                    .filter(|name| !name.is_empty())
                else {
                    return;
                };
                vpn::connect(runner, &name).await;
                outcome.vpn_tried = true;
            }
        }
    }

    fn persist(&self, selection: &Selection, outcome: &Outcome, now: i64) -> bool {
        let mut ledger = self.ledger.lock();
        let blocked = machine::blocked(&outcome.tracking);
        let schedule = ledger
            .schedule
            .entry(selection.tracking.id)
            .or_insert(Schedule { next_ci: now, next_cluster: now });
        if selection.ci {
            schedule.next_ci = now + millis(if blocked.ci { BLOCKED_POLL } else { BUILD_POLL });
        }
        if selection.cluster {
            schedule.next_cluster = match (outcome.vpn_tried, blocked.cluster) {
                (true, _) => now,
                (false, true) => now + millis(BLOCKED_POLL),
                (false, false) => now + millis(CLUSTER_POLL),
            };
        }
        if outcome.tracking == selection.tracking {
            return false;
        }
        match self.save_open(&outcome.tracking) {
            Ok(saved) => saved,
            Err(error) => {
                eprintln!("deploy: saving tracking {} failed: {error}", outcome.tracking.id);
                false
            }
        }
    }

    fn save_open(&self, tracking: &Tracking) -> AppResult<bool> {
        let conn = self.db.get()?;
        if !deploy_trackings_repo::get(&conn, tracking.id)?.is_open() {
            return Ok(false);
        }
        deploy_trackings_repo::update(&conn, tracking)?;
        Ok(true)
    }

    fn prune(&self) -> AppResult<()> {
        let conn = self.db.get()?;
        deploy_trackings_repo::prune(&conn, TRACKING_HISTORY)
    }

    fn settle(&self, repos: &BTreeSet<String>) {
        if repos.is_empty() {
            return;
        }
        if let Err(error) = self.prune() {
            eprintln!("deploy: pruning trackings failed: {error}");
        }
        for repo in repos {
            self.sink.changed(Some(repo));
        }
    }
}

fn start_tracking(conn: &Connection, flow: &DeployFlow, commit: &str, now: i64) -> AppResult<()> {
    for open in deploy_trackings_repo::open(conn)? {
        if open.repo_path == flow.repo_path {
            deploy_trackings_repo::update(conn, &machine::supersede(&open, now))?;
        }
    }
    deploy_trackings_repo::insert(conn, &Tracking::new(flow, commit, now))?;
    Ok(())
}

fn failed_run(tracking: &Tracking) -> Option<CiRun> {
    Some(CiRun {
        id: tracking.run_id.clone()?,
        build_number: tracking.build_number,
        url: tracking.run_url.clone().unwrap_or_default(),
        status: CiStatus::Failed,
        finished_at: tracking.finished_at,
    })
}

fn attach_log(tracking: &mut Tracking, log: Option<String>) {
    let Some(failure) = tracking.failure.as_mut() else { return };
    let excerpt = log
        .map(|text| tail_redacted(&text, LOG_EXCERPT_LINES))
        .filter(|excerpt| !excerpt.trim().is_empty());
    if excerpt.is_some() {
        failure.log_excerpt = excerpt;
    }
}

fn millis(duration: Duration) -> i64 {
    duration.as_millis() as i64
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn read_vpn_name(db: &DbPool) -> Option<String> {
    let conn = db.get().ok()?;
    settings_repo::get(&conn, VPN_SETTING_KEY).ok().flatten()
}

fn spawn_loop(tracker: Arc<DeployTracker>) {
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(PUSH_POLL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = interval.tick() => {}
                _ = tracker.wake.notified() => {}
            }
            let current = tracker.clone();
            tauri::async_runtime::spawn(async move { current.tick(now_millis()).await });
        }
    });
}

struct AppSink {
    app: AppHandle,
}

impl TrackerSink for AppSink {
    fn changed(&self, repo_path: Option<&str>) {
        let event = DeployChangedEvent { repo_path: repo_path.map(str::to_string) };
        if let Err(error) = self.app.emit(DEPLOY_CHANGED_EVENT, event) {
            eprintln!("deploy: change event failed: {error}");
        }
    }

    fn notify(&self, kind: NotifyKind, tracking: &Tracking, flow: &DeployFlow) {
        eprintln!(
            "deploy: {kind:?} for {} at {} ({})",
            flow.repo_path, tracking.commit, flow.production_branch
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::deploy::runner::{ok, CommandOutput, FakeRunner, RunError};
    use crate::deploy::test_support::{conn, push, repo_with_push, TestConn};
    use crate::domain::deploy::{Blocker, BuildProvider, TrackingState};
    use async_trait::async_trait;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, Ordering};
    use tempfile::TempDir;

    const BASE: i64 = 1_795_000_000_000;
    const PIPELINES_PATH: &str = "/repositories/cybercode/hr-management/pipelines/";
    const STEPS_PATH: &str = "/repositories/cybercode/hr-management/pipelines/{run-7}/steps/";
    const STEPS: &str = r#"{"values":[{"uuid":"{step-1}","state":{"result":{"name":"FAILED"}}}]}"#;
    const UNREACHABLE: &str = "Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout";

    fn at(seconds: i64) -> i64 {
        BASE + seconds * 1000
    }

    fn commit(label: &str) -> String {
        label.repeat(40)
    }

    #[derive(Default)]
    struct RecordingSink {
        changed: parking_lot::Mutex<Vec<Option<String>>>,
        notified: parking_lot::Mutex<Vec<(NotifyKind, Tracking)>>,
    }

    impl RecordingSink {
        fn kinds(&self) -> Vec<NotifyKind> {
            self.notified.lock().iter().map(|(kind, _)| *kind).collect()
        }

        fn changed_repos(&self) -> Vec<Option<String>> {
            self.changed.lock().clone()
        }
    }

    impl TrackerSink for RecordingSink {
        fn changed(&self, repo_path: Option<&str>) {
            self.changed.lock().push(repo_path.map(str::to_string));
        }

        fn notify(&self, kind: NotifyKind, tracking: &Tracking, _flow: &DeployFlow) {
            self.notified.lock().push((kind, tracking.clone()));
        }
    }

    struct Fixture {
        _db: TestConn,
        pool: DbPool,
        repo: TempDir,
        flow: DeployFlow,
    }

    impl Fixture {
        fn new() -> Self {
            let db = conn();
            let pool = init_pool(&db.db_path().to_path_buf()).unwrap();
            let (repo, flow) = repo_with_push("a");
            deploy_flows_repo::upsert(&pool.get().unwrap(), &flow).unwrap();
            Fixture { _db: db, pool, repo, flow }
        }

        fn tracker(
            &self,
            runner: Arc<dyn CommandRunner>,
            sink: &Arc<RecordingSink>,
            vpn: Option<&str>,
        ) -> Arc<DeployTracker> {
            let name = vpn.map(str::to_string);
            DeployTracker::with_parts(self.pool.clone(), runner, sink.clone(), move || name.clone())
        }

        fn trackings(&self) -> Vec<Tracking> {
            deploy_trackings_repo::history(&self.pool.get().unwrap(), &self.flow.repo_path, 50)
                .unwrap()
        }

        fn only(&self) -> Tracking {
            let all = self.trackings();
            assert_eq!(all.len(), 1, "{all:?}");
            all.into_iter().next().unwrap()
        }

        fn save_flow(&self, flow: &DeployFlow) {
            deploy_flows_repo::upsert(&self.pool.get().unwrap(), flow).unwrap();
        }
    }

    fn pipeline(commit: &str, build: i64, state: Value) -> Value {
        json!({
            "uuid": format!("{{run-{build}}}"),
            "build_number": build,
            "state": state,
            "target": {
                "ref_type": "branch",
                "ref_name": "master",
                "commit": { "hash": commit }
            }
        })
    }

    fn running() -> Value {
        json!({ "name": "IN_PROGRESS", "stage": { "name": "RUNNING" } })
    }

    fn completed(result: &str) -> Value {
        json!({ "name": "COMPLETED", "result": { "name": result } })
    }

    fn pipelines(entries: Vec<Value>) -> String {
        json!({ "values": entries }).to_string()
    }

    fn building(label: &str) -> String {
        pipelines(vec![pipeline(&commit(label), 7, running())])
    }

    fn workloads(image: &str) -> String {
        json!({ "items": [{
            "kind": "Deployment",
            "metadata": { "name": "app", "generation": 1 },
            "spec": {
                "replicas": 1,
                "template": { "spec": { "containers": [{ "name": "app", "image": image }] } }
            },
            "status": { "observedGeneration": 1, "replicas": 1, "updatedReplicas": 1, "readyReplicas": 1 }
        }] })
        .to_string()
    }

    fn pods() -> String {
        json!({ "items": [{
            "metadata": {
                "name": "app-5d8f-x",
                "creationTimestamp": "2026-11-01T00:00:00Z",
                "ownerReferences": [{ "kind": "ReplicaSet", "name": "app-5d8f" }]
            },
            "status": {
                "phase": "Running",
                "startTime": "2026-11-01T00:00:00Z",
                "conditions": [{ "type": "Ready", "status": "True" }]
            }
        }] })
        .to_string()
    }

    fn fake(ci: &str, image: &str) -> FakeRunner {
        FakeRunner::new()
            .on("bkt", &["api", PIPELINES_PATH], ok(ci))
            .on(
                "kubectl",
                &["-n", "cs-app-hs", "get", "deployments,statefulsets"],
                ok(&workloads(image)),
            )
            .on("kubectl", &["-n", "cs-app-hs", "get", "pods"], ok(&pods()))
    }

    fn ci_polls(runner: &FakeRunner) -> usize {
        runner
            .calls()
            .iter()
            .filter(|(program, args)| {
                program == "bkt" && args.get(1).map(String::as_str) == Some(PIPELINES_PATH)
            })
            .count()
    }

    fn cluster_polls(runner: &FakeRunner) -> usize {
        runner
            .calls()
            .iter()
            .filter(|(program, args)| {
                program == "kubectl" && args.iter().any(|arg| arg == "deployments,statefulsets")
            })
            .count()
    }

    #[tokio::test]
    async fn a_push_starts_a_tracking_and_a_second_push_supersedes_it() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let ci = pipelines(vec![
            pipeline(&commit("b"), 7, running()),
            pipeline(&commit("c"), 8, running()),
        ]);
        let tracker = f.tracker(Arc::new(fake(&ci, "app:1")), &sink, None);

        tracker.tick(at(0)).await;
        assert!(f.trackings().is_empty());
        assert!(sink.changed_repos().is_empty());

        push(&f.repo, "b");
        tracker.tick(at(3)).await;
        let first = f.only();
        assert_eq!(first.commit, commit("b"));
        assert_eq!(first.state, TrackingState::Building);
        assert_eq!(first.started_at, at(3));
        assert_eq!(first.baseline_images, Some(vec!["app:1".to_string()]));
        assert!(sink.changed_repos().contains(&Some(f.flow.repo_path.clone())));

        let announced = sink.changed_repos().len();
        push(&f.repo, "c");
        tracker.tick(at(6)).await;
        let all = f.trackings();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].commit, commit("c"));
        assert!(all[0].is_open());
        assert_eq!(all[1].id, first.id);
        assert_eq!(all[1].state, TrackingState::Superseded);
        assert_eq!(all[1].finished_at, Some(at(6)));
        assert!(sink.changed_repos().len() > announced);
        assert!(sink.kinds().is_empty());
    }

    #[tokio::test]
    async fn an_open_tracking_survives_a_restart() {
        let f = Fixture::new();
        let first_sink = Arc::new(RecordingSink::default());
        let first = f.tracker(Arc::new(fake(&building("b"), "app:1")), &first_sink, None);
        first.tick(at(0)).await;
        push(&f.repo, "b");
        first.tick(at(3)).await;
        let started = f.only();
        assert_eq!(started.state, TrackingState::Building);
        drop(first);

        let second_sink = Arc::new(RecordingSink::default());
        let succeeded = pipelines(vec![pipeline(&commit("b"), 7, completed("SUCCESSFUL"))]);
        let second = f.tracker(Arc::new(fake(&succeeded, "app:2")), &second_sink, None);
        second.tick(at(30)).await;

        let finished = f.only();
        assert_eq!(finished.id, started.id);
        assert_eq!(finished.state, TrackingState::Succeeded);
        assert_eq!(finished.finished_at, Some(at(30)));
        assert_eq!(second_sink.kinds(), vec![NotifyKind::Succeeded]);
        assert!(first_sink.kinds().is_empty());
    }

    #[tokio::test]
    async fn a_resumed_tracking_is_judged_on_its_observations_before_its_time_limit() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let first = f.tracker(Arc::new(fake(&pipelines(vec![]), "app:1")), &sink, None);
        first.tick(at(0)).await;
        push(&f.repo, "b");
        first.tick(at(3)).await;
        assert_eq!(f.only().state, TrackingState::WaitingForRun);
        drop(first);

        let second = f.tracker(Arc::new(fake(&building("b"), "app:1")), &sink, None);
        second.tick(at(3 + 600)).await;
        assert_eq!(f.only().state, TrackingState::Building);
        assert!(sink.kinds().is_empty());
    }

    #[tokio::test]
    async fn a_push_made_before_the_app_started_is_not_tracked() {
        let f = Fixture::new();
        push(&f.repo, "b");
        let sink = Arc::new(RecordingSink::default());
        let runner = Arc::new(fake(&building("b"), "app:1"));
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        tracker.tick(at(3)).await;
        assert!(f.trackings().is_empty());
        assert!(runner.calls().is_empty());
        assert!(sink.changed_repos().is_empty());
    }

    #[tokio::test]
    async fn a_failed_build_stores_a_redacted_log_excerpt_and_notifies_once() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let failed = pipelines(vec![pipeline(&commit("b"), 7, completed("FAILED"))]);
        let runner = Arc::new(
            FakeRunner::new()
                .on("bkt", &["api", STEPS_PATH], ok(STEPS))
                .on("bkt", &["pipeline", "logs"], ok("step 1\nexport API_TOKEN=abc\nboom\n"))
                .on("bkt", &["api", PIPELINES_PATH], ok(&failed))
                .on(
                    "kubectl",
                    &["-n", "cs-app-hs", "get", "deployments,statefulsets"],
                    ok(&workloads("app:1")),
                )
                .on("kubectl", &["-n", "cs-app-hs", "get", "pods"], ok(&pods())),
        );
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        tracker.tick(at(3)).await;

        let tracking = f.only();
        assert_eq!(tracking.state, TrackingState::Failed);
        let excerpt = tracking.failure.as_ref().and_then(|failure| failure.log_excerpt.clone());
        let text = excerpt.clone().expect("a log excerpt");
        assert!(text.contains("boom"), "{text}");
        assert!(text.contains("API_TOKEN=***"), "{text}");
        assert!(!text.contains("abc"), "{text}");

        for second in (6..=60).step_by(3) {
            tracker.tick(at(second)).await;
        }
        assert_eq!(sink.kinds(), vec![NotifyKind::Failed]);
        let notified = sink.notified.lock()[0].1.clone();
        assert_eq!(notified.failure.and_then(|failure| failure.log_excerpt), excerpt);
        let log_calls = runner
            .calls()
            .iter()
            .filter(|(program, args)| program == "bkt" && args[0] == "pipeline")
            .count();
        assert_eq!(log_calls, 1);
        assert_eq!(ci_polls(&runner), 1);
    }

    #[tokio::test]
    async fn a_failed_rollout_stores_the_redacted_pod_log() {
        let f = Fixture::new();
        let mut flow = f.flow.clone();
        flow.build = BuildProvider::None;
        f.save_flow(&flow);
        let crashing = json!({ "items": [{
            "metadata": {
                "name": "app-5d8f-y",
                "creationTimestamp": "2030-01-01T00:00:00Z",
                "ownerReferences": [{ "kind": "ReplicaSet", "name": "app-5d8f" }]
            },
            "status": {
                "phase": "Running",
                "startTime": "2030-01-01T00:00:00Z",
                "conditions": [{ "type": "Ready", "status": "False" }],
                "containerStatuses": [{ "name": "app", "state": { "waiting": { "reason": "CrashLoopBackOff" } } }]
            }
        }] })
        .to_string();
        let runner = Arc::new(
            FakeRunner::new()
                .on(
                    "kubectl",
                    &["-n", "cs-app-hs", "get", "deployments,statefulsets"],
                    ok(&workloads("app:2")),
                )
                .on("kubectl", &["-n", "cs-app-hs", "get", "pods"], ok(&crashing))
                .on(
                    "kubectl",
                    &["-n", "cs-app-hs", "logs", "app-5d8f-y"],
                    ok("starting\nDB_PASSWORD=hunter2\npanic: boom\n"),
                ),
        );
        let sink = Arc::new(RecordingSink::default());
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        tracker.tick(at(3)).await;

        let tracking = f.only();
        assert_eq!(tracking.state, TrackingState::Failed);
        let failure = tracking.failure.expect("a failure");
        assert_eq!(failure.reason, "app-5d8f-y: CrashLoopBackOff");
        let excerpt = failure.log_excerpt.expect("a log excerpt");
        assert!(excerpt.contains("panic: boom"), "{excerpt}");
        assert!(excerpt.contains("DB_PASSWORD=***"), "{excerpt}");
        assert!(!excerpt.contains("hunter2"), "{excerpt}");
        assert_eq!(sink.kinds(), vec![NotifyKind::Failed]);
        assert!(runner.calls().iter().all(|(program, _)| program == "kubectl"));
    }

    #[tokio::test]
    async fn closing_a_tracking_keeps_only_the_recent_history() {
        let f = Fixture::new();
        for index in 0..TRACKING_HISTORY {
            let mut old = Tracking::new(&f.flow, &format!("old-{index}"), at(-100));
            old.state = TrackingState::Succeeded;
            old.finished_at = Some(at(-50));
            deploy_trackings_repo::insert(&f.pool.get().unwrap(), &old).unwrap();
        }
        let sink = Arc::new(RecordingSink::default());
        let tracker = f.tracker(Arc::new(fake(&building("b"), "app:1")), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        tracker.tick(at(3)).await;
        assert_eq!(f.trackings().len(), TRACKING_HISTORY + 1);

        let mut disabled = f.flow.clone();
        disabled.enabled = false;
        f.save_flow(&disabled);
        tracker.tick(at(6)).await;
        let all = f.trackings();
        assert_eq!(all.len(), TRACKING_HISTORY);
        assert_eq!(all[0].commit, commit("b"));
        assert_eq!(all[0].state, TrackingState::Superseded);
    }

    fn unreachable_runner() -> FakeRunner {
        FakeRunner::new()
            .on("bkt", &["api", PIPELINES_PATH], ok(&building("b")))
            .on(
                "kubectl",
                &["-n"],
                Ok(CommandOutput {
                    status: Some(1),
                    stdout: String::new(),
                    stderr: UNREACHABLE.to_string(),
                }),
            )
            .on("nmcli", &["connection", "up"], ok("Connection successfully activated"))
    }

    #[tokio::test]
    async fn the_vpn_is_tried_once_and_only_with_a_configured_name() {
        for name in [Some("wg0"), None, Some("   ")] {
            let f = Fixture::new();
            let sink = Arc::new(RecordingSink::default());
            let runner = Arc::new(unreachable_runner());
            let tracker = f.tracker(runner.clone(), &sink, name);
            tracker.tick(at(0)).await;
            push(&f.repo, "b");
            let mut polled_at = Vec::new();
            for second in (3..=120).step_by(3) {
                let before = cluster_polls(&runner);
                tracker.tick(at(second)).await;
                if cluster_polls(&runner) > before {
                    polled_at.push(second);
                }
            }
            let nmcli: Vec<_> =
                runner.calls().into_iter().filter(|(program, _)| program == "nmcli").collect();
            if name == Some("wg0") && vpn::supported() {
                assert_eq!(
                    nmcli,
                    vec![(
                        "nmcli".to_string(),
                        ["connection", "up", "id", "wg0"].map(str::to_string).to_vec()
                    )]
                );
                assert_eq!(polled_at, vec![3, 6, 66]);
            } else {
                assert!(nmcli.is_empty(), "{name:?}: {nmcli:?}");
                assert_eq!(polled_at, vec![3, 63], "{name:?}");
            }
            let tracking = f.only();
            assert_eq!(tracking.state, TrackingState::Building);
            assert_eq!(tracking.cluster_blocker, Some(Blocker::ClusterUnreachable));
            assert!(tracking.vpn_attempted);
            assert!(sink.kinds().is_empty());
        }
    }

    #[tokio::test]
    async fn disabling_the_flow_closes_its_open_tracking() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let ci = pipelines(vec![
            pipeline(&commit("b"), 7, running()),
            pipeline(&commit("c"), 8, running()),
        ]);
        let tracker = f.tracker(Arc::new(fake(&ci, "app:1")), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        tracker.tick(at(3)).await;
        assert!(f.only().is_open());

        let mut disabled = f.flow.clone();
        disabled.enabled = false;
        f.save_flow(&disabled);
        tracker.flows_changed();
        let announced = sink.changed_repos().len();
        tracker.tick(at(6)).await;
        let closed = f.only();
        assert_eq!(closed.state, TrackingState::Superseded);
        assert_eq!(closed.finished_at, Some(at(6)));
        assert_eq!(
            sink.changed_repos()[announced..].to_vec(),
            vec![Some(f.flow.repo_path.clone())]
        );

        f.save_flow(&f.flow);
        tracker.flows_changed();
        tracker.tick(at(9)).await;
        push(&f.repo, "c");
        tracker.tick(at(12)).await;
        assert!(f.trackings()[0].is_open());
        deploy_flows_repo::delete(&f.pool.get().unwrap(), &f.flow.repo_path).unwrap();
        tracker.flows_changed();
        tracker.tick(at(15)).await;
        let all = f.trackings();
        assert_eq!(all[0].commit, commit("c"));
        assert_eq!(all[0].state, TrackingState::Superseded);
        assert!(sink.kinds().is_empty());
    }

    #[tokio::test]
    async fn polls_respect_their_intervals() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let runner = Arc::new(fake(&building("b"), "app:1"));
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        let mut ci_at = Vec::new();
        let mut cluster_at = Vec::new();
        for second in (3..=63).step_by(3) {
            let (ci_before, cluster_before) = (ci_polls(&runner), cluster_polls(&runner));
            tracker.tick(at(second)).await;
            if ci_polls(&runner) > ci_before {
                ci_at.push(second);
            }
            if cluster_polls(&runner) > cluster_before {
                cluster_at.push(second);
            }
        }
        assert_eq!(ci_at, vec![3, 18, 33, 48, 63]);
        assert_eq!(cluster_at, vec![3, 15, 27, 39, 51, 63]);
        assert_eq!(f.only().state, TrackingState::Building);
    }

    #[tokio::test]
    async fn a_blocked_side_is_polled_slowly_and_the_other_side_keeps_its_pace() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let runner = Arc::new(
            FakeRunner::new()
                .on("bkt", &["api", PIPELINES_PATH], Err(RunError::NotFound))
                .on(
                    "kubectl",
                    &["-n", "cs-app-hs", "get", "deployments,statefulsets"],
                    ok(&workloads("app:1")),
                )
                .on("kubectl", &["-n", "cs-app-hs", "get", "pods"], ok(&pods())),
        );
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        let mut ci_at = Vec::new();
        let mut cluster_at = Vec::new();
        for second in (3..=66).step_by(3) {
            let (ci_before, cluster_before) = (ci_polls(&runner), cluster_polls(&runner));
            tracker.tick(at(second)).await;
            if ci_polls(&runner) > ci_before {
                ci_at.push(second);
            }
            if cluster_polls(&runner) > cluster_before {
                cluster_at.push(second);
            }
        }
        assert_eq!(ci_at, vec![3, 63]);
        assert_eq!(cluster_at, vec![3, 15, 27, 39, 51, 63]);
        let tracking = f.only();
        assert_eq!(tracking.state, TrackingState::WaitingForRun);
        assert!(matches!(tracking.ci_blocker, Some(Blocker::ToolUnavailable { ref tool, .. }) if tool == "bkt"));
    }

    #[tokio::test]
    async fn retry_makes_both_polls_due_at_once() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let runner = Arc::new(fake(&building("b"), "app:1"));
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        tracker.tick(at(3)).await;
        tracker.tick(at(6)).await;
        assert_eq!((ci_polls(&runner), cluster_polls(&runner)), (1, 1));

        tracker.retry(f.only().id);
        tracker.tick(at(9)).await;
        assert_eq!((ci_polls(&runner), cluster_polls(&runner)), (2, 2));
        tracker.tick(at(12)).await;
        assert_eq!((ci_polls(&runner), cluster_polls(&runner)), (2, 2));
    }

    struct GatedRunner {
        inner: FakeRunner,
        first: AtomicBool,
        entered: tokio::sync::Notify,
        gate: tokio::sync::Notify,
    }

    #[async_trait]
    impl CommandRunner for GatedRunner {
        async fn run(
            &self,
            program: &str,
            args: &[String],
            timeout: Duration,
        ) -> Result<CommandOutput, RunError> {
            if program == "bkt" && self.first.swap(false, Ordering::SeqCst) {
                self.entered.notify_one();
                self.gate.notified().await;
            }
            self.inner.run(program, args, timeout).await
        }
    }

    #[tokio::test]
    async fn a_slow_round_neither_blocks_the_next_push_nor_reopens_a_superseded_tracking() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let ci = pipelines(vec![
            pipeline(&commit("b"), 7, running()),
            pipeline(&commit("c"), 8, running()),
        ]);
        let runner = Arc::new(GatedRunner {
            inner: fake(&ci, "app:1"),
            first: AtomicBool::new(true),
            entered: tokio::sync::Notify::new(),
            gate: tokio::sync::Notify::new(),
        });
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        let slow = tokio::spawn({
            let tracker = tracker.clone();
            async move { tracker.tick(at(3)).await }
        });
        runner.entered.notified().await;
        let first = f.only();

        push(&f.repo, "c");
        tracker.tick(at(6)).await;
        let all = f.trackings();
        assert_eq!(all[0].commit, commit("c"));
        assert_eq!(all[0].state, TrackingState::Building);
        assert_eq!(all[1].id, first.id);
        assert_eq!(all[1].state, TrackingState::Superseded);

        runner.gate.notify_one();
        slow.await.unwrap();
        let all = f.trackings();
        assert_eq!(all[1].state, TrackingState::Superseded);
        assert_eq!(all[1].finished_at, Some(at(6)));
        assert_eq!(all[0].state, TrackingState::Building);
    }

    #[tokio::test]
    async fn without_a_runner_pushes_are_recorded_but_nothing_is_observed_or_timed_out() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let tracker = Arc::new(DeployTracker::new(f.pool.clone(), sink.clone(), Box::new(|| None)));
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        tracker.tick(at(3)).await;
        tracker.tick(at(3 + 900)).await;
        let waiting = f.only();
        assert_eq!(waiting.state, TrackingState::WaitingForRun);
        assert!(sink.kinds().is_empty());

        let runner = Arc::new(fake(&building("b"), "app:1"));
        assert!(tracker.runner.set(runner.clone()).is_ok());
        tracker.tick(at(3 + 903)).await;
        assert_eq!(f.only().state, TrackingState::Building);
        assert_eq!((ci_polls(&runner), cluster_polls(&runner)), (1, 1));
    }
}

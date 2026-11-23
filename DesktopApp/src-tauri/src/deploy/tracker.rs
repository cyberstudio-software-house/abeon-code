use crate::db::{deploy_flows_repo, deploy_trackings_repo, settings_repo, DbPool};
use crate::deploy::ci::{self, CiRun, CiStatus};
use crate::deploy::cluster;
use crate::deploy::excerpt::tail_redacted;
use crate::deploy::machine::{self, Effect, NotifyKind, Observation};
use crate::deploy::reflog::PushDetector;
use crate::deploy::runner::{shell_runner, CommandRunner, SystemRunner};
use crate::deploy::{
    notify, vpn, BLOCKED_POLL, BUILD_POLL, CLUSTER_POLL, DEPLOY_CHANGED_EVENT, IDLE_CLUSTER_POLL,
    LOG_EXCERPT_LINES, PAUSED_POLL, PUSH_POLL, TRACKING_HISTORY, VPN_SETTING_KEY,
};
use crate::domain::deploy::{
    BuildProvider, Delivery, DeployChangedEvent, DeployFlow, Tracking, TrackingState,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use futures_util::future::join_all;
use parking_lot::Mutex;
use rusqlite::{Connection, TransactionBehavior};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

const RUNNER_BUILD_LIMIT: Duration = Duration::from_secs(20);

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
    schedule: HashMap<i64, Schedule>,
    in_flight: HashSet<i64>,
    forced: HashSet<i64>,
    vpn_reset: HashSet<i64>,
}

#[derive(Default)]
struct Pushes {
    detector: PushDetector,
    pending: BTreeMap<String, String>,
}

#[derive(Default)]
struct ErrorLog {
    last: Mutex<HashMap<String, String>>,
}

impl ErrorLog {
    fn record<T>(&self, key: &str, result: AppResult<T>) -> Option<T> {
        match result {
            Ok(value) => {
                self.last.lock().remove(key);
                Some(value)
            }
            Err(error) => {
                if self.is_new(key, &error.to_string()) {
                    eprintln!("deploy: {key} failed: {error}");
                }
                None
            }
        }
    }

    fn is_new(&self, key: &str, message: &str) -> bool {
        let mut last = self.last.lock();
        if last.get(key).map(String::as_str) == Some(message) {
            return false;
        }
        last.insert(key.to_string(), message.to_string());
        true
    }
}

pub struct DeployTracker {
    db: DbPool,
    runner: OnceLock<Arc<dyn CommandRunner>>,
    sink: Arc<dyn TrackerSink>,
    vpn_name: VpnName,
    pushes: Mutex<Pushes>,
    ledger: Arc<Mutex<Ledger>>,
    errors: ErrorLog,
    wake: Notify,
}

struct Selection {
    tracking: Tracking,
    flow: DeployFlow,
    ci: bool,
    cluster: bool,
    reset_vpn: bool,
}

struct InFlight {
    ledger: Arc<Mutex<Ledger>>,
    id: i64,
}

impl Drop for InFlight {
    fn drop(&mut self) {
        self.ledger.lock().in_flight.remove(&self.id);
    }
}

struct Round {
    selection: Selection,
    runner: Arc<dyn CommandRunner>,
    guard: InFlight,
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
            pushes: Mutex::new(Pushes::default()),
            ledger: Arc::new(Mutex::new(Ledger::default())),
            errors: ErrorLog::default(),
            wake: Notify::new(),
        }
    }

    pub fn start(app: AppHandle, db: DbPool) -> Arc<DeployTracker> {
        let settings = db.clone();
        let sink = Arc::new(AppSink { app: app.clone() });
        let tracker = Arc::new(Self::new(db, sink, Box::new(move || read_vpn_name(&settings))));
        let ready = tracker.clone();
        tauri::async_runtime::spawn(async move {
            let runner = blocking_or(
                RUNNER_BUILD_LIMIT,
                move || shell_runner(&app.state::<AppState>()),
                || {
                    eprintln!("deploy: the shell environment did not load, using the app environment");
                    SystemRunner::new(std::env::vars().collect())
                },
            )
            .await;
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
        let rounds = self.prepare(now);
        join_all(rounds.into_iter().map(|round| self.run(round, now))).await;
    }

    pub fn retry(&self, tracking_id: i64) {
        {
            let mut ledger = self.ledger.lock();
            ledger.forced.insert(tracking_id);
            ledger.vpn_reset.insert(tracking_id);
        }
        self.wake.notify_one();
    }

    pub fn flows_changed(&self) {
        {
            let mut ledger = self.ledger.lock();
            let known: Vec<i64> =
                ledger.schedule.keys().chain(ledger.in_flight.iter()).copied().collect();
            ledger.forced.extend(known);
        }
        self.wake.notify_one();
    }

    fn prepare(&self, now: i64) -> Vec<Round> {
        let Some(mut pushes) = self.pushes.try_lock() else { return Vec::new() };
        let mut changed = BTreeSet::new();
        let refreshed = self.refresh(&mut pushes, now, &mut changed);
        let state = self.errors.record("reading the deployment state", refreshed);
        for repo in &changed {
            self.sink.changed(Some(repo));
        }
        match (state, self.runner.get()) {
            (Some((flows, open)), Some(runner)) => self.select(&flows, open, runner, now),
            _ => Vec::new(),
        }
    }

    fn refresh(
        &self,
        pushes: &mut Pushes,
        now: i64,
        changed: &mut BTreeSet<String>,
    ) -> AppResult<(Vec<DeployFlow>, Vec<Tracking>)> {
        let mut conn = self.db.get()?;
        let enabled = deploy_flows_repo::list_enabled(&conn)?;
        for (flow, push) in pushes.detector.poll(&enabled) {
            pushes.pending.insert(flow.repo_path, push.commit);
        }
        let flows: Vec<DeployFlow> = enabled.into_iter().filter(tracks_anything).collect();
        pushes.pending.retain(|repo, _| flow_of(&flows, repo).is_some());
        let pending: Vec<(String, String)> =
            pushes.pending.iter().map(|(repo, commit)| (repo.clone(), commit.clone())).collect();
        for (repo, commit) in pending {
            let Some(flow) = flow_of(&flows, &repo) else { continue };
            let started = start_tracking(&mut conn, flow, &commit, now);
            if self.errors.record(&format!("starting a tracking for {repo}"), started).is_some() {
                pushes.pending.remove(&repo);
                changed.insert(repo);
            }
        }
        let mut open = deploy_trackings_repo::open(&conn)?;
        if open.iter().any(|tracking| flow_of(&flows, &tracking.repo_path).is_none()) {
            let closed = close_orphans(&mut conn, &flows, now);
            changed.extend(self.errors.record("closing trackings without a flow", closed).unwrap_or_default());
            open = deploy_trackings_repo::open(&conn)?;
        }
        if !changed.is_empty() {
            let pruned = deploy_trackings_repo::prune(&conn, TRACKING_HISTORY);
            self.errors.record("pruning trackings", pruned);
        }
        Ok((flows, open))
    }

    fn select(
        &self,
        flows: &[DeployFlow],
        open: Vec<Tracking>,
        runner: &Arc<dyn CommandRunner>,
        now: i64,
    ) -> Vec<Round> {
        let mut rounds = Vec::new();
        let mut ledger = self.ledger.lock();
        let open_ids: HashSet<i64> = open.iter().map(|tracking| tracking.id).collect();
        ledger.schedule.retain(|id, _| open_ids.contains(id));
        ledger.forced.retain(|id| open_ids.contains(id));
        ledger.vpn_reset.retain(|id| open_ids.contains(id));
        for tracking in open {
            let Some(flow) = flow_of(flows, &tracking.repo_path) else { continue };
            if ledger.in_flight.contains(&tracking.id) {
                continue;
            }
            let forced = ledger.forced.remove(&tracking.id);
            let reset_vpn = ledger.vpn_reset.remove(&tracking.id);
            let due = ledger.schedule.get(&tracking.id).copied();
            let needs = machine::needs(&tracking, flow);
            ledger.in_flight.insert(tracking.id);
            rounds.push(Round {
                guard: InFlight { ledger: self.ledger.clone(), id: tracking.id },
                runner: runner.clone(),
                selection: Selection {
                    ci: needs.ci && (forced || due.is_none_or(|due| due.next_ci <= now)),
                    cluster: needs.cluster
                        && (forced || due.is_none_or(|due| due.next_cluster <= now)),
                    reset_vpn,
                    flow: flow.clone(),
                    tracking,
                },
            });
        }
        rounds
    }

    async fn run(&self, round: Round, now: i64) {
        let Round { selection, runner, guard: _guard } = round;
        let outcome = self.observe(runner.as_ref(), &selection, now).await;
        self.reschedule(&selection, &outcome, now);
        if outcome.tracking == selection.tracking {
            return;
        }
        let key = format!("saving tracking {}", outcome.tracking.id);
        if !self.errors.record(&key, self.save(&outcome.tracking)).unwrap_or(false) {
            return;
        }
        for kind in &outcome.notices {
            self.sink.notify(*kind, &outcome.tracking, &selection.flow);
        }
        self.sink.changed(Some(&outcome.tracking.repo_path));
    }

    async fn observe(&self, runner: &dyn CommandRunner, selection: &Selection, now: i64) -> Outcome {
        let Selection { tracking: original, flow, ci, cluster, reset_vpn } = selection;
        let new_pods_since = original.build_finished_at.unwrap_or(original.started_at);
        let (ci_observation, cluster_observation) = tokio::join!(
            async {
                if *ci {
                    Some(ci::observe(runner, flow, &original.commit, original.run_id.as_deref()).await)
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
        if *reset_vpn {
            tracking.vpn_attempted = false;
        }
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
                let excerpt = match failed_run(&outcome.tracking) {
                    Some(run) => ci::failure_log(runner, flow, &run).await,
                    None => None,
                };
                attach_excerpt(&mut outcome.tracking, excerpt);
            }
            Effect::FetchPodLog { pod } => {
                let excerpt = cluster::pod_log(runner, flow, &pod)
                    .await
                    .map(|log| tail_redacted(&log, LOG_EXCERPT_LINES));
                attach_excerpt(&mut outcome.tracking, excerpt);
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
                outcome.tracking.vpn_attempted = true;
            }
        }
    }

    fn reschedule(&self, selection: &Selection, outcome: &Outcome, now: i64) {
        let tracking = &outcome.tracking;
        let blocked = machine::blocked(tracking);
        let mut ledger = self.ledger.lock();
        let schedule = ledger
            .schedule
            .entry(selection.tracking.id)
            .or_insert(Schedule { next_ci: now, next_cluster: now });
        if selection.ci {
            schedule.next_ci = now + millis(ci_interval(tracking, blocked.ci));
        }
        if selection.cluster {
            schedule.next_cluster = match (outcome.vpn_tried, blocked.cluster) {
                (true, _) => now,
                (false, true) => now + millis(BLOCKED_POLL),
                (false, false) => now + millis(cluster_interval(tracking)),
            };
        } else if tracking.state == TrackingState::Delivering
            && selection.tracking.state != TrackingState::Delivering
        {
            schedule.next_cluster = schedule.next_cluster.min(now + millis(CLUSTER_POLL));
        }
    }

    fn save(&self, tracking: &Tracking) -> AppResult<bool> {
        let conn = self.db.get()?;
        if !deploy_trackings_repo::update_open(&conn, tracking)? {
            return Ok(false);
        }
        let pruned = deploy_trackings_repo::prune(&conn, TRACKING_HISTORY);
        self.errors.record("pruning trackings", pruned);
        Ok(true)
    }
}

fn flow_of<'a>(flows: &'a [DeployFlow], repo_path: &str) -> Option<&'a DeployFlow> {
    flows.iter().find(|flow| flow.repo_path == repo_path)
}

fn ci_interval(tracking: &Tracking, blocked: bool) -> Duration {
    if blocked {
        BLOCKED_POLL
    } else if tracking.state == TrackingState::Paused {
        PAUSED_POLL
    } else {
        BUILD_POLL
    }
}

fn cluster_interval(tracking: &Tracking) -> Duration {
    if tracking.state != TrackingState::Delivering && tracking.baseline_images.is_some() {
        IDLE_CLUSTER_POLL
    } else {
        CLUSTER_POLL
    }
}

fn tracks_anything(flow: &DeployFlow) -> bool {
    flow.build != BuildProvider::None || flow.delivery != Delivery::None
}

fn start_tracking(conn: &mut Connection, flow: &DeployFlow, commit: &str, now: i64) -> AppResult<()> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for open in deploy_trackings_repo::open(&tx)? {
        if open.repo_path == flow.repo_path {
            deploy_trackings_repo::update(&tx, &machine::supersede(&open, now))?;
        }
    }
    deploy_trackings_repo::insert(&tx, &Tracking::new(flow, commit, now))?;
    tx.commit()?;
    Ok(())
}

fn close_orphans(conn: &mut Connection, flows: &[DeployFlow], now: i64) -> AppResult<Vec<String>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut closed = Vec::new();
    for tracking in deploy_trackings_repo::open(&tx)? {
        if flow_of(flows, &tracking.repo_path).is_none() {
            deploy_trackings_repo::update(&tx, &machine::supersede(&tracking, now))?;
            closed.push(tracking.repo_path);
        }
    }
    tx.commit()?;
    Ok(closed)
}

fn failed_run(tracking: &Tracking) -> Option<CiRun> {
    Some(CiRun {
        id: tracking.run_id.clone()?,
        build_number: tracking.build_number,
        url: tracking.run_url.clone().unwrap_or_default(),
        status: CiStatus::Failed,
        finished_at: None,
    })
}

fn attach_excerpt(tracking: &mut Tracking, excerpt: Option<String>) {
    let Some(failure) = tracking.failure.as_mut() else { return };
    if let Some(excerpt) = excerpt.filter(|excerpt| !excerpt.trim().is_empty()) {
        failure.log_excerpt = Some(excerpt);
    }
}

async fn blocking_or<T: Send + 'static>(
    limit: Duration,
    work: impl FnOnce() -> T + Send + 'static,
    fallback: impl FnOnce() -> T,
) -> T {
    match tokio::time::timeout(limit, tokio::task::spawn_blocking(work)).await {
        Ok(Ok(value)) => value,
        _ => fallback(),
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
            let now = now_millis();
            let preparing = tracker.clone();
            let prepared = tokio::task::spawn_blocking(move || preparing.prepare(now))
                .await
                .map_err(|error| AppError::Other(error.to_string()));
            for round in tracker.errors.record("preparing a tick", prepared).unwrap_or_default() {
                let current = tracker.clone();
                tauri::async_runtime::spawn(async move { current.run(round, now).await });
            }
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
        notify::announce(&self.app, kind, tracking, flow);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_pool;
    use crate::deploy::runner::{ok, CommandOutput, FakeRunner, RunError};
    use crate::deploy::test_support::{conn, push, repo_with_push, TestConn};
    use crate::domain::deploy::{Blocker, BuildProvider, Delivery, TrackingState};
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

    fn with_runs(runner: FakeRunner, ci: &str) -> FakeRunner {
        let body: Value = serde_json::from_str(ci).unwrap();
        body["values"].as_array().unwrap().iter().fold(runner, |runner, entry| {
            let path = format!("{PIPELINES_PATH}{}", entry["uuid"].as_str().unwrap());
            runner.on("bkt", &["api", path.as_str()], ok(&entry.to_string()))
        })
    }

    fn fake(ci: &str, image: &str) -> FakeRunner {
        let runner = FakeRunner::new()
            .on("bkt", &["api", PIPELINES_PATH], ok(ci))
            .on(
                "kubectl",
                &["-n", "cs-app-hs", "get", "deployments,statefulsets"],
                ok(&workloads(image)),
            )
            .on("kubectl", &["-n", "cs-app-hs", "get", "pods"], ok(&pods()));
        with_runs(runner, ci)
    }

    fn ci_polls(runner: &FakeRunner) -> usize {
        runner
            .calls()
            .iter()
            .filter(|(program, args)| {
                program == "bkt"
                    && args.get(1).is_some_and(|path| {
                        path.starts_with(PIPELINES_PATH) && !path.ends_with("/steps/")
                    })
            })
            .count()
    }

    fn list_polls(runner: &FakeRunner) -> usize {
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
        let runner = FakeRunner::new()
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
            .on("nmcli", &["connection", "up"], ok("Connection successfully activated"));
        with_runs(runner, &building("b"))
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
            assert_eq!(tracking.vpn_attempted, name == Some("wg0") && vpn::supported(), "{name:?}");
            assert!(sink.kinds().is_empty());
        }
    }

    struct SwitchRunner {
        first: FakeRunner,
        second: FakeRunner,
        switched: AtomicBool,
    }

    impl SwitchRunner {
        fn between(first: FakeRunner, second: FakeRunner) -> Self {
            SwitchRunner { first, second, switched: AtomicBool::new(false) }
        }

        fn new() -> Self {
            Self::between(unreachable_runner(), fake(&building("b"), "app:1"))
        }

        fn switch(&self, second: bool) {
            self.switched.store(second, Ordering::SeqCst);
        }

        fn calls(&self) -> Vec<(String, Vec<String>)> {
            let mut calls = self.first.calls();
            calls.extend(self.second.calls());
            calls
        }

        fn vpn_attempts(&self) -> usize {
            self.calls().iter().filter(|(program, _)| program == "nmcli").count()
        }
    }

    #[async_trait]
    impl CommandRunner for SwitchRunner {
        async fn run(
            &self,
            program: &str,
            args: &[String],
            timeout: Duration,
        ) -> Result<CommandOutput, RunError> {
            if self.switched.load(Ordering::SeqCst) {
                self.second.run(program, args, timeout).await
            } else {
                self.first.run(program, args, timeout).await
            }
        }
    }

    fn attempts(count: usize) -> usize {
        if vpn::supported() {
            count
        } else {
            0
        }
    }

    #[tokio::test]
    async fn the_vpn_is_tried_again_after_the_cluster_came_back_and_dropped_again() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let runner = Arc::new(SwitchRunner::new());
        let tracker = f.tracker(runner.clone(), &sink, Some("wg0"));
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        tracker.tick(at(3)).await;
        tracker.tick(at(6)).await;
        assert_eq!(runner.vpn_attempts(), attempts(1));
        assert_eq!(f.only().vpn_attempted, vpn::supported());

        runner.switch(true);
        tracker.tick(at(66)).await;
        let back = f.only();
        assert_eq!(back.cluster_blocker, None);
        assert!(!back.vpn_attempted);

        runner.switch(false);
        tracker.tick(at(126)).await;
        assert_eq!(runner.vpn_attempts(), attempts(2));
        assert_eq!(f.only().cluster_blocker, Some(Blocker::ClusterUnreachable));
    }

    #[tokio::test]
    async fn a_vpn_name_set_after_the_first_unreachable_poll_is_used_on_the_next_one() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let runner = Arc::new(unreachable_runner());
        let name: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let configured = name.clone();
        let tracker = DeployTracker::with_parts(f.pool.clone(), runner.clone(), sink.clone(), move || {
            configured.lock().clone()
        });
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        tracker.tick(at(3)).await;
        assert!(!f.only().vpn_attempted);
        assert!(runner.calls().iter().all(|(program, _)| program != "nmcli"));

        *name.lock() = Some("wg0".to_string());
        tracker.tick(at(63)).await;
        let nmcli = runner.calls().iter().filter(|(program, _)| program == "nmcli").count();
        assert_eq!(nmcli, attempts(1));
        assert_eq!(f.only().vpn_attempted, vpn::supported());
    }

    #[tokio::test]
    async fn retry_clears_the_vpn_attempt_so_the_next_poll_tries_again() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let runner = Arc::new(unreachable_runner());
        let tracker = f.tracker(runner.clone(), &sink, Some("wg0"));
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        tracker.tick(at(3)).await;
        tracker.tick(at(6)).await;
        let nmcli = || runner.calls().iter().filter(|(program, _)| program == "nmcli").count();
        assert_eq!(nmcli(), attempts(1));

        tracker.retry(f.only().id);
        tracker.tick(at(9)).await;
        assert_eq!(nmcli(), attempts(2));
        assert_eq!(f.only().vpn_attempted, vpn::supported());
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
        assert_eq!(cluster_at, vec![3, 63]);
        assert_eq!(list_polls(&runner), 1);
        assert_eq!(f.only().state, TrackingState::Building);
    }

    async fn ticks_until(
        tracker: &Arc<DeployTracker>,
        counts: impl Fn() -> (usize, usize),
        last: i64,
        mut before_tick: impl FnMut(i64),
    ) -> (Vec<i64>, Vec<i64>) {
        let mut ci_at = Vec::new();
        let mut cluster_at = Vec::new();
        for second in (3..=last).step_by(3) {
            before_tick(second);
            let (ci_before, cluster_before) = counts();
            tracker.tick(at(second)).await;
            let (ci_after, cluster_after) = counts();
            if ci_after > ci_before {
                ci_at.push(second);
            }
            if cluster_after > cluster_before {
                cluster_at.push(second);
            }
        }
        (ci_at, cluster_at)
    }

    #[tokio::test]
    async fn a_paused_run_is_polled_once_a_minute_and_queried_directly() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let paused = json!({ "name": "IN_PROGRESS", "stage": { "name": "PAUSED" } });
        let runner = Arc::new(fake(&pipelines(vec![pipeline(&commit("b"), 7, paused)]), "app:1"));
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        let counts = || (ci_polls(&runner), cluster_polls(&runner));
        let (ci_at, cluster_at) = ticks_until(&tracker, counts, 126, |_| {}).await;
        assert_eq!(ci_at, vec![3, 63, 123]);
        assert_eq!(cluster_at, vec![3, 63, 123]);
        assert_eq!(list_polls(&runner), 1);
        let direct = format!("{PIPELINES_PATH}{{run-7}}");
        assert!(runner.calls().iter().any(|(_, args)| args.get(1) == Some(&direct)));
        assert_eq!(f.only().state, TrackingState::Paused);
        assert_eq!(sink.kinds(), vec![NotifyKind::Paused]);
    }

    #[tokio::test]
    async fn delivery_polls_the_cluster_every_ten_seconds_from_the_moment_it_starts() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let succeeded = pipelines(vec![pipeline(&commit("b"), 7, completed("SUCCESSFUL"))]);
        let runner = Arc::new(SwitchRunner::between(
            fake(&building("b"), "app:1"),
            fake(&succeeded, "app:1"),
        ));
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        let count = |calls: &[(String, Vec<String>)], cluster: bool| {
            calls
                .iter()
                .filter(|(program, args)| {
                    if cluster {
                        program == "kubectl" && args.iter().any(|arg| arg == "deployments,statefulsets")
                    } else {
                        program == "bkt" && args.get(1).is_some_and(|path| path.starts_with(PIPELINES_PATH))
                    }
                })
                .count()
        };
        let counts = || {
            let calls = runner.calls();
            (count(&calls, false), count(&calls, true))
        };
        let (ci_at, cluster_at) = ticks_until(&tracker, counts, 45, |second| {
            if second == 18 {
                runner.switch(true);
            }
        })
        .await;
        assert_eq!(ci_at, vec![3, 18]);
        assert_eq!(cluster_at, vec![3, 30, 42]);
        assert_eq!(f.only().state, TrackingState::Delivering);
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
        assert_eq!(cluster_at, vec![3, 63]);
        let tracking = f.only();
        assert_eq!(tracking.state, TrackingState::WaitingForRun);
        assert!(matches!(tracking.ci_blocker, Some(Blocker::ToolUnavailable { ref tool, .. }) if tool == "bkt"));

        let f = Fixture::new();
        let runner = Arc::new(with_runs(
            FakeRunner::new()
                .on("bkt", &["api", PIPELINES_PATH], ok(&building("b")))
                .on("kubectl", &["-n"], Err(RunError::NotFound)),
            &building("b"),
        ));
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        let counts = || (ci_polls(&runner), cluster_polls(&runner));
        let (ci_at, cluster_at) = ticks_until(&tracker, counts, 66, |_| {}).await;
        assert_eq!(ci_at, vec![3, 18, 33, 48, 63]);
        assert_eq!(cluster_at, vec![3, 63]);
        assert!(matches!(f.only().cluster_blocker, Some(Blocker::ToolUnavailable { ref tool, .. }) if tool == "kubectl"));
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

    impl GatedRunner {
        fn new(inner: FakeRunner) -> Self {
            GatedRunner {
                inner,
                first: AtomicBool::new(true),
                entered: tokio::sync::Notify::new(),
                gate: tokio::sync::Notify::new(),
            }
        }
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

    fn flow_without_stages(flow: &DeployFlow) -> DeployFlow {
        let mut idle = flow.clone();
        idle.build = BuildProvider::None;
        idle.delivery = Delivery::None;
        idle
    }

    #[tokio::test]
    async fn a_flow_with_neither_build_nor_delivery_starts_no_tracking() {
        let f = Fixture::new();
        f.save_flow(&flow_without_stages(&f.flow));
        let sink = Arc::new(RecordingSink::default());
        let runner = Arc::new(fake(&building("c"), "app:1"));
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        for second in (3..=1200).step_by(3) {
            tracker.tick(at(second)).await;
        }
        assert!(f.trackings().is_empty());
        assert!(sink.changed_repos().is_empty());
        assert!(sink.kinds().is_empty());
        assert!(runner.calls().is_empty());

        f.save_flow(&f.flow);
        tracker.tick(at(1203)).await;
        assert!(f.trackings().is_empty());
        push(&f.repo, "c");
        tracker.tick(at(1206)).await;
        assert_eq!(f.only().commit, commit("c"));
        assert!(f.only().is_open());

        f.save_flow(&flow_without_stages(&f.flow));
        tracker.tick(at(1209)).await;
        let closed = f.only();
        assert_eq!(closed.state, TrackingState::Superseded);
        assert_eq!(closed.finished_at, Some(at(1209)));
        for second in (1212..=2400).step_by(3) {
            tracker.tick(at(second)).await;
        }
        assert!(sink.kinds().is_empty());
    }

    #[tokio::test]
    async fn a_tick_is_skipped_while_another_one_is_preparing() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let runner = Arc::new(fake(&building("b"), "app:1"));
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");

        let preparing = tracker.pushes.lock();
        tracker.tick(at(3)).await;
        drop(preparing);
        assert!(f.trackings().is_empty());
        assert!(runner.calls().is_empty());

        tracker.tick(at(6)).await;
        assert_eq!(f.only().commit, commit("b"));
        assert_eq!((ci_polls(&runner), cluster_polls(&runner)), (1, 1));
    }

    #[tokio::test]
    async fn a_fast_round_announces_its_change_without_waiting_for_a_slow_one() {
        let f = Fixture::new();
        let (other_repo, mut other) = repo_with_push("a");
        other.build = BuildProvider::None;
        f.save_flow(&other);
        let sink = Arc::new(RecordingSink::default());
        let runner = Arc::new(GatedRunner::new(fake(&building("b"), "app:1")));
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        push(&other_repo, "b");
        let slow = tokio::spawn({
            let tracker = tracker.clone();
            async move { tracker.tick(at(3)).await }
        });
        runner.entered.notified().await;
        let fast = Some(other.repo_path.clone());
        let announced = || sink.changed_repos().iter().filter(|repo| **repo == fast).count();
        for _ in 0..1000 {
            if announced() >= 2 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert_eq!(announced(), 2);
        assert!(!slow.is_finished());

        runner.gate.notify_one();
        slow.await.unwrap();
        assert_eq!(f.only().state, TrackingState::Building);
    }

    #[tokio::test]
    async fn a_shell_environment_that_hangs_falls_back_to_the_process_environment() {
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let hung = blocking_or(Duration::ZERO, move || {
            let _ = wait.recv();
            "shell"
        }, || "process")
        .await;
        assert_eq!(hung, "process");
        release.send(()).unwrap();
        assert_eq!(blocking_or(RUNNER_BUILD_LIMIT, || "shell", || "process").await, "shell");
    }

    #[tokio::test]
    async fn a_failed_insert_leaves_the_old_tracking_open_and_is_retried() {
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
        let first = f.only();

        f.pool
            .get()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER refuse_insert BEFORE INSERT ON deploy_trackings
                 BEGIN SELECT RAISE(ABORT, 'refused'); END;",
            )
            .unwrap();
        push(&f.repo, "c");
        tracker.tick(at(6)).await;
        tracker.tick(at(9)).await;
        let still = f.only();
        assert_eq!(still.id, first.id);
        assert_eq!(still.state, TrackingState::Building);
        assert_eq!(still.finished_at, None);

        f.pool.get().unwrap().execute_batch("DROP TRIGGER refuse_insert;").unwrap();
        tracker.tick(at(12)).await;
        let all = f.trackings();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].commit, commit("c"));
        assert!(all[0].is_open());
        assert_eq!(all[0].started_at, at(12));
        assert_eq!(all[1].id, first.id);
        assert_eq!(all[1].state, TrackingState::Superseded);
    }

    #[tokio::test]
    async fn a_flow_change_makes_every_open_tracking_due_at_once() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let runner = Arc::new(fake(&building("b"), "app:1"));
        let tracker = f.tracker(runner.clone(), &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        tracker.tick(at(3)).await;
        tracker.tick(at(6)).await;
        assert_eq!((ci_polls(&runner), cluster_polls(&runner)), (1, 1));

        tracker.flows_changed();
        tracker.tick(at(9)).await;
        assert_eq!((ci_polls(&runner), cluster_polls(&runner)), (2, 2));
        tracker.tick(at(12)).await;
        assert_eq!((ci_polls(&runner), cluster_polls(&runner)), (2, 2));
    }

    #[tokio::test]
    async fn the_build_log_excerpt_keeps_the_last_sixty_lines() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let mut log: Vec<String> = (1..=100).map(|line| format!("line {line}")).collect();
        log[95] = "API_TOKEN=abc".to_string();
        let failed = pipelines(vec![pipeline(&commit("b"), 7, completed("FAILED"))]);
        let runner = Arc::new(
            FakeRunner::new()
                .on("bkt", &["api", STEPS_PATH], ok(STEPS))
                .on("bkt", &["pipeline", "logs"], ok(&log.join("\n")))
                .on("bkt", &["api", PIPELINES_PATH], ok(&failed))
                .on("kubectl", &["-n"], ok(&workloads("app:1"))),
        );
        let tracker = f.tracker(runner, &sink, None);
        tracker.tick(at(0)).await;
        push(&f.repo, "b");
        tracker.tick(at(3)).await;

        let excerpt = f.only().failure.and_then(|failure| failure.log_excerpt).unwrap();
        let lines: Vec<&str> = excerpt.lines().collect();
        assert_eq!(lines.len(), 60);
        assert_eq!(lines[0], "line 41");
        assert_eq!(lines[59], "line 100");
        assert!(lines.contains(&"API_TOKEN=***"));
    }

    #[test]
    fn an_error_is_printed_once_until_it_changes_or_clears() {
        let errors = ErrorLog::default();
        let fail = |message: &str| -> AppResult<()> {
            Err(crate::error::AppError::Other(message.to_string()))
        };
        assert!(errors.is_new("tick", "database is locked"));
        assert_eq!(errors.record("tick", fail("database is locked")), None);
        assert!(!errors.is_new("tick", "database is locked"));
        assert!(errors.is_new("tick", "disk I/O error"));
        assert!(errors.is_new("prune", "disk I/O error"));
        assert_eq!(errors.record("tick", Ok(7)), Some(7));
        assert!(errors.is_new("tick", "disk I/O error"));
    }

    #[test]
    fn the_run_rebuilt_for_the_build_log_carries_no_finish_time() {
        let mut tracking = Tracking::new(&crate::deploy::test_support::flow(), "abc", at(0));
        assert_eq!(failed_run(&tracking), None);
        tracking.run_id = Some("{run-7}".to_string());
        tracking.build_number = Some(7);
        tracking.run_url = Some("https://example.test/7".to_string());
        tracking.finished_at = Some(at(60));
        let run = failed_run(&tracking).unwrap();
        assert_eq!(run.id, "{run-7}");
        assert_eq!(run.build_number, Some(7));
        assert_eq!(run.status, CiStatus::Failed);
        assert_eq!(run.finished_at, None);
    }

    #[tokio::test]
    async fn a_slow_round_neither_blocks_the_next_push_nor_reopens_a_superseded_tracking() {
        let f = Fixture::new();
        let sink = Arc::new(RecordingSink::default());
        let ci = pipelines(vec![
            pipeline(&commit("b"), 7, running()),
            pipeline(&commit("c"), 8, running()),
        ]);
        let runner = Arc::new(GatedRunner::new(fake(&ci, "app:1")));
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

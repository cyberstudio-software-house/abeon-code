use crate::deploy::ci::{CiObservation, CiRun, CiStatus, ToolProblem};
use crate::deploy::cluster::{ClusterObservation, WorkloadState};
use crate::deploy::{PAUSE_LIMIT, ROLLOUT_LIMIT, RUN_APPEAR_LIMIT};
use crate::domain::deploy::{
    Blocker, Delivery, DeployFlow, Tracking, TrackingFailure, TrackingStage, TrackingState,
};
use std::collections::BTreeSet;
use std::time::Duration;

const BUILD_FAILED_REASON: &str = "Pipeline zakończył się błędem";

#[derive(Debug, Clone, PartialEq)]
pub enum Observation {
    Ci(CiObservation),
    Cluster(ClusterObservation),
    Tick,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotifyKind {
    Paused,
    Failed,
    Stalled,
    Succeeded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    Notify(NotifyKind),
    FetchBuildLog,
    FetchPodLog { pod: String },
    ConnectVpn,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub tracking: Tracking,
    pub effects: Vec<Effect>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Needs {
    pub ci: bool,
    pub cluster: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Blocked {
    pub ci: bool,
    pub cluster: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Side {
    Ci,
    Cluster,
}

pub fn blocked(tracking: &Tracking) -> Blocked {
    Blocked {
        ci: tracking.ci_blocker.is_some(),
        cluster: tracking.cluster_blocker.is_some(),
    }
}

pub fn needs(tracking: &Tracking, flow: &DeployFlow) -> Needs {
    Needs {
        ci: matches!(
            tracking.state,
            TrackingState::WaitingForRun | TrackingState::Building | TrackingState::Paused
        ),
        cluster: tracking.is_open() && flow.delivery != Delivery::None,
    }
}

pub fn supersede(tracking: &Tracking, now: i64) -> Tracking {
    let mut next = tracking.clone();
    if next.is_open() {
        close(&mut next, TrackingState::Superseded, now);
    }
    next
}

pub fn advance(tracking: &Tracking, flow: &DeployFlow, observation: Observation, now: i64) -> Step {
    let mut step = Step {
        tracking: tracking.clone(),
        effects: Vec::new(),
    };
    if !tracking.is_open() {
        return step;
    }
    match observation {
        Observation::Ci(ci) => observe_ci(&mut step, flow, ci, now),
        Observation::Cluster(cluster) => observe_cluster(&mut step, flow, cluster, now),
        Observation::Tick => {}
    }
    enforce_time_limit(&mut step, now);
    step
}

fn observe_ci(step: &mut Step, flow: &DeployFlow, observation: CiObservation, now: i64) {
    if !needs(&step.tracking, flow).ci {
        return;
    }
    match observation {
        CiObservation::Unavailable(problem) => {
            block(&mut step.tracking, Side::Ci, problem_blocker(problem))
        }
        CiObservation::NoRun => unblock(&mut step.tracking, Side::Ci, now),
        CiObservation::Run(run) => {
            unblock(&mut step.tracking, Side::Ci, now);
            follow_run(step, flow, run, now);
        }
    }
}

fn follow_run(step: &mut Step, flow: &DeployFlow, run: CiRun, now: i64) {
    let tracking = &mut step.tracking;
    tracking.run_id = Some(run.id);
    tracking.run_url = Some(run.url);
    tracking.build_number = run.build_number;
    match run.status {
        CiStatus::Running => tracking.state = TrackingState::Building,
        CiStatus::Paused => {
            if tracking.state != TrackingState::Paused {
                tracking.state = TrackingState::Paused;
                tracking.stage_started_at = now;
                step.effects.push(Effect::Notify(NotifyKind::Paused));
            }
        }
        CiStatus::Failed => {
            tracking.failure = Some(TrackingFailure {
                stage: TrackingStage::Build,
                reason: BUILD_FAILED_REASON.to_string(),
                log_excerpt: None,
            });
            close(tracking, TrackingState::Failed, now);
            step.effects.push(Effect::FetchBuildLog);
            step.effects.push(Effect::Notify(NotifyKind::Failed));
        }
        CiStatus::Succeeded => {
            tracking.build_finished_at = Some(run.finished_at.unwrap_or(now));
            if flow.delivery == Delivery::None {
                close(tracking, TrackingState::Succeeded, now);
                step.effects.push(Effect::Notify(NotifyKind::Succeeded));
            } else {
                tracking.state = TrackingState::Delivering;
                tracking.stage_started_at = now;
            }
        }
    }
}

fn observe_cluster(step: &mut Step, flow: &DeployFlow, observation: ClusterObservation, now: i64) {
    if !needs(&step.tracking, flow).cluster {
        return;
    }
    let tracking = &mut step.tracking;
    match observation {
        ClusterObservation::Unreachable => {
            block(tracking, Side::Cluster, Blocker::ClusterUnreachable);
            if !tracking.vpn_attempted {
                tracking.vpn_attempted = true;
                step.effects.push(Effect::ConnectVpn);
            }
        }
        ClusterObservation::Unavailable(problem) => {
            block(tracking, Side::Cluster, problem_blocker(problem))
        }
        ClusterObservation::Snapshot(workloads) => {
            unblock(tracking, Side::Cluster, now);
            let images = image_union(&workloads);
            if tracking.baseline_images.is_none() {
                tracking.baseline_images = Some(images.clone());
                tracking.baseline_at = Some(now);
            }
            tracking.current_images = images;
            if tracking.state == TrackingState::Delivering {
                judge_delivery(step, flow, &workloads, now);
            }
        }
    }
}

fn judge_delivery(step: &mut Step, flow: &DeployFlow, workloads: &[WorkloadState], now: i64) {
    let tracking = &mut step.tracking;
    if let Some(failure) = workloads
        .iter()
        .find_map(|workload| workload.failing.as_ref())
    {
        tracking.failure = Some(TrackingFailure {
            stage: TrackingStage::Delivery,
            reason: format!("{}: {}", failure.pod, failure.reason),
            log_excerpt: None,
        });
        close(tracking, TrackingState::Failed, now);
        step.effects.push(Effect::FetchPodLog {
            pod: failure.pod.clone(),
        });
        step.effects.push(Effect::Notify(NotifyKind::Failed));
    } else if delivered(tracking, flow, workloads) {
        close(tracking, TrackingState::Succeeded, now);
        step.effects.push(Effect::Notify(NotifyKind::Succeeded));
    }
}

fn delivered(tracking: &Tracking, flow: &DeployFlow, workloads: &[WorkloadState]) -> bool {
    let Some(build_finished_at) = tracking.build_finished_at else {
        return false;
    };
    if workloads.is_empty() {
        return false;
    }
    match flow.delivery {
        Delivery::Image => {
            let images_changed = tracking
                .baseline_images
                .as_ref()
                .is_some_and(|baseline| baseline != &tracking.current_images);
            let baseline_after_build = tracking
                .baseline_at
                .is_some_and(|baseline_at| baseline_at > build_finished_at);
            workloads.iter().all(|workload| workload.rollout_complete)
                && (images_changed
                    || (baseline_after_build && restarted_after(workloads, build_finished_at)))
        }
        Delivery::Kubemeter => restarted_after(workloads, build_finished_at),
        Delivery::None => false,
    }
}

fn restarted_after(workloads: &[WorkloadState], moment: i64) -> bool {
    let mut running = workloads
        .iter()
        .filter(|workload| workload.desired_replicas > 0)
        .peekable();
    running.peek().is_some()
        && running.all(|workload| {
            workload.pods_ready
                && workload
                    .oldest_pod_started_at
                    .is_some_and(|started_at| started_at > moment)
        })
}

fn image_union(workloads: &[WorkloadState]) -> Vec<String> {
    workloads
        .iter()
        .flat_map(|workload| workload.images.iter().cloned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn enforce_time_limit(step: &mut Step, now: i64) {
    let tracking = &mut step.tracking;
    if slot(tracking, owning_side(tracking.state)).is_some() {
        return;
    }
    let limit = match tracking.state {
        TrackingState::WaitingForRun => RUN_APPEAR_LIMIT,
        TrackingState::Paused => PAUSE_LIMIT,
        TrackingState::Delivering => ROLLOUT_LIMIT,
        _ => return,
    };
    if now - tracking.stage_started_at >= millis(limit) {
        close(tracking, TrackingState::Stalled, now);
        step.effects.push(Effect::Notify(NotifyKind::Stalled));
    }
}

fn problem_blocker(problem: ToolProblem) -> Blocker {
    Blocker::ToolUnavailable {
        tool: problem.tool,
        reason: problem.reason,
    }
}

fn slot(tracking: &mut Tracking, side: Side) -> &mut Option<Blocker> {
    match side {
        Side::Ci => &mut tracking.ci_blocker,
        Side::Cluster => &mut tracking.cluster_blocker,
    }
}

fn block(tracking: &mut Tracking, side: Side, blocker: Blocker) {
    *slot(tracking, side) = Some(blocker);
}

fn owning_side(state: TrackingState) -> Side {
    match state {
        TrackingState::Delivering => Side::Cluster,
        _ => Side::Ci,
    }
}

fn unblock(tracking: &mut Tracking, side: Side, now: i64) {
    if slot(tracking, side).take().is_some() && side == owning_side(tracking.state) {
        tracking.stage_started_at = now;
    }
}

fn close(tracking: &mut Tracking, state: TrackingState, now: i64) {
    tracking.state = state;
    tracking.ci_blocker = None;
    tracking.cluster_blocker = None;
    tracking.finished_at = Some(now);
}

fn millis(duration: Duration) -> i64 {
    duration.as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::cluster::PodFailure;
    use crate::deploy::test_support::flow;
    use crate::domain::deploy::BuildProvider;

    const BASE: i64 = 1_795_000_000_000;

    fn t(seconds: i64) -> i64 {
        BASE + seconds * 1000
    }

    fn run(status: CiStatus) -> CiRun {
        CiRun {
            id: "42".to_string(),
            build_number: Some(42),
            url: "https://bitbucket.org/cybercode/hr-management/pipelines/results/42".to_string(),
            status,
            finished_at: None,
        }
    }

    fn workload(images: &[&str], complete: bool, started_at: Option<i64>) -> WorkloadState {
        WorkloadState {
            name: "app".to_string(),
            images: images.iter().map(|image| image.to_string()).collect(),
            desired_replicas: 1,
            rollout_complete: complete,
            oldest_pod_started_at: started_at,
            pods_ready: complete,
            failing: None,
        }
    }

    fn scaled_down(name: &str) -> WorkloadState {
        WorkloadState {
            name: name.to_string(),
            images: vec!["worker:1".to_string()],
            desired_replicas: 0,
            rollout_complete: true,
            oldest_pod_started_at: None,
            pods_ready: true,
            failing: None,
        }
    }

    fn snapshot(images: &[&str], complete: bool) -> ClusterObservation {
        ClusterObservation::Snapshot(vec![workload(images, complete, Some(t(-3600)))])
    }

    fn step(tracking: Tracking, flow: &DeployFlow, observation: Observation, now: i64) -> Step {
        advance(&tracking, flow, observation, now)
    }

    fn ci(status: CiStatus) -> Observation {
        Observation::Ci(CiObservation::Run(run(status)))
    }

    fn cluster(observation: ClusterObservation) -> Observation {
        Observation::Cluster(observation)
    }

    fn kubectl_problem(reason: &str) -> ToolProblem {
        ToolProblem {
            tool: "kubectl".to_string(),
            reason: reason.to_string(),
        }
    }

    fn flow_delivering(delivery: Delivery) -> DeployFlow {
        let mut flow = flow();
        flow.delivery = delivery;
        flow
    }

    fn flow_building(build: BuildProvider) -> DeployFlow {
        let mut flow = flow();
        flow.build = build;
        flow
    }

    fn delivering(flow: &DeployFlow, build_done: i64) -> Tracking {
        let built = step(
            Tracking::new(flow, "abc", t(0)),
            flow,
            ci(CiStatus::Succeeded),
            build_done,
        );
        assert_eq!(built.tracking.state, TrackingState::Delivering);
        built.tracking
    }

    fn closed(state: TrackingState) -> Tracking {
        let mut tracking = Tracking::new(&flow(), "abc", t(0));
        tracking.state = state;
        tracking.finished_at = Some(t(100));
        tracking
    }

    #[test]
    fn a_new_tracking_starts_from_the_flow_and_the_commit() {
        let tracking = Tracking::new(&flow(), "abc", t(0));
        assert_eq!(tracking.id, 0);
        assert_eq!(tracking.repo_path, "/r/a");
        assert_eq!(tracking.branch, "master");
        assert_eq!(tracking.commit, "abc");
        assert_eq!(tracking.state, TrackingState::WaitingForRun);
        assert_eq!(tracking.started_at, t(0));
        assert_eq!(tracking.stage_started_at, t(0));
        assert_eq!(tracking.build_finished_at, None);
        assert_eq!(tracking.finished_at, None);
        assert_eq!(tracking.ci_blocker, None);
        assert_eq!(tracking.cluster_blocker, None);
        assert_eq!(tracking.baseline_images, None);
        assert!(tracking.current_images.is_empty());
        assert!(!tracking.vpn_attempted);
        assert!(!tracking.dismissed);
        assert!(tracking.is_open());
    }

    #[test]
    fn the_happy_image_path_ends_with_one_quiet_notification() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            Observation::Cluster(snapshot(&["app:1"], true)),
            t(1),
        );
        assert_eq!(s.tracking.baseline_images, Some(vec!["app:1".to_string()]));
        assert_eq!(s.tracking.baseline_at, Some(t(1)));
        s = step(
            s.tracking,
            &f,
            Observation::Ci(CiObservation::Run(run(CiStatus::Running))),
            t(15),
        );
        assert_eq!(s.tracking.state, TrackingState::Building);
        s = step(
            s.tracking,
            &f,
            Observation::Ci(CiObservation::Run(run(CiStatus::Succeeded))),
            t(300),
        );
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        assert_eq!(s.tracking.build_finished_at, Some(t(300)));
        assert_eq!(s.tracking.stage_started_at, t(300));
        assert!(s.effects.is_empty());
        s = step(
            s.tracking,
            &f,
            Observation::Cluster(snapshot(&["app:2"], false)),
            t(320),
        );
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        assert_eq!(s.tracking.current_images, vec!["app:2".to_string()]);
        assert_eq!(s.tracking.baseline_images, Some(vec!["app:1".to_string()]));
        s = step(
            s.tracking,
            &f,
            Observation::Cluster(snapshot(&["app:2"], true)),
            t(340),
        );
        assert_eq!(s.tracking.state, TrackingState::Succeeded);
        assert_eq!(s.tracking.finished_at, Some(t(340)));
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Succeeded)]);
    }

    #[test]
    fn a_run_records_its_id_link_and_number() {
        let f = flow();
        let s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            ci(CiStatus::Running),
            t(15),
        );
        assert_eq!(s.tracking.run_id.as_deref(), Some("42"));
        assert_eq!(
            s.tracking.run_url.as_deref(),
            Some("https://bitbucket.org/cybercode/hr-management/pipelines/results/42")
        );
        assert_eq!(s.tracking.build_number, Some(42));
    }

    #[test]
    fn the_build_end_comes_from_the_run_when_it_has_one() {
        let f = flow();
        let mut finished = run(CiStatus::Succeeded);
        finished.finished_at = Some(t(280));
        let s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            Observation::Ci(CiObservation::Run(finished)),
            t(300),
        );
        assert_eq!(s.tracking.build_finished_at, Some(t(280)));
        assert_eq!(s.tracking.stage_started_at, t(300));
    }

    #[test]
    fn the_union_of_workload_images_is_sorted_and_deduplicated() {
        let f = flow();
        let mut worker = workload(&["php:8", "app:1"], true, Some(t(-3600)));
        worker.name = "worker".to_string();
        let observation = ClusterObservation::Snapshot(vec![
            workload(&["nginx:1", "app:1"], true, Some(t(-3600))),
            worker,
        ]);
        let s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            cluster(observation),
            t(1),
        );
        let expected = vec![
            "app:1".to_string(),
            "nginx:1".to_string(),
            "php:8".to_string(),
        ];
        assert_eq!(s.tracking.baseline_images, Some(expected.clone()));
        assert_eq!(s.tracking.current_images, expected);
    }

    #[test]
    fn a_pause_notifies_once_and_resumes() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            ci(CiStatus::Running),
            t(15),
        );
        s = step(s.tracking, &f, ci(CiStatus::Paused), t(30));
        assert_eq!(s.tracking.state, TrackingState::Paused);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Paused)]);
        s = step(s.tracking, &f, ci(CiStatus::Paused), t(45));
        assert_eq!(s.tracking.state, TrackingState::Paused);
        assert!(s.effects.is_empty());
        s = step(s.tracking, &f, ci(CiStatus::Running), t(60));
        assert_eq!(s.tracking.state, TrackingState::Building);
        assert!(s.effects.is_empty());
    }

    #[test]
    fn a_second_pause_notifies_again() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            ci(CiStatus::Paused),
            t(15),
        );
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Paused)]);
        s = step(s.tracking, &f, ci(CiStatus::Running), t(30));
        assert_eq!(s.tracking.state, TrackingState::Building);
        s = step(s.tracking, &f, ci(CiStatus::Paused), t(45));
        assert_eq!(s.tracking.state, TrackingState::Paused);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Paused)]);
    }

    #[test]
    fn a_pause_is_kept_for_a_day_then_stalls() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            ci(CiStatus::Running),
            t(15),
        );
        s = step(s.tracking, &f, ci(CiStatus::Paused), t(600));
        s = step(s.tracking, &f, Observation::Tick, t(600 + 86_399));
        assert_eq!(s.tracking.state, TrackingState::Paused);
        assert!(s.effects.is_empty());
        s = step(s.tracking, &f, ci(CiStatus::Paused), t(600 + 86_401));
        assert_eq!(s.tracking.state, TrackingState::Stalled);
        assert_eq!(s.tracking.finished_at, Some(t(600 + 86_401)));
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Stalled)]);
    }

    #[test]
    fn a_running_build_has_no_time_limit() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            ci(CiStatus::Running),
            t(15),
        );
        s = step(s.tracking, &f, Observation::Tick, t(3 * 3600));
        assert_eq!(s.tracking.state, TrackingState::Building);
        assert!(s.effects.is_empty());
    }

    #[test]
    fn a_failed_build_asks_for_the_log_and_notifies() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            ci(CiStatus::Running),
            t(15),
        );
        s = step(s.tracking, &f, ci(CiStatus::Failed), t(200));
        assert_eq!(s.tracking.state, TrackingState::Failed);
        assert_eq!(
            s.effects,
            vec![Effect::FetchBuildLog, Effect::Notify(NotifyKind::Failed)]
        );
        assert_eq!(
            s.tracking.failure,
            Some(TrackingFailure {
                stage: TrackingStage::Build,
                reason: "Pipeline zakończył się błędem".to_string(),
                log_excerpt: None,
            })
        );
        assert_eq!(s.tracking.finished_at, Some(t(200)));
        assert_eq!(s.tracking.build_finished_at, None);
    }

    #[test]
    fn no_run_for_five_minutes_is_stalled_not_failed() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            Observation::Ci(CiObservation::NoRun),
            t(299),
        );
        assert_eq!(s.tracking.state, TrackingState::WaitingForRun);
        assert!(s.effects.is_empty());
        s = step(
            s.tracking,
            &f,
            Observation::Ci(CiObservation::NoRun),
            t(301),
        );
        assert_eq!(s.tracking.state, TrackingState::Stalled);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Stalled)]);
        assert_eq!(s.tracking.failure, None);
        assert_eq!(s.tracking.finished_at, Some(t(301)));
    }

    #[test]
    fn a_tick_alone_stalls_a_run_that_never_appears() {
        let f = flow();
        let s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            Observation::Tick,
            t(301),
        );
        assert_eq!(s.tracking.state, TrackingState::Stalled);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Stalled)]);
    }

    #[test]
    fn an_unavailable_ci_tool_holds_the_wait_for_the_run_and_restarts_it_when_it_recovers() {
        let f = flow();
        let problem = ToolProblem {
            tool: "bkt".to_string(),
            reason: "not logged in".to_string(),
        };
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            Observation::Ci(CiObservation::Unavailable(problem)),
            t(10),
        );
        assert_eq!(
            s.tracking.ci_blocker,
            Some(Blocker::ToolUnavailable {
                tool: "bkt".to_string(),
                reason: "not logged in".to_string()
            })
        );
        assert_eq!(s.tracking.cluster_blocker, None);
        assert_eq!(s.tracking.state, TrackingState::WaitingForRun);
        assert!(s.effects.is_empty());
        s = step(s.tracking, &f, Observation::Tick, t(900));
        assert_eq!(s.tracking.state, TrackingState::WaitingForRun);
        s = step(
            s.tracking,
            &f,
            Observation::Ci(CiObservation::NoRun),
            t(1000),
        );
        assert_eq!(s.tracking.ci_blocker, None);
        assert_eq!(s.tracking.stage_started_at, t(1000));
        s = step(s.tracking, &f, Observation::Tick, t(1000 + 299));
        assert_eq!(s.tracking.state, TrackingState::WaitingForRun);
        s = step(s.tracking, &f, Observation::Tick, t(1000 + 301));
        assert_eq!(s.tracking.state, TrackingState::Stalled);
    }

    #[test]
    fn a_blocker_on_one_side_is_not_cleared_by_the_other() {
        let f = flow();
        let problem = ToolProblem {
            tool: "bkt".to_string(),
            reason: "not logged in".to_string(),
        };
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            Observation::Ci(CiObservation::Unavailable(problem)),
            t(10),
        );
        s = step(s.tracking, &f, cluster(snapshot(&["app:1"], true)), t(20));
        assert_eq!(s.tracking.baseline_images, Some(vec!["app:1".to_string()]));
        assert!(
            matches!(s.tracking.ci_blocker, Some(Blocker::ToolUnavailable { ref tool, .. }) if tool == "bkt")
        );
        assert_eq!(s.tracking.cluster_blocker, None);

        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            cluster(ClusterObservation::Unreachable),
            t(10),
        );
        s = step(s.tracking, &f, Observation::Ci(CiObservation::NoRun), t(20));
        assert_eq!(
            s.tracking.cluster_blocker,
            Some(Blocker::ClusterUnreachable)
        );
        assert_eq!(s.tracking.ci_blocker, None);
        assert_eq!(s.tracking.stage_started_at, t(0));
    }

    #[test]
    fn an_unreachable_cluster_blocks_without_failing_and_asks_for_the_vpn_once() {
        let f = flow();
        let mut s = step(
            delivering(&f, t(0)),
            &f,
            cluster(ClusterObservation::Unreachable),
            t(10),
        );
        assert_eq!(
            s.tracking.cluster_blocker,
            Some(Blocker::ClusterUnreachable)
        );
        assert_eq!(s.effects, vec![Effect::ConnectVpn]);
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        assert!(s.tracking.vpn_attempted);
        s = step(
            s.tracking,
            &f,
            cluster(ClusterObservation::Unreachable),
            t(20),
        );
        assert!(s.effects.is_empty());
        assert_eq!(
            s.tracking.cluster_blocker,
            Some(Blocker::ClusterUnreachable)
        );
        s = step(s.tracking, &f, Observation::Tick, t(10 + 16 * 60));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        assert!(s.effects.is_empty());
        s = step(s.tracking, &f, cluster(snapshot(&["app:1"], true)), t(2000));
        assert_eq!(s.tracking.cluster_blocker, None);
        assert_eq!(s.tracking.stage_started_at, t(2000));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        s = step(s.tracking, &f, Observation::Tick, t(2000 + 899));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        s = step(s.tracking, &f, Observation::Tick, t(2000 + 901));
        assert_eq!(s.tracking.state, TrackingState::Stalled);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Stalled)]);
    }

    #[test]
    fn the_rollout_stalls_after_fifteen_minutes_without_a_blocker() {
        let f = flow();
        let mut s = step(
            delivering(&f, t(300)),
            &f,
            cluster(snapshot(&["app:1"], true)),
            t(310),
        );
        s = step(s.tracking, &f, Observation::Tick, t(300 + 899));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        s = step(
            s.tracking,
            &f,
            cluster(snapshot(&["app:1"], true)),
            t(300 + 901),
        );
        assert_eq!(s.tracking.state, TrackingState::Stalled);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Stalled)]);
        assert_eq!(s.tracking.finished_at, Some(t(300 + 901)));
    }

    #[test]
    fn a_baseline_captured_after_the_build_still_lets_the_rollout_succeed() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            cluster(ClusterObservation::Unreachable),
            t(1),
        );
        s = step(s.tracking, &f, ci(CiStatus::Running), t(15));
        s = step(
            s.tracking,
            &f,
            cluster(ClusterObservation::Unreachable),
            t(20),
        );
        s = step(s.tracking, &f, ci(CiStatus::Succeeded), t(300));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        assert_eq!(
            s.tracking.cluster_blocker,
            Some(Blocker::ClusterUnreachable)
        );
        assert_eq!(s.tracking.baseline_images, None);
        let fresh = ClusterObservation::Snapshot(vec![workload(&["app:2"], true, Some(t(350)))]);
        s = step(s.tracking, &f, cluster(fresh), t(400));
        assert_eq!(s.tracking.baseline_at, Some(t(400)));
        assert_eq!(s.tracking.state, TrackingState::Succeeded);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Succeeded)]);
    }

    #[test]
    fn a_baseline_captured_after_the_build_needs_pods_started_after_it() {
        let f = flow();
        let s = step(
            delivering(&f, t(300)),
            &f,
            cluster(ClusterObservation::Snapshot(vec![workload(
                &["app:1"],
                true,
                Some(t(250)),
            )])),
            t(400),
        );
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        let mut unready = workload(&["app:2"], true, Some(t(350)));
        unready.pods_ready = false;
        let s = step(
            delivering(&f, t(300)),
            &f,
            cluster(ClusterObservation::Snapshot(vec![unready])),
            t(400),
        );
        assert_eq!(s.tracking.state, TrackingState::Delivering);
    }

    #[test]
    fn a_baseline_captured_before_the_build_needs_new_images() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            cluster(snapshot(&["app:1"], true)),
            t(1),
        );
        s = step(s.tracking, &f, ci(CiStatus::Succeeded), t(300));
        let restarted =
            ClusterObservation::Snapshot(vec![workload(&["app:1"], true, Some(t(350)))]);
        s = step(s.tracking, &f, cluster(restarted), t(400));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        assert!(s.effects.is_empty());
    }

    #[test]
    fn a_missing_workload_shows_the_reason_and_does_not_stall() {
        let f = flow();
        let reason = "nie znaleziono zasobu api w cs-app-hs";
        let mut s = delivering(&f, t(0));
        for seconds in [10, 300, 600, 960, 1200] {
            let next = step(
                s,
                &f,
                cluster(ClusterObservation::Unavailable(kubectl_problem(reason))),
                t(seconds),
            );
            assert!(next.effects.is_empty());
            s = next.tracking;
        }
        let s = step(s, &f, Observation::Tick, t(1300));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        assert_eq!(
            s.tracking.cluster_blocker,
            Some(Blocker::ToolUnavailable {
                tool: "kubectl".to_string(),
                reason: reason.to_string()
            })
        );
        assert_eq!(s.tracking.ci_blocker, None);
        assert!(!s.tracking.vpn_attempted);
    }

    #[test]
    fn a_snapshot_clears_a_kubectl_problem() {
        let f = flow();
        let s = step(
            delivering(&f, t(0)),
            &f,
            cluster(ClusterObservation::Unavailable(kubectl_problem(
                "forbidden",
            ))),
            t(10),
        );
        let s = step(s.tracking, &f, cluster(snapshot(&["app:1"], true)), t(500));
        assert_eq!(s.tracking.cluster_blocker, None);
        assert_eq!(s.tracking.stage_started_at, t(500));
    }

    #[test]
    fn a_crash_looping_pod_fails_the_delivery_with_its_reason() {
        let f = flow();
        let s = step(
            delivering(&f, t(300)),
            &f,
            cluster(snapshot(&["app:1"], true)),
            t(310),
        );
        let mut crashing = workload(&["app:2"], false, Some(t(320)));
        crashing.failing = Some(PodFailure {
            pod: "app-7d9f-x".to_string(),
            reason: "CrashLoopBackOff".to_string(),
        });
        let s = step(
            s.tracking,
            &f,
            cluster(ClusterObservation::Snapshot(vec![crashing])),
            t(330),
        );
        assert_eq!(s.tracking.state, TrackingState::Failed);
        assert_eq!(
            s.tracking.failure,
            Some(TrackingFailure {
                stage: TrackingStage::Delivery,
                reason: "app-7d9f-x: CrashLoopBackOff".to_string(),
                log_excerpt: None,
            })
        );
        assert_eq!(
            s.effects,
            vec![
                Effect::FetchPodLog {
                    pod: "app-7d9f-x".to_string()
                },
                Effect::Notify(NotifyKind::Failed),
            ]
        );
        assert_eq!(s.tracking.finished_at, Some(t(330)));
    }

    #[test]
    fn a_failing_pod_seen_during_the_build_is_not_a_delivery_failure() {
        let f = flow();
        let s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            ci(CiStatus::Running),
            t(15),
        );
        let mut crashing = workload(&["app:1"], false, Some(t(-60)));
        crashing.failing = Some(PodFailure {
            pod: "app-old-x".to_string(),
            reason: "CrashLoopBackOff".to_string(),
        });
        let s = step(
            s.tracking,
            &f,
            cluster(ClusterObservation::Snapshot(vec![crashing])),
            t(30),
        );
        assert_eq!(s.tracking.state, TrackingState::Building);
        assert_eq!(s.tracking.failure, None);
        assert!(s.effects.is_empty());
    }

    #[test]
    fn kubemeter_waits_for_pods_restarted_after_the_build() {
        let f = flow_delivering(Delivery::Kubemeter);
        let old = ClusterObservation::Snapshot(vec![workload(&["app:1"], true, Some(t(100)))]);
        let s = step(delivering(&f, t(300)), &f, cluster(old), t(310));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        let mut unready = workload(&["app:1"], false, Some(t(320)));
        unready.rollout_complete = true;
        let s = step(
            s.tracking,
            &f,
            cluster(ClusterObservation::Snapshot(vec![unready])),
            t(320),
        );
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        let restarted =
            ClusterObservation::Snapshot(vec![workload(&["app:1"], true, Some(t(320)))]);
        let s = step(s.tracking, &f, cluster(restarted), t(330));
        assert_eq!(s.tracking.state, TrackingState::Succeeded);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Succeeded)]);
    }

    #[test]
    fn a_scaled_down_workload_does_not_block_the_restart_check() {
        let f = flow_delivering(Delivery::Kubemeter);
        let observation = ClusterObservation::Snapshot(vec![
            workload(&["app:1"], true, Some(t(320))),
            scaled_down("worker"),
        ]);
        let s = step(
            delivering(&f, t(300)),
            &f,
            cluster(observation.clone()),
            t(330),
        );
        assert_eq!(s.tracking.state, TrackingState::Succeeded);

        let f = flow();
        let s = step(delivering(&f, t(300)), &f, cluster(observation), t(330));
        assert_eq!(s.tracking.state, TrackingState::Succeeded);
    }

    #[test]
    fn only_scaled_down_workloads_never_prove_a_restart() {
        let f = flow_delivering(Delivery::Kubemeter);
        let observation =
            ClusterObservation::Snapshot(vec![scaled_down("app"), scaled_down("worker")]);
        let s = step(
            delivering(&f, t(300)),
            &f,
            cluster(observation.clone()),
            t(330),
        );
        assert_eq!(s.tracking.state, TrackingState::Delivering);

        let f = flow();
        let s = step(delivering(&f, t(300)), &f, cluster(observation), t(330));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
    }

    #[test]
    fn an_empty_snapshot_is_never_a_success() {
        for delivery in [Delivery::Image, Delivery::Kubemeter] {
            let f = flow_delivering(delivery);
            let mut s = step(
                Tracking::new(&f, "abc", t(0)),
                &f,
                cluster(snapshot(&["app:1"], true)),
                t(1),
            );
            s = step(s.tracking, &f, ci(CiStatus::Succeeded), t(300));
            s = step(
                s.tracking,
                &f,
                cluster(ClusterObservation::Snapshot(Vec::new())),
                t(400),
            );
            assert_eq!(s.tracking.state, TrackingState::Delivering, "{delivery:?}");
            assert!(s.tracking.current_images.is_empty());
            let s = step(
                delivering(&f, t(300)),
                &f,
                cluster(ClusterObservation::Snapshot(Vec::new())),
                t(400),
            );
            assert_eq!(s.tracking.state, TrackingState::Delivering, "{delivery:?}");
        }
    }

    #[test]
    fn build_none_goes_straight_to_delivery_and_delivery_none_ends_at_the_build() {
        let f = flow_building(BuildProvider::None);
        let tracking = Tracking::new(&f, "abc", t(0));
        assert_eq!(tracking.state, TrackingState::Delivering);
        assert_eq!(tracking.build_finished_at, Some(t(0)));
        assert_eq!(
            needs(&tracking, &f),
            Needs {
                ci: false,
                cluster: true
            }
        );
        let restarted = ClusterObservation::Snapshot(vec![workload(&["app:1"], true, Some(t(20)))]);
        let s = step(tracking, &f, cluster(restarted), t(30));
        assert_eq!(s.tracking.state, TrackingState::Succeeded);

        let f = flow_delivering(Delivery::None);
        let tracking = Tracking::new(&f, "abc", t(0));
        assert_eq!(tracking.state, TrackingState::WaitingForRun);
        assert_eq!(
            needs(&tracking, &f),
            Needs {
                ci: true,
                cluster: false
            }
        );
        let s = step(tracking, &f, ci(CiStatus::Succeeded), t(300));
        assert_eq!(s.tracking.state, TrackingState::Succeeded);
        assert_eq!(s.tracking.build_finished_at, Some(t(300)));
        assert_eq!(s.tracking.finished_at, Some(t(300)));
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Succeeded)]);
    }

    #[test]
    fn without_delivery_the_cluster_is_neither_needed_nor_heard() {
        let f = flow_delivering(Delivery::None);
        let s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            cluster(ClusterObservation::Unreachable),
            t(10),
        );
        assert_eq!(s.tracking.cluster_blocker, None);
        assert_eq!(s.tracking.ci_blocker, None);
        assert!(s.effects.is_empty());
        assert!(!s.tracking.vpn_attempted);
    }

    #[test]
    fn needs_follow_the_stage() {
        let f = flow();
        let mut tracking = Tracking::new(&f, "abc", t(0));
        assert_eq!(
            needs(&tracking, &f),
            Needs {
                ci: true,
                cluster: true
            }
        );
        tracking.state = TrackingState::Building;
        assert_eq!(
            needs(&tracking, &f),
            Needs {
                ci: true,
                cluster: true
            }
        );
        tracking.state = TrackingState::Paused;
        assert_eq!(
            needs(&tracking, &f),
            Needs {
                ci: true,
                cluster: true
            }
        );
        tracking.state = TrackingState::Delivering;
        assert_eq!(
            needs(&tracking, &f),
            Needs {
                ci: false,
                cluster: true
            }
        );
        for state in [
            TrackingState::Succeeded,
            TrackingState::Failed,
            TrackingState::Stalled,
            TrackingState::Superseded,
        ] {
            assert_eq!(
                needs(&closed(state), &f),
                Needs {
                    ci: false,
                    cluster: false
                }
            );
        }
    }

    #[test]
    fn closed_trackings_ignore_observations() {
        let f = flow();
        let observations = vec![
            Observation::Tick,
            ci(CiStatus::Running),
            ci(CiStatus::Paused),
            ci(CiStatus::Failed),
            ci(CiStatus::Succeeded),
            Observation::Ci(CiObservation::NoRun),
            Observation::Ci(CiObservation::Unavailable(ToolProblem {
                tool: "bkt".to_string(),
                reason: "x".to_string(),
            })),
            cluster(snapshot(&["app:2"], true)),
            cluster(ClusterObservation::Unreachable),
            cluster(ClusterObservation::Unavailable(kubectl_problem("x"))),
        ];
        for state in [
            TrackingState::Succeeded,
            TrackingState::Failed,
            TrackingState::Stalled,
            TrackingState::Superseded,
        ] {
            let tracking = closed(state);
            assert!(!tracking.is_open());
            for observation in observations.clone() {
                let s = advance(&tracking, &f, observation, t(100_000));
                assert_eq!(s.tracking, tracking);
                assert!(s.effects.is_empty());
            }
        }
    }

    fn blocked_on_both_sides(f: &DeployFlow) -> Tracking {
        let s = step(
            Tracking::new(f, "abc", t(0)),
            f,
            Observation::Ci(CiObservation::Unavailable(bkt_problem())),
            t(10),
        );
        let s = step(
            s.tracking,
            f,
            cluster(ClusterObservation::Unreachable),
            t(20),
        );
        s.tracking
    }

    fn bkt_problem() -> ToolProblem {
        ToolProblem {
            tool: "bkt".to_string(),
            reason: "not logged in".to_string(),
        }
    }

    #[test]
    fn closing_the_tracking_drops_its_blockers() {
        let f = flow();
        let s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            cluster(ClusterObservation::Unreachable),
            t(10),
        );
        let s = step(s.tracking, &f, ci(CiStatus::Failed), t(200));
        assert_eq!(s.tracking.state, TrackingState::Failed);
        assert_eq!(s.tracking.cluster_blocker, None);
        assert_eq!(s.tracking.ci_blocker, None);

        let superseded = supersede(&blocked_on_both_sides(&f), t(30));
        assert_eq!(superseded.ci_blocker, None);
        assert_eq!(superseded.cluster_blocker, None);
        assert_eq!(superseded.blocker(), None);
    }

    #[test]
    fn a_cluster_blocker_does_not_hold_the_wait_for_the_run() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            cluster(ClusterObservation::Unreachable),
            t(1),
        );
        assert_eq!(s.effects, vec![Effect::ConnectVpn]);
        s = step(
            s.tracking,
            &f,
            Observation::Ci(CiObservation::NoRun),
            t(299),
        );
        assert_eq!(s.tracking.state, TrackingState::WaitingForRun);
        assert_eq!(
            s.tracking.cluster_blocker,
            Some(Blocker::ClusterUnreachable)
        );
        s = step(
            s.tracking,
            &f,
            Observation::Ci(CiObservation::NoRun),
            t(301),
        );
        assert_eq!(s.tracking.state, TrackingState::Stalled);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Stalled)]);
        assert_eq!(s.tracking.finished_at, Some(t(301)));
        assert_eq!(s.tracking.cluster_blocker, None);
    }

    #[test]
    fn a_cluster_recovery_during_the_wait_for_the_run_keeps_its_window() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            cluster(ClusterObservation::Unreachable),
            t(1),
        );
        s = step(s.tracking, &f, cluster(snapshot(&["app:1"], true)), t(200));
        assert_eq!(s.tracking.cluster_blocker, None);
        assert_eq!(s.tracking.stage_started_at, t(0));
        s = step(
            s.tracking,
            &f,
            Observation::Ci(CiObservation::NoRun),
            t(301),
        );
        assert_eq!(s.tracking.state, TrackingState::Stalled);
    }

    #[test]
    fn a_pause_expires_after_a_day_even_with_the_cluster_blocked() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            ci(CiStatus::Paused),
            t(600),
        );
        s = step(
            s.tracking,
            &f,
            cluster(ClusterObservation::Unreachable),
            t(700),
        );
        s = step(s.tracking, &f, cluster(snapshot(&["app:1"], true)), t(800));
        assert_eq!(s.tracking.stage_started_at, t(600));
        s = step(
            s.tracking,
            &f,
            cluster(ClusterObservation::Unreachable),
            t(900),
        );
        s = step(s.tracking, &f, Observation::Tick, t(600 + 86_399));
        assert_eq!(s.tracking.state, TrackingState::Paused);
        s = step(s.tracking, &f, Observation::Tick, t(600 + 86_401));
        assert_eq!(s.tracking.state, TrackingState::Stalled);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Stalled)]);
    }

    #[test]
    fn both_sides_keep_their_own_blocker_and_clear_only_their_own() {
        let f = flow();
        let both = blocked_on_both_sides(&f);
        assert_eq!(
            both.ci_blocker,
            Some(Blocker::ToolUnavailable {
                tool: "bkt".to_string(),
                reason: "not logged in".to_string()
            })
        );
        assert_eq!(both.cluster_blocker, Some(Blocker::ClusterUnreachable));
        assert_eq!(
            blocked(&both),
            Blocked {
                ci: true,
                cluster: true
            }
        );

        let mut current = both.clone();
        for (seconds, observation) in [
            (
                30,
                Observation::Ci(CiObservation::Unavailable(bkt_problem())),
            ),
            (40, cluster(ClusterObservation::Unreachable)),
            (
                50,
                Observation::Ci(CiObservation::Unavailable(bkt_problem())),
            ),
            (60, cluster(ClusterObservation::Unreachable)),
            (70, Observation::Tick),
        ] {
            let s = step(current, &f, observation, t(seconds));
            assert_eq!(s.tracking, both);
            assert!(s.effects.is_empty());
            current = s.tracking;
        }

        let s = step(current, &f, Observation::Ci(CiObservation::NoRun), t(80));
        assert_eq!(s.tracking.ci_blocker, None);
        assert_eq!(
            s.tracking.cluster_blocker,
            Some(Blocker::ClusterUnreachable)
        );
        assert_eq!(s.tracking.stage_started_at, t(80));
        assert_eq!(
            blocked(&s.tracking),
            Blocked {
                ci: false,
                cluster: true
            }
        );
    }

    #[test]
    fn the_shown_blocker_follows_the_side_that_owns_the_stage() {
        let f = flow();
        let both = blocked_on_both_sides(&f);
        assert_eq!(both.blocker(), both.ci_blocker.as_ref());
        let s = step(both, &f, ci(CiStatus::Succeeded), t(300));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        assert_eq!(s.tracking.ci_blocker, None);
        assert_eq!(s.tracking.blocker(), Some(&Blocker::ClusterUnreachable));
    }

    #[test]
    fn in_delivery_only_the_cluster_governs_the_rollout_limit() {
        let f = flow();
        let tracking = delivering(&f, t(0));
        assert_eq!(
            needs(&tracking, &f),
            Needs {
                ci: false,
                cluster: true
            }
        );
        let s = step(
            tracking.clone(),
            &f,
            Observation::Ci(CiObservation::Unavailable(bkt_problem())),
            t(10),
        );
        assert_eq!(s.tracking, tracking);

        let mut stray = tracking.clone();
        stray.ci_blocker = Some(Blocker::ToolUnavailable {
            tool: "bkt".to_string(),
            reason: "not logged in".to_string(),
        });
        let s = step(stray, &f, Observation::Tick, t(901));
        assert_eq!(s.tracking.state, TrackingState::Stalled);

        let s = step(
            tracking,
            &f,
            cluster(ClusterObservation::Unavailable(kubectl_problem(
                "forbidden",
            ))),
            t(10),
        );
        let s = step(s.tracking, &f, Observation::Tick, t(2000));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
    }

    #[test]
    fn a_success_seen_after_the_rollout_limit_still_counts() {
        let f = flow();
        let mut s = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            cluster(snapshot(&["app:1"], true)),
            t(1),
        );
        s = step(s.tracking, &f, ci(CiStatus::Succeeded), t(300));
        s = step(
            s.tracking,
            &f,
            cluster(snapshot(&["app:2"], true)),
            t(300 + 1000),
        );
        assert_eq!(s.tracking.state, TrackingState::Succeeded);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Succeeded)]);
    }

    #[test]
    fn a_paused_build_can_fail_or_succeed() {
        let f = flow();
        let paused = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            ci(CiStatus::Paused),
            t(60),
        )
        .tracking;

        let s = step(paused.clone(), &f, ci(CiStatus::Failed), t(120));
        assert_eq!(s.tracking.state, TrackingState::Failed);
        assert_eq!(
            s.effects,
            vec![Effect::FetchBuildLog, Effect::Notify(NotifyKind::Failed)]
        );

        let s = step(paused.clone(), &f, ci(CiStatus::Succeeded), t(120));
        assert_eq!(s.tracking.state, TrackingState::Delivering);
        assert_eq!(s.tracking.stage_started_at, t(120));
        assert!(s.effects.is_empty());

        let without_delivery = flow_delivering(Delivery::None);
        let s = step(paused, &without_delivery, ci(CiStatus::Succeeded), t(120));
        assert_eq!(s.tracking.state, TrackingState::Succeeded);
        assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Succeeded)]);
    }

    #[test]
    fn supersede_closes_an_open_tracking_quietly() {
        let f = flow();
        let running = step(
            Tracking::new(&f, "abc", t(0)),
            &f,
            ci(CiStatus::Running),
            t(15),
        )
        .tracking;
        let superseded = supersede(&running, t(60));
        assert_eq!(superseded.state, TrackingState::Superseded);
        assert_eq!(superseded.finished_at, Some(t(60)));
        assert_eq!(superseded.run_id, running.run_id);
        assert_eq!(superseded.failure, None);
        assert!(!superseded.is_open());
    }

    #[test]
    fn supersede_leaves_a_closed_tracking_alone() {
        let succeeded = closed(TrackingState::Succeeded);
        assert_eq!(supersede(&succeeded, t(500)), succeeded);
    }
}

use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum BuildProvider {
    Bitbucket,
    Github,
    None,
}

impl BuildProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            BuildProvider::Bitbucket => "bitbucket",
            BuildProvider::Github => "github",
            BuildProvider::None => "none",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "bitbucket" => Some(BuildProvider::Bitbucket),
            "github" => Some(BuildProvider::Github),
            "none" => Some(BuildProvider::None),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    Image,
    Kubemeter,
    None,
}

impl Delivery {
    pub fn as_str(&self) -> &'static str {
        match self {
            Delivery::Image => "image",
            Delivery::Kubemeter => "kubemeter",
            Delivery::None => "none",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "image" => Some(Delivery::Image),
            "kubemeter" => Some(Delivery::Kubemeter),
            "none" => Some(Delivery::None),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DeployFlow {
    pub repo_path: String,
    pub enabled: bool,
    pub remote: String,
    pub build: BuildProvider,
    pub build_repo: String,
    pub production_branch: String,
    pub delivery: Delivery,
    pub namespace: String,
    pub workloads: Vec<String>,
    pub kube_context: Option<String>,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct FlowProposal {
    pub id: String,
    pub repo_path: String,
    pub flow: DeployFlow,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub expires_at: i64,
    #[serde(default)]
    #[ts(type = "number | null")]
    pub base_updated_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct FlowChange {
    pub field: String,
    pub label: String,
    pub before: Option<String>,
    pub after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ProposalView {
    pub proposal: FlowProposal,
    pub repo_label: String,
    #[ts(type = "Array<number>")]
    pub project_ids: Vec<i64>,
    pub changes: Vec<FlowChange>,
    #[ts(type = "number | null")]
    pub current_updated_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum ProposalOutcome {
    Resolved,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct RepoFlow {
    pub repo_path: String,
    pub label: String,
    pub remotes: Vec<String>,
    pub flow: Option<DeployFlow>,
    pub proposal: Option<FlowProposal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DeployChangedEvent {
    pub repo_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub tool: String,
    pub found: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DeploySettings {
    pub vpn_connection: Option<String>,
    pub vpn_supported: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum TrackingState {
    WaitingForRun,
    Building,
    Paused,
    Delivering,
    Succeeded,
    Failed,
    Stalled,
    Superseded,
}

impl TrackingState {
    pub const OPEN: [TrackingState; 4] = [
        TrackingState::WaitingForRun,
        TrackingState::Building,
        TrackingState::Paused,
        TrackingState::Delivering,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            TrackingState::WaitingForRun => "waitingForRun",
            TrackingState::Building => "building",
            TrackingState::Paused => "paused",
            TrackingState::Delivering => "delivering",
            TrackingState::Succeeded => "succeeded",
            TrackingState::Failed => "failed",
            TrackingState::Stalled => "stalled",
            TrackingState::Superseded => "superseded",
        }
    }

    pub fn is_open(&self) -> bool {
        Self::OPEN.contains(self)
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum TrackingStage {
    Build,
    Delivery,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Blocker {
    ClusterUnreachable,
    ToolUnavailable { tool: String, reason: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct TrackingFailure {
    pub stage: TrackingStage,
    pub reason: String,
    pub log_excerpt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DeliveryKey {
    pub delivery: Delivery,
    pub namespace: String,
    pub workloads: Vec<String>,
    pub kube_context: Option<String>,
}

impl DeliveryKey {
    pub fn of(flow: &DeployFlow) -> DeliveryKey {
        let mut workloads: Vec<String> = flow
            .workloads
            .iter()
            .map(|workload| workload.trim().to_string())
            .filter(|workload| !workload.is_empty())
            .collect();
        workloads.sort();
        DeliveryKey {
            delivery: flow.delivery,
            namespace: flow.namespace.trim().to_string(),
            workloads,
            kube_context: flow
                .kube_context
                .as_deref()
                .map(str::trim)
                .filter(|context| !context.is_empty())
                .map(str::to_string),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct Tracking {
    #[ts(type = "number")]
    pub id: i64,
    pub repo_path: String,
    pub branch: String,
    pub commit: String,
    pub state: TrackingState,
    pub ci_blocker: Option<Blocker>,
    pub cluster_blocker: Option<Blocker>,
    pub run_id: Option<String>,
    pub run_url: Option<String>,
    #[ts(type = "number | null")]
    pub build_number: Option<i64>,
    pub failure: Option<TrackingFailure>,
    pub baseline_images: Option<Vec<String>>,
    #[ts(type = "number | null")]
    pub baseline_at: Option<i64>,
    pub current_images: Vec<String>,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number")]
    pub stage_started_at: i64,
    #[ts(type = "number | null")]
    pub build_finished_at: Option<i64>,
    #[ts(type = "number | null")]
    pub finished_at: Option<i64>,
    pub vpn_attempted: bool,
    pub dismissed: bool,
    #[serde(default = "default_true")]
    pub has_build: bool,
    #[serde(default = "default_true")]
    pub has_delivery: bool,
    #[serde(default)]
    pub delivery_key: Option<DeliveryKey>,
}

fn default_true() -> bool {
    true
}

impl Tracking {
    pub fn new(flow: &DeployFlow, commit: &str, now: i64) -> Tracking {
        let builds = flow.build != BuildProvider::None;
        Tracking {
            id: 0,
            repo_path: flow.repo_path.clone(),
            branch: flow.production_branch.clone(),
            commit: commit.to_string(),
            state: if builds {
                TrackingState::WaitingForRun
            } else {
                TrackingState::Delivering
            },
            ci_blocker: None,
            cluster_blocker: None,
            run_id: None,
            run_url: None,
            build_number: None,
            failure: None,
            baseline_images: None,
            baseline_at: None,
            current_images: Vec::new(),
            started_at: now,
            stage_started_at: now,
            build_finished_at: if builds { None } else { Some(now) },
            finished_at: None,
            vpn_attempted: false,
            dismissed: false,
            has_build: builds,
            has_delivery: flow.delivery != Delivery::None,
            delivery_key: Some(DeliveryKey::of(flow)),
        }
    }

    pub fn is_open(&self) -> bool {
        self.state.is_open()
    }

    pub fn blocker(&self) -> Option<&Blocker> {
        let (owning, other) = match self.state {
            TrackingState::Delivering => (&self.cluster_blocker, &self.ci_blocker),
            _ => (&self.ci_blocker, &self.cluster_blocker),
        };
        owning.as_ref().or(other.as_ref())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct TrackingView {
    pub tracking: Tracking,
    #[ts(type = "Array<number>")]
    pub project_ids: Vec<i64>,
    pub repo_label: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::test_support::flow;
    use serde_json::json;

    fn tool_problem(tool: &str) -> Blocker {
        Blocker::ToolUnavailable {
            tool: tool.to_string(),
            reason: "not logged in".to_string(),
        }
    }

    #[test]
    fn the_shown_blocker_is_the_one_of_the_side_that_owns_the_state() {
        let mut tracking = Tracking::new(&flow(), "abc", 5);
        assert_eq!(tracking.blocker(), None);

        tracking.ci_blocker = Some(tool_problem("bkt"));
        tracking.cluster_blocker = Some(Blocker::ClusterUnreachable);
        for state in [
            TrackingState::WaitingForRun,
            TrackingState::Building,
            TrackingState::Paused,
        ] {
            tracking.state = state;
            assert_eq!(tracking.blocker(), Some(&tool_problem("bkt")), "{state:?}");
        }
        tracking.state = TrackingState::Delivering;
        assert_eq!(tracking.blocker(), Some(&Blocker::ClusterUnreachable));

        tracking.cluster_blocker = None;
        assert_eq!(tracking.blocker(), Some(&tool_problem("bkt")));
        tracking.state = TrackingState::WaitingForRun;
        tracking.ci_blocker = None;
        tracking.cluster_blocker = Some(Blocker::ClusterUnreachable);
        assert_eq!(tracking.blocker(), Some(&Blocker::ClusterUnreachable));
    }

    #[test]
    fn tracking_states_are_stored_under_their_wire_names() {
        for state in [
            TrackingState::WaitingForRun,
            TrackingState::Building,
            TrackingState::Paused,
            TrackingState::Delivering,
            TrackingState::Succeeded,
            TrackingState::Failed,
            TrackingState::Stalled,
            TrackingState::Superseded,
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), json!(state.as_str()));
        }
    }

    #[test]
    fn only_the_four_running_states_are_open() {
        let open: Vec<_> = [
            TrackingState::WaitingForRun,
            TrackingState::Building,
            TrackingState::Paused,
            TrackingState::Delivering,
            TrackingState::Succeeded,
            TrackingState::Failed,
            TrackingState::Stalled,
            TrackingState::Superseded,
        ]
        .into_iter()
        .filter(TrackingState::is_open)
        .collect();
        assert_eq!(open, TrackingState::OPEN.to_vec());
    }

    #[test]
    fn a_blocker_is_tagged_by_its_type() {
        assert_eq!(
            serde_json::to_value(Blocker::ClusterUnreachable).unwrap(),
            json!({ "type": "clusterUnreachable" })
        );
        assert_eq!(
            serde_json::to_value(Blocker::ToolUnavailable {
                tool: "kubectl".to_string(),
                reason: "forbidden".to_string(),
            })
            .unwrap(),
            json!({ "type": "toolUnavailable", "tool": "kubectl", "reason": "forbidden" })
        );
    }

    #[test]
    fn a_new_tracking_records_from_the_flow_whether_it_builds_and_delivers() {
        for (build, delivery) in [
            (BuildProvider::Bitbucket, Delivery::Image),
            (BuildProvider::Github, Delivery::Kubemeter),
            (BuildProvider::Bitbucket, Delivery::None),
            (BuildProvider::None, Delivery::Image),
            (BuildProvider::None, Delivery::None),
        ] {
            let mut flow = flow();
            flow.build = build;
            flow.delivery = delivery;
            let tracking = Tracking::new(&flow, "abc", 5);
            assert_eq!(tracking.has_build, build != BuildProvider::None, "{build:?}");
            assert_eq!(
                tracking.has_delivery,
                delivery != Delivery::None,
                "{delivery:?}"
            );
        }
        let value = serde_json::to_value(Tracking::new(&flow(), "abc", 5)).unwrap();
        assert_eq!(value["hasBuild"], json!(true));
        assert_eq!(value["hasDelivery"], json!(true));
    }

    #[test]
    fn a_tracking_stored_without_the_stage_flags_reads_both_as_true() {
        let mut value = serde_json::to_value(Tracking::new(&flow(), "abc", 5)).unwrap();
        let body = value.as_object_mut().unwrap();
        body.remove("hasBuild");
        body.remove("hasDelivery");
        let tracking: Tracking = serde_json::from_value(value).unwrap();
        assert!(tracking.has_build);
        assert!(tracking.has_delivery);
    }

    #[test]
    fn the_delivery_key_sorts_the_workloads_and_trims_the_context() {
        let mut flow = flow();
        flow.namespace = " cs-app-hs ".to_string();
        flow.workloads = vec![" worker".to_string(), "app".to_string(), "  ".to_string()];
        flow.kube_context = Some("  ".to_string());
        assert_eq!(
            DeliveryKey::of(&flow),
            DeliveryKey {
                delivery: Delivery::Image,
                namespace: "cs-app-hs".to_string(),
                workloads: vec!["app".to_string(), "worker".to_string()],
                kube_context: None,
            }
        );
        flow.kube_context = Some(" prod ".to_string());
        flow.workloads.reverse();
        assert_eq!(DeliveryKey::of(&flow).kube_context.as_deref(), Some("prod"));
        assert_eq!(
            DeliveryKey::of(&flow).workloads,
            vec!["app".to_string(), "worker".to_string()]
        );
    }

    #[test]
    fn a_new_tracking_freezes_the_delivery_key_and_an_old_row_has_none() {
        let tracking = Tracking::new(&flow(), "abc", 5);
        assert_eq!(tracking.delivery_key, Some(DeliveryKey::of(&flow())));
        let mut value = serde_json::to_value(&tracking).unwrap();
        assert_eq!(value["deliveryKey"]["namespace"], json!("cs-app-hs"));
        value.as_object_mut().unwrap().remove("deliveryKey");
        let old: Tracking = serde_json::from_value(value).unwrap();
        assert_eq!(old.delivery_key, None);
    }

    #[test]
    fn a_tracking_round_trips_through_camel_case_json() {
        let mut flow = flow();
        let mut tracking = Tracking::new(&flow, "abc", 5);
        tracking.failure = Some(TrackingFailure {
            stage: TrackingStage::Delivery,
            reason: "app-x: CrashLoopBackOff".to_string(),
            log_excerpt: Some("boom".to_string()),
        });
        tracking.ci_blocker = Some(tool_problem("bkt"));
        tracking.cluster_blocker = Some(Blocker::ClusterUnreachable);
        let value = serde_json::to_value(&tracking).unwrap();
        assert_eq!(value["state"], json!("waitingForRun"));
        assert_eq!(value["stageStartedAt"], json!(5));
        assert_eq!(value["failure"]["stage"], json!("delivery"));
        assert_eq!(value["failure"]["logExcerpt"], json!("boom"));
        assert_eq!(value["ciBlocker"]["type"], json!("toolUnavailable"));
        assert_eq!(
            value["clusterBlocker"],
            json!({ "type": "clusterUnreachable" })
        );
        assert_eq!(serde_json::from_value::<Tracking>(value).unwrap(), tracking);

        flow.build = BuildProvider::None;
        let direct = Tracking::new(&flow, "abc", 5);
        assert_eq!(direct.state, TrackingState::Delivering);
        assert_eq!(direct.build_finished_at, Some(5));
    }
}

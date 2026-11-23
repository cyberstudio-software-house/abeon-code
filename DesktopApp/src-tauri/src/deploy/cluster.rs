use crate::deploy::ci::{unexpected_response, ToolProblem};
use crate::deploy::excerpt::redact_line;
use crate::deploy::runner::{CommandRunner, RunError};
use crate::domain::deploy::DeployFlow;
use serde_json::Value;
use std::collections::BTreeSet;
use std::time::Duration;

const TOOL: &str = "kubectl";
const KUBECTL_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT_FLAG: &str = "--request-timeout=10s";
const POD_LOG_TAIL_FLAG: &str = "--tail=60";
const UNREACHABLE_MARKERS: [&str; 6] = [
    "unable to connect to the server",
    "dial tcp",
    "i/o timeout",
    "no route to host",
    "connection refused",
    "context deadline exceeded",
];
const UNRESOLVED_HOST_MARKER: &str = "no such host";
const FAILING_REASONS: [&str; 5] = [
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "CreateContainerConfigError",
    "InvalidImageName",
];

#[derive(Debug, Clone, PartialEq)]
pub struct PodFailure {
    pub pod: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WorkloadState {
    pub name: String,
    pub images: Vec<String>,
    pub rollout_complete: bool,
    pub oldest_pod_started_at: Option<i64>,
    pub pods_ready: bool,
    pub failing: Option<PodFailure>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ClusterObservation {
    Snapshot(Vec<WorkloadState>),
    Unreachable,
    Unavailable(ToolProblem),
}

enum KubectlFailure {
    Unreachable,
    Problem(ToolProblem),
}

#[derive(Clone, Copy, PartialEq)]
enum WorkloadKind {
    Deployment,
    StatefulSet,
}

fn context_of(flow: &DeployFlow) -> Option<&str> {
    flow.kube_context.as_deref().map(str::trim).filter(|context| !context.is_empty())
}

fn kubectl_args(flow: &DeployFlow, subcommand: &[&str]) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(context) = context_of(flow) {
        args.push("--context".to_string());
        args.push(context.to_string());
    }
    args.push("-n".to_string());
    args.push(flow.namespace.clone());
    args.extend(subcommand.iter().map(|part| part.to_string()));
    args.push(REQUEST_TIMEOUT_FLAG.to_string());
    args
}

fn is_unreachable(stderr: &str) -> bool {
    let lowered = stderr.to_lowercase();
    UNREACHABLE_MARKERS
        .iter()
        .chain(std::iter::once(&UNRESOLVED_HOST_MARKER))
        .any(|marker| lowered.contains(marker))
}

async fn kubectl(runner: &dyn CommandRunner, args: Vec<String>) -> Result<String, KubectlFailure> {
    let problem = |reason: String| {
        KubectlFailure::Problem(ToolProblem { tool: TOOL.to_string(), reason })
    };
    match runner.run(TOOL, &args, KUBECTL_TIMEOUT).await {
        Err(RunError::NotFound) => Err(problem("nie znaleziono polecenia".to_string())),
        Err(RunError::TimedOut) => Err(KubectlFailure::Unreachable),
        Err(RunError::Io(message)) => Err(problem(message)),
        Ok(output) if output.status == Some(0) => Ok(output.stdout),
        Ok(output) if is_unreachable(&output.stderr) => Err(KubectlFailure::Unreachable),
        Ok(output) => {
            let line = output
                .stderr
                .lines()
                .map(|line| redact_line(line.trim()))
                .map(|line| line.trim().to_string())
                .find(|line| !line.is_empty())
                .unwrap_or_else(|| match output.status {
                    Some(code) => format!("polecenie zakończyło się kodem {code}"),
                    None => "polecenie zostało przerwane".to_string(),
                });
            Err(problem(line))
        }
    }
}

fn parse_items(text: &str) -> Option<Vec<Value>> {
    let mut value: Value = serde_json::from_str(text).ok()?;
    match value["items"].take() {
        Value::Array(items) => Some(items),
        _ => None,
    }
}

fn millis(value: &Value) -> Option<i64> {
    let text = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(text).ok().map(|time| time.timestamp_millis())
}

fn name_of(item: &Value) -> Option<&str> {
    item["metadata"]["name"].as_str()
}

fn kind_of(item: &Value) -> Option<WorkloadKind> {
    match item["kind"].as_str()? {
        "Deployment" => Some(WorkloadKind::Deployment),
        "StatefulSet" => Some(WorkloadKind::StatefulSet),
        _ => None,
    }
}

fn select_workloads<'a>(
    items: &'a [Value],
    flow: &DeployFlow,
) -> Result<Vec<(&'a Value, WorkloadKind)>, ToolProblem> {
    if flow.workloads.is_empty() {
        return Ok(items
            .iter()
            .filter(|item| kind_of(item) == Some(WorkloadKind::Deployment))
            .map(|item| (item, WorkloadKind::Deployment))
            .collect());
    }
    flow.workloads
        .iter()
        .map(|workload| {
            items
                .iter()
                .find_map(|item| match (kind_of(item), name_of(item)) {
                    (Some(kind), Some(name)) if name == workload => Some((item, kind)),
                    _ => None,
                })
                .ok_or_else(|| ToolProblem {
                    tool: TOOL.to_string(),
                    reason: format!(
                        "nie znaleziono zasobu {workload} w {}",
                        flow.namespace
                    ),
                })
        })
        .collect()
}

fn images_of(workload: &Value) -> Vec<String> {
    let pod_spec = &workload["spec"]["template"]["spec"];
    let mut images = BTreeSet::new();
    for section in ["containers", "initContainers"] {
        for container in pod_spec[section].as_array().into_iter().flatten() {
            if let Some(image) = container["image"].as_str() {
                images.insert(image.to_string());
            }
        }
    }
    for volume in pod_spec["volumes"].as_array().into_iter().flatten() {
        if let Some(image) = volume["csi"]["volumeAttributes"]["image"].as_str() {
            images.insert(image.to_string());
        }
    }
    images.into_iter().collect()
}

fn count(value: &Value) -> i64 {
    value.as_i64().unwrap_or(0)
}

fn rollout_complete(workload: &Value) -> bool {
    let desired = workload["spec"]["replicas"].as_i64().unwrap_or(1);
    if desired == 0 {
        return true;
    }
    let status = &workload["status"];
    count(&status["observedGeneration"]) >= count(&workload["metadata"]["generation"])
        && count(&status["updatedReplicas"]) == desired
        && count(&status["readyReplicas"]) == desired
        && count(&status["replicas"]) == desired
}

fn is_replica_set_hash(workload: &str, replica_set: &str) -> bool {
    replica_set
        .strip_prefix(workload)
        .and_then(|rest| rest.strip_prefix('-'))
        .is_some_and(|hash| !hash.is_empty() && !hash.contains('-'))
}

fn belongs_to(pod: &Value, workload: &str, kind: WorkloadKind) -> bool {
    pod["metadata"]["ownerReferences"].as_array().into_iter().flatten().any(|owner| {
        let owner_name = owner["name"].as_str().unwrap_or_default();
        match (kind, owner["kind"].as_str()) {
            (WorkloadKind::StatefulSet, Some("StatefulSet")) => owner_name == workload,
            (WorkloadKind::Deployment, Some("ReplicaSet")) => {
                is_replica_set_hash(workload, owner_name)
            }
            _ => false,
        }
    })
}

fn is_ready(pod: &Value) -> bool {
    pod["status"]["conditions"].as_array().into_iter().flatten().any(|condition| {
        condition["type"].as_str() == Some("Ready")
            && condition["status"].as_str() == Some("True")
    })
}

fn failing_reason(pod: &Value) -> Option<String> {
    ["containerStatuses", "initContainerStatuses"]
        .iter()
        .flat_map(|section| pod["status"][*section].as_array().into_iter().flatten())
        .filter_map(|status| status["state"]["waiting"]["reason"].as_str())
        .find(|reason| FAILING_REASONS.contains(reason))
        .map(str::to_string)
}

fn failure_of(pods: &[&Value], new_pods_since: i64) -> Option<PodFailure> {
    pods.iter().find_map(|pod| {
        let created = millis(&pod["metadata"]["creationTimestamp"])?;
        if created <= new_pods_since {
            return None;
        }
        Some(PodFailure {
            pod: name_of(pod)?.to_string(),
            reason: failing_reason(pod)?,
        })
    })
}

fn workload_state(
    workload: &Value,
    kind: WorkloadKind,
    pods: &[Value],
    new_pods_since: i64,
) -> WorkloadState {
    let name = name_of(workload).unwrap_or_default().to_string();
    let own_pods: Vec<&Value> =
        pods.iter().filter(|pod| belongs_to(pod, &name, kind)).collect();
    WorkloadState {
        images: images_of(workload),
        rollout_complete: rollout_complete(workload),
        oldest_pod_started_at: own_pods
            .iter()
            .filter_map(|pod| millis(&pod["status"]["startTime"]))
            .min(),
        pods_ready: !own_pods.is_empty() && own_pods.iter().all(|pod| is_ready(pod)),
        failing: failure_of(&own_pods, new_pods_since),
        name,
    }
}

fn into_observation(failure: KubectlFailure) -> ClusterObservation {
    match failure {
        KubectlFailure::Unreachable => ClusterObservation::Unreachable,
        KubectlFailure::Problem(problem) => ClusterObservation::Unavailable(problem),
    }
}

pub async fn observe(
    runner: &dyn CommandRunner,
    flow: &DeployFlow,
    new_pods_since: i64,
) -> ClusterObservation {
    let workloads_text = match kubectl(
        runner,
        kubectl_args(flow, &["get", "deployments,statefulsets", "-o", "json"]),
    )
    .await
    {
        Ok(text) => text,
        Err(failure) => return into_observation(failure),
    };
    let pods_text =
        match kubectl(runner, kubectl_args(flow, &["get", "pods", "-o", "json"])).await {
            Ok(text) => text,
            Err(failure) => return into_observation(failure),
        };
    let (Some(workloads), Some(pods)) = (parse_items(&workloads_text), parse_items(&pods_text))
    else {
        return ClusterObservation::Unavailable(unexpected_response(TOOL));
    };
    match select_workloads(&workloads, flow) {
        Ok(selected) => ClusterObservation::Snapshot(
            selected
                .into_iter()
                .map(|(workload, kind)| workload_state(workload, kind, &pods, new_pods_since))
                .collect(),
        ),
        Err(problem) => ClusterObservation::Unavailable(problem),
    }
}

pub async fn pod_log(runner: &dyn CommandRunner, flow: &DeployFlow, pod: &str) -> Option<String> {
    if pod.is_empty() || pod.starts_with('-') {
        return None;
    }
    let args = kubectl_args(flow, &["logs", pod, "--all-containers", POD_LOG_TAIL_FLAG]);
    kubectl(runner, args).await.ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::runner::{ok, CommandOutput, FakeRunner};
    use crate::deploy::test_support::{flow, flow_with};
    use serde_json::json;

    const CREATED_NEW: &str = "1970-01-01T00:00:02Z";
    const STARTED_EARLY: &str = "2026-11-23T10:00:00Z";
    const STARTED_LATE: &str = "2026-11-23T10:05:00Z";

    fn list(items: Vec<Value>) -> String {
        json!({ "apiVersion": "v1", "kind": "List", "metadata": { "resourceVersion": "" }, "items": items })
            .to_string()
    }

    fn deployment(name: &str, replicas: i64, updated: i64, ready: i64, volume_image: &str) -> Value {
        json!({
            "apiVersion": "apps/v1",
            "kind": "Deployment",
            "metadata": { "name": name, "namespace": "cs-app-hs", "generation": 7 },
            "spec": {
                "replicas": replicas,
                "template": { "spec": {
                    "containers": [
                        { "name": "web", "image": "nginx:1.27" },
                        { "name": "php", "image": "php-fpm:8.3" }
                    ],
                    "volumes": [
                        { "name": "code", "csi": {
                            "driver": "image.csi.k8s.io",
                            "volumeAttributes": { "image": volume_image }
                        } },
                        { "name": "tmp", "emptyDir": {} }
                    ]
                } }
            },
            "status": {
                "observedGeneration": 7,
                "replicas": replicas,
                "updatedReplicas": updated,
                "readyReplicas": ready
            }
        })
    }

    fn stateful_set(name: &str) -> Value {
        json!({
            "apiVersion": "apps/v1",
            "kind": "StatefulSet",
            "metadata": { "name": name, "generation": 2 },
            "spec": {
                "replicas": 1,
                "template": { "spec": {
                    "initContainers": [{ "name": "init", "image": "busybox:1.36" }],
                    "containers": [{ "name": "db", "image": "mysql:8" }]
                } }
            },
            "status": { "observedGeneration": 2, "replicas": 1, "updatedReplicas": 1, "readyReplicas": 1 }
        })
    }

    struct PodSpec<'a> {
        name: &'a str,
        owner_kind: &'a str,
        owner: &'a str,
        created: &'a str,
        started: &'a str,
        ready: bool,
        waiting: Option<&'a str>,
        init_waiting: Option<&'a str>,
    }

    fn pod_spec<'a>(name: &'a str, owner_kind: &'a str, owner: &'a str) -> PodSpec<'a> {
        PodSpec {
            name,
            owner_kind,
            owner,
            created: CREATED_NEW,
            started: STARTED_EARLY,
            ready: true,
            waiting: None,
            init_waiting: None,
        }
    }

    fn pod(spec: PodSpec) -> Value {
        let running = json!({ "running": { "startedAt": spec.started } });
        let state = |waiting: Option<&str>| match waiting {
            Some(reason) => json!({ "waiting": { "reason": reason, "message": "back-off" } }),
            None => running.clone(),
        };
        json!({
            "apiVersion": "v1",
            "kind": "Pod",
            "metadata": {
                "name": spec.name,
                "creationTimestamp": spec.created,
                "ownerReferences": [{ "kind": spec.owner_kind, "name": spec.owner, "controller": true }]
            },
            "status": {
                "startTime": spec.started,
                "conditions": [
                    { "type": "Initialized", "status": "True" },
                    { "type": "Ready", "status": if spec.ready { "True" } else { "False" } }
                ],
                "initContainerStatuses": [{ "name": "init", "state": state(spec.init_waiting) }],
                "containerStatuses": [{ "name": "web", "state": state(spec.waiting) }]
            }
        })
    }

    fn deploy_csi() -> String {
        list(vec![deployment("app", 1, 1, 1, "repo/app:1.1.306")])
    }

    fn pods_ready() -> String {
        list(vec![pod(pod_spec("app-5d8f7c9b6-abcde", "ReplicaSet", "app-5d8f7c9b6"))])
    }

    fn runner(deployments: &str, pods: &str) -> FakeRunner {
        FakeRunner::new()
            .on("kubectl", &["-n", "cs-app-hs", "get", "deployments,statefulsets"], ok(deployments))
            .on("kubectl", &["-n", "cs-app-hs", "get", "pods"], ok(pods))
    }

    fn failing_runner(stderr: &str) -> FakeRunner {
        FakeRunner::new().on(
            "kubectl",
            &["-n"],
            Ok(CommandOutput {
                status: Some(1),
                stdout: String::new(),
                stderr: stderr.to_string(),
            }),
        )
    }

    async fn snapshot(runner: &FakeRunner, flow: &DeployFlow, since: i64) -> Vec<WorkloadState> {
        match observe(runner, flow, since).await {
            ClusterObservation::Snapshot(states) => states,
            other => panic!("expected a snapshot, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn reads_images_from_containers_and_csi_volumes() {
        let states = snapshot(&runner(&deploy_csi(), &pods_ready()), &flow(), 0).await;
        assert_eq!(states.len(), 1);
        assert_eq!(states[0].name, "app");
        assert_eq!(states[0].images, vec!["nginx:1.27", "php-fpm:8.3", "repo/app:1.1.306"]);
        assert!(states[0].rollout_complete && states[0].pods_ready);
        assert_eq!(states[0].failing, None);
    }

    #[tokio::test]
    async fn init_container_images_are_included_and_images_are_deduplicated() {
        let mut flow = flow();
        flow.workloads = vec!["db".to_string()];
        let mut set = stateful_set("db");
        set["spec"]["template"]["spec"]["containers"] =
            json!([{ "name": "db", "image": "mysql:8" }, { "name": "side", "image": "mysql:8" }]);
        let pods = list(vec![pod(pod_spec("db-0", "StatefulSet", "db"))]);
        let states = snapshot(&runner(&list(vec![set]), &pods), &flow, 0).await;
        assert_eq!(states[0].images, vec!["busybox:1.36", "mysql:8"]);
        assert!(states[0].rollout_complete && states[0].pods_ready);
    }

    #[tokio::test]
    async fn a_rollout_in_progress_is_not_complete() {
        let deployments = list(vec![deployment("app", 2, 1, 2, "repo/app:1.1.306")]);
        let states = snapshot(&runner(&deployments, &pods_ready()), &flow(), 0).await;
        assert!(!states[0].rollout_complete);
    }

    #[tokio::test]
    async fn a_stale_observed_generation_is_not_complete() {
        let mut stale = deployment("app", 1, 1, 1, "repo/app:1.1.306");
        stale["status"]["observedGeneration"] = json!(6);
        let states = snapshot(&runner(&list(vec![stale]), &pods_ready()), &flow(), 0).await;
        assert!(!states[0].rollout_complete);
    }

    #[tokio::test]
    async fn missing_status_counts_read_as_zero_and_zero_replicas_is_complete() {
        let mut empty_status = deployment("app", 1, 1, 1, "repo/app:1.1.306");
        empty_status["status"] = json!({ "observedGeneration": 7 });
        let states = snapshot(&runner(&list(vec![empty_status]), &pods_ready()), &flow(), 0).await;
        assert!(!states[0].rollout_complete);

        let mut scaled_down = deployment("app", 0, 0, 0, "repo/app:1.1.306");
        scaled_down["status"] = json!({ "observedGeneration": 7 });
        let states = snapshot(&runner(&list(vec![scaled_down]), &list(vec![])), &flow(), 0).await;
        assert!(states[0].rollout_complete);
        assert!(!states[0].pods_ready);
    }

    #[tokio::test]
    async fn pods_are_matched_to_their_own_workload_only() {
        let mut flow = flow();
        flow.workloads = vec!["app".to_string(), "app-web".to_string()];
        let deployments = list(vec![
            deployment("app", 1, 1, 1, "repo/app:1"),
            deployment("app-web", 1, 1, 1, "repo/web:1"),
        ]);
        let mut web = pod_spec("app-web-6c7d8-xyz", "ReplicaSet", "app-web-6c7d8");
        web.started = STARTED_LATE;
        web.ready = false;
        let mut other = pod_spec("other-1", "ReplicaSet", "other-5d8f7c9b6");
        other.started = "2026-11-23T09:00:00Z";
        let pods = list(vec![
            pod(pod_spec("app-5d8f7c9b6-abcde", "ReplicaSet", "app-5d8f7c9b6")),
            pod(web),
            pod(other),
        ]);
        let states = snapshot(&runner(&deployments, &pods), &flow, 0).await;
        assert!(states[0].pods_ready);
        assert_eq!(
            states[0].oldest_pod_started_at,
            millis(&json!(STARTED_EARLY))
        );
        assert!(!states[1].pods_ready);
        assert_eq!(states[1].oldest_pod_started_at, millis(&json!(STARTED_LATE)));
    }

    #[tokio::test]
    async fn the_oldest_start_time_is_the_smallest_and_one_unready_pod_blocks_readiness() {
        let mut late = pod_spec("app-5d8f7c9b6-late", "ReplicaSet", "app-5d8f7c9b6");
        late.started = STARTED_LATE;
        late.ready = false;
        let early = pod_spec("app-5d8f7c9b6-early", "ReplicaSet", "app-5d8f7c9b6");
        let pods = list(vec![pod(late), pod(early)]);
        let states = snapshot(&runner(&deploy_csi(), &pods), &flow(), 0).await;
        assert_eq!(states[0].oldest_pod_started_at, Some(1_795_428_000_000));
        assert!(!states[0].pods_ready);
    }

    #[tokio::test]
    async fn a_crash_looping_new_pod_is_reported_and_an_old_one_is_not() {
        let mut crashing = pod_spec("app-5d8f7c9b6-boom", "ReplicaSet", "app-5d8f7c9b6");
        crashing.created = CREATED_NEW;
        crashing.waiting = Some("CrashLoopBackOff");
        crashing.ready = false;
        let pods = list(vec![pod(crashing)]);
        let runner = runner(&deploy_csi(), &pods);

        let states = snapshot(&runner, &flow(), 1000).await;
        assert_eq!(
            states[0].failing,
            Some(PodFailure {
                pod: "app-5d8f7c9b6-boom".to_string(),
                reason: "CrashLoopBackOff".to_string()
            })
        );
        let states = snapshot(&runner, &flow(), 3000).await;
        assert_eq!(states[0].failing, None);
        let states = snapshot(&runner, &flow(), 2000).await;
        assert_eq!(states[0].failing, None);
    }

    #[tokio::test]
    async fn every_failing_reason_is_recognised_including_init_containers() {
        for reason in FAILING_REASONS {
            let mut broken = pod_spec("app-5d8f7c9b6-x", "ReplicaSet", "app-5d8f7c9b6");
            broken.init_waiting = Some(reason);
            let pods = list(vec![pod(broken)]);
            let states = snapshot(&runner(&deploy_csi(), &pods), &flow(), 0).await;
            assert_eq!(states[0].failing.as_ref().map(|f| f.reason.as_str()), Some(reason));
        }
        let mut waiting = pod_spec("app-5d8f7c9b6-y", "ReplicaSet", "app-5d8f7c9b6");
        waiting.waiting = Some("ContainerCreating");
        let pods = list(vec![pod(waiting)]);
        let states = snapshot(&runner(&deploy_csi(), &pods), &flow(), 0).await;
        assert_eq!(states[0].failing, None);
    }

    #[tokio::test]
    async fn an_empty_workload_list_observes_every_deployment_but_no_stateful_sets() {
        let mut flow = flow();
        flow.workloads = Vec::new();
        let deployments = list(vec![
            deployment("app", 1, 1, 1, "repo/app:1"),
            stateful_set("db"),
            deployment("worker", 1, 1, 1, "repo/worker:1"),
        ]);
        let states = snapshot(&runner(&deployments, &pods_ready()), &flow, 0).await;
        let names: Vec<&str> = states.iter().map(|state| state.name.as_str()).collect();
        assert_eq!(names, vec!["app", "worker"]);
    }

    #[tokio::test]
    async fn a_missing_named_workload_is_unavailable_with_its_name() {
        let mut f = flow();
        f.workloads = vec!["api".into()];
        let observation = observe(&runner(&deploy_csi(), &pods_ready()), &f, 0).await;
        assert!(matches!(&observation,
            ClusterObservation::Unavailable(p) if p.reason.contains("api")));
        assert_eq!(
            observation,
            ClusterObservation::Unavailable(ToolProblem {
                tool: "kubectl".to_string(),
                reason: "nie znaleziono zasobu api w cs-app-hs".to_string()
            })
        );
    }

    #[tokio::test]
    async fn connection_errors_are_unreachable() {
        for stderr in [
            "Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout",
            "The connection to the server x was refused - connection refused",
            "Get \"https://k8s\": no route to host",
            "Get \"https://k8s\": context deadline exceeded",
            "dial tcp: lookup k8s: no such host",
        ] {
            assert_eq!(
                observe(&failing_runner(stderr), &flow(), 0).await,
                ClusterObservation::Unreachable,
                "{stderr}"
            );
        }
        assert!(matches!(
            observe(
                &failing_runner("error: You must be logged in to the server (Unauthorized)"),
                &flow(),
                0
            )
            .await,
            ClusterObservation::Unavailable(problem)
                if problem.reason == "error: You must be logged in to the server (Unauthorized)"
        ));
    }

    #[tokio::test]
    async fn a_timeout_is_unreachable_and_a_missing_binary_is_unavailable() {
        let timed_out = FakeRunner::new().on("kubectl", &["-n"], Err(RunError::TimedOut));
        assert_eq!(observe(&timed_out, &flow(), 0).await, ClusterObservation::Unreachable);
        let missing = FakeRunner::new().on("kubectl", &["-n"], Err(RunError::NotFound));
        assert_eq!(
            observe(&missing, &flow(), 0).await,
            ClusterObservation::Unavailable(ToolProblem {
                tool: "kubectl".to_string(),
                reason: "nie znaleziono polecenia".to_string()
            })
        );
    }

    #[tokio::test]
    async fn a_failure_reason_is_redacted_and_an_empty_stderr_reports_the_exit_code() {
        let leaking = failing_runner("\n  error: token=abc123secret rejected\n");
        let ClusterObservation::Unavailable(problem) = observe(&leaking, &flow(), 0).await else {
            panic!("expected unavailable");
        };
        assert!(!problem.reason.contains("abc123secret"), "{}", problem.reason);
        assert!(!problem.reason.is_empty());

        let silent = failing_runner("");
        assert!(matches!(
            observe(&silent, &flow(), 0).await,
            ClusterObservation::Unavailable(problem)
                if problem.reason == "polecenie zakończyło się kodem 1"
        ));
    }

    #[tokio::test]
    async fn an_unparseable_response_is_unavailable() {
        for body in ["not json", "{\"kind\":\"Status\"}"] {
            assert!(matches!(
                observe(&runner(body, body), &flow(), 0).await,
                ClusterObservation::Unavailable(problem) if problem.reason == "nieoczekiwana odpowiedź"
            ));
        }
    }

    #[tokio::test]
    async fn the_context_flag_is_added_only_when_set() {
        let plain = runner(&deploy_csi(), &pods_ready());
        snapshot(&plain, &flow(), 0).await;
        assert_eq!(
            plain.calls(),
            vec![
                (
                    "kubectl".to_string(),
                    owned_args(&[
                        "-n", "cs-app-hs", "get", "deployments,statefulsets", "-o", "json",
                        "--request-timeout=10s"
                    ])
                ),
                (
                    "kubectl".to_string(),
                    owned_args(&[
                        "-n", "cs-app-hs", "get", "pods", "-o", "json", "--request-timeout=10s"
                    ])
                ),
            ]
        );

        let with_context = FakeRunner::new()
            .on("kubectl", &["--context", "prod", "-n", "cs-app-hs", "get", "deployments,statefulsets"], ok(&deploy_csi()))
            .on("kubectl", &["--context", "prod", "-n", "cs-app-hs", "get", "pods"], ok(&pods_ready()));
        snapshot(&with_context, &flow_with("kubeContext", "  prod "), 0).await;
        let calls = with_context.calls();
        assert_eq!(calls.len(), 2);
        assert!(calls.iter().all(|(_, args)| args[..2] == ["--context", "prod"]));
    }

    #[tokio::test]
    async fn a_blank_context_is_treated_as_absent() {
        for blank in ["", "   "] {
            let runner = runner(&deploy_csi(), &pods_ready());
            snapshot(&runner, &flow_with("kubeContext", blank), 0).await;
            assert!(runner.calls().iter().all(|(_, args)| !args.contains(&"--context".to_string())));
        }
    }

    #[tokio::test]
    async fn pod_log_asks_for_all_containers_and_returns_the_raw_text() {
        let runner = FakeRunner::new().on(
            "kubectl",
            &["-n", "cs-app-hs", "logs", "app-1"],
            ok("line one\nline two\n"),
        );
        assert_eq!(
            pod_log(&runner, &flow(), "app-1").await,
            Some("line one\nline two\n".to_string())
        );
        assert_eq!(
            runner.calls()[0].1,
            owned_args(&[
                "-n", "cs-app-hs", "logs", "app-1", "--all-containers", "--tail=60",
                "--request-timeout=10s"
            ])
        );
    }

    #[tokio::test]
    async fn pod_log_is_none_on_failure_and_refuses_flag_like_names() {
        let failing = failing_runner("Error from server (NotFound): pods \"gone\" not found");
        assert_eq!(pod_log(&failing, &flow(), "gone").await, None);
        let unused = FakeRunner::new();
        assert_eq!(pod_log(&unused, &flow(), "--all-namespaces").await, None);
        assert_eq!(pod_log(&unused, &flow(), "").await, None);
        assert!(unused.calls().is_empty());
    }

    fn owned_args(args: &[&str]) -> Vec<String> {
        args.iter().map(|arg| arg.to_string()).collect()
    }
}

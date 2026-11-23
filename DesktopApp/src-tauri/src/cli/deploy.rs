use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rusqlite::Connection;

use crate::cli::flow::{target, Target};
use crate::db::{db_path, deploy_flows_repo, deploy_trackings_repo, init_pool};
use crate::deploy::reflog::{latest_push, reflog_path};
use crate::deploy::repos::repo_label;
use crate::domain::deploy::{
    BuildProvider, Blocker, Delivery, Tracking, TrackingStage, TrackingState,
};
use crate::sessions::reader::now_ms;

pub const USAGE: &str =
    "usage: abeon-code deploy status | abeon-code deploy wait [--timeout <seconds>]";

const DEFAULT_TIMEOUT_SECS: u64 = 540;
const MAX_TIMEOUT_SECS: u64 = 3600;
const POLL_INTERVAL: Duration = Duration::from_secs(2);
const GRACE: Duration = Duration::from_secs(30);
const BLOCKER_LIMIT: Duration = Duration::from_secs(120);
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const RECENT_TRACKING_MS: i64 = 10 * 60 * 1000;
const FRESH_PUSH_MS: i64 = 60 * 60 * 1000;
const HISTORY_LIMIT: usize = 20;
const PAUSED_NOTICE: &str =
    "The pipeline is waiting for the user's approval. Do not try to approve it; tell the user and stop.";
const BLOCKED_NOTICE: &str =
    "The deployment is blocked and needs the user (see blocked above). Tell the user and stop.";
const RUNNING_NOTICE: &str =
    "The deployment is still running. Run `abeon-code deploy wait` again to keep waiting. AbeonCode must be running for the tracking to progress; if the state never changes, tell the user to check that AbeonCode is open.";
const NOT_SEEN_NOTICE: &str =
    "No tracking has appeared yet. Run `abeon-code deploy wait` again to keep waiting. AbeonCode must be running for a tracking to start.";
const NOT_STARTED_NOTICE: &str =
    "no tracking started (no flow for this repository, tracking is off, or AbeonCode is not running)";

#[derive(Debug, PartialEq)]
pub enum DeployAction {
    Status,
    Wait { timeout_secs: u64 },
}

#[derive(Debug, PartialEq)]
pub struct DeployCommand {
    pub action: DeployAction,
    pub cwd: Option<PathBuf>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WaitOutcome {
    Succeeded,
    Failed,
    NeedsUser,
    StillRunning,
    NoTracking,
}

#[derive(Debug, PartialEq)]
pub struct Verdict {
    pub outcome: WaitOutcome,
    pub tracking: Option<Tracking>,
    pub note: Option<String>,
}

#[derive(Debug, PartialEq)]
pub struct Finished {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

enum Observation {
    NothingToWaitFor(String),
    Seen(Option<Box<Tracking>>),
}

pub fn parse(args: &[String]) -> Option<Result<DeployCommand, String>> {
    if args.get(1).map(String::as_str) != Some("deploy") {
        return None;
    }
    Some(parse_deploy_args(&args[2..]))
}

fn parse_deploy_args(args: &[String]) -> Result<DeployCommand, String> {
    let usage = || USAGE.to_string();
    let waits = match args.first().map(String::as_str) {
        Some("status") => false,
        Some("wait") => true,
        _ => return Err(usage()),
    };
    let mut cwd = None;
    let mut timeout_secs = DEFAULT_TIMEOUT_SECS;
    let mut rest = args[1..].iter();
    while let Some(flag) = rest.next() {
        match flag.as_str() {
            "--cwd" => cwd = Some(PathBuf::from(rest.next().ok_or_else(usage)?)),
            "--timeout" if waits => {
                let value = rest.next().ok_or_else(usage)?;
                let seconds: u64 = value.parse().map_err(|_| {
                    format!("--timeout needs a whole number of seconds, got {value}\n{USAGE}")
                })?;
                timeout_secs = seconds.min(MAX_TIMEOUT_SECS);
            }
            _ => return Err(usage()),
        }
    }
    let action = if waits {
        DeployAction::Wait { timeout_secs }
    } else {
        DeployAction::Status
    };
    Ok(DeployCommand { action, cwd })
}

pub fn exit_code(outcome: &WaitOutcome) -> i32 {
    match outcome {
        WaitOutcome::Succeeded => 0,
        WaitOutcome::Failed => 1,
        WaitOutcome::NoTracking => 3,
        WaitOutcome::NeedsUser => 4,
        WaitOutcome::StillRunning => 8,
    }
}

fn describe_blocker(blocker: &Blocker) -> String {
    match blocker {
        Blocker::ClusterUnreachable => "cluster unreachable (VPN?)".to_string(),
        Blocker::ToolUnavailable { tool, reason } => format!("{tool}: {reason}"),
    }
}

fn stage_name(stage: TrackingStage) -> &'static str {
    match stage {
        TrackingStage::Build => "build",
        TrackingStage::Delivery => "delivery",
    }
}

pub fn render(tracking: &Tracking) -> String {
    let mut lines = vec![
        format!("state: {}", tracking.state.as_str()),
        format!("commit: {}", tracking.commit),
    ];
    if let Some(url) = tracking.run_url.as_deref().filter(|url| !url.is_empty()) {
        lines.push(format!("pipeline: {url}"));
    }
    if tracking.is_open() {
        if let Some(blocker) = tracking.blocker() {
            lines.push(format!("blocked: {}", describe_blocker(blocker)));
        }
    }
    if let Some(failure) = &tracking.failure {
        lines.push(format!("failure: {}: {}", stage_name(failure.stage), failure.reason));
    }
    if tracking.state == TrackingState::Paused {
        lines.push(PAUSED_NOTICE.to_string());
    }
    let mut text = lines.join("\n");
    if let Some(excerpt) = tracking
        .failure
        .as_ref()
        .and_then(|failure| failure.log_excerpt.as_deref())
        .filter(|excerpt| !excerpt.trim().is_empty())
    {
        text.push_str("\n\n");
        text.push_str(excerpt);
    }
    text
}

pub fn wait_outcome(
    tracking: Option<&Tracking>,
    waited: Duration,
    limit: Duration,
    grace: Duration,
    missing_for: Duration,
    blocked_for: Duration,
) -> Option<WaitOutcome> {
    match tracking {
        None if missing_for >= grace => return Some(WaitOutcome::NoTracking),
        Some(tracking) => match tracking.state {
            TrackingState::Succeeded => return Some(WaitOutcome::Succeeded),
            TrackingState::Failed | TrackingState::Stalled => return Some(WaitOutcome::Failed),
            TrackingState::Paused => return Some(WaitOutcome::NeedsUser),
            TrackingState::Superseded => {}
            _ if tracking.blocker().is_some() && blocked_for > BLOCKER_LIMIT => {
                return Some(WaitOutcome::NeedsUser)
            }
            _ => {}
        },
        None => {}
    }
    (waited >= limit).then_some(WaitOutcome::StillRunning)
}

fn verdict(outcome: WaitOutcome, tracking: Option<Tracking>) -> Verdict {
    let note = match (&outcome, &tracking) {
        (WaitOutcome::NoTracking, _) => Some(NOT_STARTED_NOTICE.to_string()),
        (WaitOutcome::NeedsUser, Some(tracking)) if tracking.state != TrackingState::Paused => {
            Some(BLOCKED_NOTICE.to_string())
        }
        (WaitOutcome::StillRunning, Some(_)) => Some(RUNNING_NOTICE.to_string()),
        (WaitOutcome::StillRunning, None) => Some(NOT_SEEN_NOTICE.to_string()),
        _ => None,
    };
    Verdict { outcome, tracking, note }
}

fn untracked_reason(flow: &crate::domain::deploy::DeployFlow) -> Option<&'static str> {
    if !flow.enabled {
        return Some("tracking is switched off for this repository");
    }
    if flow.build == BuildProvider::None && flow.delivery == Delivery::None {
        return Some("the flow of this repository has neither a build nor a delivery to track");
    }
    None
}

fn describe_age(age_ms: i64) -> String {
    let minutes = age_ms.max(0) / 60_000;
    if minutes < 120 {
        format!("{minutes} min ago")
    } else if minutes < 48 * 60 {
        format!("{} h ago", minutes / 60)
    } else {
        format!("{} days ago", minutes / (24 * 60))
    }
}

fn is_stale(tracking: &Tracking, pushed_at: i64, started_ms: i64) -> bool {
    pushed_at < started_ms - FRESH_PUSH_MS
        && !tracking.is_open()
        && tracking.finished_at.is_none_or(|finished| finished < started_ms)
}

fn observe(db: &Path, repo: &str, started_ms: i64) -> Result<Observation, String> {
    let (flow, history) = {
        let conn = Connection::open(db).map_err(|error| error.to_string())?;
        conn.busy_timeout(BUSY_TIMEOUT).map_err(|error| error.to_string())?;
        let flow = deploy_flows_repo::get(&conn, repo).map_err(|error| error.to_string())?;
        let history = deploy_trackings_repo::history(&conn, repo, HISTORY_LIMIT)
            .map_err(|error| error.to_string())?;
        (flow, history)
    };
    let Some(flow) = flow else {
        return Ok(Observation::NothingToWaitFor(
            "no tracking: this repository has no deployment flow".to_string(),
        ));
    };
    if let Some(reason) = untracked_reason(&flow) {
        return Ok(Observation::NothingToWaitFor(format!("no tracking: {reason}")));
    }
    let pushed = reflog_path(Path::new(repo), &flow.remote, &flow.production_branch)
        .and_then(|path| latest_push(&path));
    let tracking = match &pushed {
        Some(push) => history
            .into_iter()
            .find(|tracking| tracking.commit.eq_ignore_ascii_case(&push.commit)),
        None => history.into_iter().next().filter(|tracking| {
            tracking.is_open() || tracking.started_at >= started_ms - RECENT_TRACKING_MS
        }),
    };
    if let (Some(push), Some(tracking)) = (&pushed, &tracking) {
        if is_stale(tracking, push.at, started_ms) {
            return Ok(Observation::NothingToWaitFor(format!(
                "no new push to {}/{}: the newest push is {}, {}, state {} \u{2014} check that your push went to this remote and branch",
                flow.remote,
                flow.production_branch,
                push.commit.chars().take(7).collect::<String>(),
                describe_age(started_ms - push.at),
                tracking.state.as_str(),
            )));
        }
    }
    Ok(Observation::Seen(tracking.map(Box::new)))
}

fn wait_loop(
    db: &Path,
    repo: &str,
    limit: Duration,
    started_ms: i64,
    elapsed: &dyn Fn() -> Duration,
    pause: &mut dyn FnMut(Duration),
) -> Result<Verdict, String> {
    let mut missing_since: Option<Duration> = None;
    let mut blocked: Option<(i64, Duration)> = None;
    loop {
        let waited = elapsed();
        let tracking = match observe(db, repo, started_ms)? {
            Observation::NothingToWaitFor(note) => {
                return Ok(Verdict {
                    outcome: WaitOutcome::NoTracking,
                    tracking: None,
                    note: Some(note),
                })
            }
            Observation::Seen(tracking) => tracking.map(|tracking| *tracking),
        };
        let live = tracking
            .as_ref()
            .is_some_and(|tracking| tracking.state != TrackingState::Superseded);
        missing_since = if live { None } else { Some(missing_since.unwrap_or(waited)) };
        let missing_for = missing_since.map_or(Duration::ZERO, |since| waited.saturating_sub(since));
        let blocked_id = tracking
            .as_ref()
            .filter(|tracking| tracking.is_open() && tracking.blocker().is_some())
            .map(|tracking| tracking.id);
        blocked = match (blocked_id, blocked) {
            (Some(id), Some((previous, since))) if id == previous => Some((id, since)),
            (Some(id), _) => Some((id, waited)),
            (None, _) => None,
        };
        let blocked_for = blocked.map_or(Duration::ZERO, |(_, since)| waited.saturating_sub(since));
        if let Some(outcome) =
            wait_outcome(tracking.as_ref(), waited, limit, GRACE, missing_for, blocked_for)
        {
            return Ok(verdict(outcome, tracking));
        }
        pause(POLL_INTERVAL.min(limit.saturating_sub(waited)));
    }
}

fn repos_of(conn: &Connection, dir: &Path) -> Result<Vec<String>, String> {
    Ok(match target(conn, dir)? {
        Target::Repo(repo) => vec![repo],
        Target::Repos(repos) => repos,
    })
}

pub fn status_text(conn: &Connection, dir: &Path) -> Result<String, String> {
    let repos = repos_of(conn, dir)?;
    let several = repos.len() > 1;
    let mut blocks = Vec::new();
    for repo in &repos {
        let latest = deploy_trackings_repo::history(conn, repo, 1)
            .map_err(|error| error.to_string())?
            .into_iter()
            .next();
        let body = match latest {
            Some(tracking) => render(&tracking),
            None => "abeon-code: no deployment tracked for this repository".to_string(),
        };
        blocks.push(if several {
            format!("repository: {}\n{body}", repo_label(Path::new(repo)))
        } else {
            body
        });
    }
    if blocks.is_empty() {
        return Ok("abeon-code: no deployment tracked for this repository".to_string());
    }
    Ok(blocks.join("\n\n"))
}

fn single_repo(conn: &Connection, dir: &Path) -> Result<String, String> {
    let mut repos = repos_of(conn, dir)?;
    match repos.len() {
        1 => Ok(repos.remove(0)),
        0 => Err(format!(
            "{} is not inside a repository of an AbeonCode project",
            dir.display()
        )),
        _ => Err(format!(
            "{} holds several repositories; run the command inside one of: {}",
            dir.display(),
            repos.join(", ")
        )),
    }
}

pub fn finish(verdict: Verdict) -> Finished {
    let code = exit_code(&verdict.outcome);
    if verdict.outcome == WaitOutcome::NoTracking {
        let note = verdict.note.unwrap_or_default();
        let stdout = note
            .lines()
            .map(|line| format!("abeon-code: {line}"))
            .collect::<Vec<_>>()
            .join("\n");
        return Finished { code, stdout, stderr: String::new() };
    }
    let mut parts = Vec::new();
    if let Some(tracking) = &verdict.tracking {
        parts.push(render(tracking));
    }
    if let Some(note) = verdict.note {
        parts.push(note);
    }
    Finished { code, stdout: parts.join("\n\n"), stderr: String::new() }
}

fn run_command(cmd: &DeployCommand) -> Result<Finished, String> {
    let dir = match &cmd.cwd {
        Some(dir) => dir.clone(),
        None => std::env::current_dir().map_err(|error| error.to_string())?,
    };
    let path = db_path().map_err(|error| error.to_string())?;
    let repo = {
        let pool = init_pool(&path).map_err(|error| error.to_string())?;
        let conn = pool.get().map_err(|error| error.to_string())?;
        match cmd.action {
            DeployAction::Status => {
                return Ok(Finished {
                    code: 0,
                    stdout: status_text(&conn, &dir)?,
                    stderr: String::new(),
                })
            }
            DeployAction::Wait { .. } => single_repo(&conn, &dir)?,
        }
    };
    let DeployAction::Wait { timeout_secs } = cmd.action else {
        return Err(USAGE.to_string());
    };
    let started = Instant::now();
    let verdict = wait_loop(
        &path,
        &repo,
        Duration::from_secs(timeout_secs),
        now_ms(),
        &|| started.elapsed(),
        &mut |duration| std::thread::sleep(duration),
    )?;
    Ok(finish(verdict))
}

pub fn try_run(args: &[String]) -> Option<i32> {
    let parsed = parse(args)?;
    match parsed.and_then(|cmd| run_command(&cmd)) {
        Ok(finished) => {
            if !finished.stdout.is_empty() {
                println!("{}", finished.stdout);
            }
            if !finished.stderr.is_empty() {
                eprintln!("{}", finished.stderr);
            }
            Some(finished.code)
        }
        Err(message) => {
            for line in message.lines() {
                eprintln!("abeon-code: {line}");
            }
            Some(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::projects_repo;
    use crate::deploy::test_support::{append, conn, flow_at, init_repo, push, repo_with_push};
    use crate::domain::deploy::{DeployFlow, TrackingFailure};
    use std::cell::Cell;
    use tempfile::tempdir;

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|part| part.to_string()).collect()
    }

    fn secs(value: u64) -> Duration {
        Duration::from_secs(value)
    }

    fn sha(label: &str) -> String {
        label.repeat(40)
    }

    fn tracking_in(state: TrackingState) -> Tracking {
        let mut tracking = Tracking::new(&flow_at("/r/a"), &sha("a"), 0);
        tracking.state = state;
        tracking
    }

    fn outcome(state: TrackingState) -> Option<WaitOutcome> {
        wait_outcome(Some(&tracking_in(state)), secs(5), secs(540), secs(30), secs(0), secs(0))
    }

    #[test]
    fn outcomes_follow_the_tracking_state() {
        assert_eq!(outcome(TrackingState::Succeeded), Some(WaitOutcome::Succeeded));
        assert_eq!(outcome(TrackingState::Failed), Some(WaitOutcome::Failed));
        assert_eq!(outcome(TrackingState::Stalled), Some(WaitOutcome::Failed));
        assert_eq!(outcome(TrackingState::Paused), Some(WaitOutcome::NeedsUser));
        assert_eq!(outcome(TrackingState::WaitingForRun), None);
        assert_eq!(outcome(TrackingState::Building), None);
        assert_eq!(outcome(TrackingState::Delivering), None);
        assert_eq!(outcome(TrackingState::Superseded), None);
    }

    #[test]
    fn a_running_deployment_hits_the_limit_but_a_finished_one_wins() {
        let building = tracking_in(TrackingState::Building);
        let at = |waited| wait_outcome(Some(&building), secs(waited), secs(540), secs(30), secs(0), secs(0));
        assert_eq!(at(539), None);
        assert_eq!(at(540), Some(WaitOutcome::StillRunning));
        let done = tracking_in(TrackingState::Succeeded);
        assert_eq!(
            wait_outcome(Some(&done), secs(600), secs(540), secs(30), secs(0), secs(0)),
            Some(WaitOutcome::Succeeded)
        );
    }

    #[test]
    fn a_missing_tracking_is_given_the_grace_period() {
        let missing = |waited, missing_for| {
            wait_outcome(None, secs(waited), secs(540), secs(30), secs(missing_for), secs(0))
        };
        assert_eq!(missing(29, 29), None);
        assert_eq!(missing(31, 31), Some(WaitOutcome::NoTracking));
        assert_eq!(missing(100, 5), None);
        assert_eq!(missing(540, 5), Some(WaitOutcome::StillRunning));
        assert_eq!(
            wait_outcome(None, secs(10), secs(10), secs(30), secs(10), secs(0)),
            Some(WaitOutcome::StillRunning)
        );
    }

    #[test]
    fn a_blocker_older_than_two_minutes_needs_the_user() {
        let mut building = tracking_in(TrackingState::Building);
        building.cluster_blocker = Some(Blocker::ClusterUnreachable);
        let blocked = |blocked_for| {
            wait_outcome(Some(&building), secs(300), secs(540), secs(30), secs(0), secs(blocked_for))
        };
        assert_eq!(blocked(120), None);
        assert_eq!(blocked(121), Some(WaitOutcome::NeedsUser));

        let clear = tracking_in(TrackingState::Building);
        assert_eq!(
            wait_outcome(Some(&clear), secs(300), secs(540), secs(30), secs(0), secs(500)),
            None
        );
    }

    #[test]
    fn exit_codes_are_stable() {
        assert_eq!(exit_code(&WaitOutcome::Succeeded), 0);
        assert_eq!(exit_code(&WaitOutcome::Failed), 1);
        assert_eq!(exit_code(&WaitOutcome::NoTracking), 3);
        assert_eq!(exit_code(&WaitOutcome::NeedsUser), 4);
        assert_eq!(exit_code(&WaitOutcome::StillRunning), 8);
    }

    #[test]
    fn render_includes_the_link_the_reason_and_the_log() {
        let mut failed = tracking_in(TrackingState::Failed);
        failed.run_url = Some("https://bitbucket.org/cybercode/api/pipelines/results/7".to_string());
        failed.failure = Some(TrackingFailure {
            stage: TrackingStage::Build,
            reason: "pipeline failed".to_string(),
            log_excerpt: Some("npm ERR! tests failed\nexit 1".to_string()),
        });
        assert_eq!(
            render(&failed),
            format!(
                "state: failed\ncommit: {}\npipeline: https://bitbucket.org/cybercode/api/pipelines/results/7\nfailure: build: pipeline failed\n\nnpm ERR! tests failed\nexit 1",
                sha("a")
            )
        );
    }

    #[test]
    fn render_names_the_blocker_and_leaves_out_what_is_missing() {
        let mut building = tracking_in(TrackingState::Delivering);
        building.cluster_blocker = Some(Blocker::ClusterUnreachable);
        assert_eq!(
            render(&building),
            format!("state: delivering\ncommit: {}\nblocked: cluster unreachable (VPN?)", sha("a"))
        );
        building.cluster_blocker = None;
        building.ci_blocker = Some(Blocker::ToolUnavailable {
            tool: "bkt".to_string(),
            reason: "not logged in".to_string(),
        });
        assert!(render(&building).ends_with("blocked: bkt: not logged in"));
        building.ci_blocker = None;
        assert!(!render(&building).contains("blocked"));
        assert!(!render(&building).contains("pipeline"));
    }

    #[test]
    fn render_tells_the_agent_not_to_approve_a_paused_pipeline() {
        let paused = render(&tracking_in(TrackingState::Paused));
        assert!(paused.ends_with(PAUSED_NOTICE), "{paused}");
        assert!(!render(&tracking_in(TrackingState::Building)).contains("approval"));
    }

    #[test]
    fn a_failure_without_a_log_prints_no_trailing_blank_line() {
        let mut failed = tracking_in(TrackingState::Stalled);
        failed.failure = Some(TrackingFailure {
            stage: TrackingStage::Delivery,
            reason: "pods did not restart".to_string(),
            log_excerpt: None,
        });
        assert!(render(&failed).ends_with("failure: delivery: pods did not restart"));
    }

    #[test]
    fn parses_status_and_wait_with_a_bounded_timeout() {
        assert_eq!(
            parse(&args(&["abeoncode", "deploy", "status"])),
            Some(Ok(DeployCommand { action: DeployAction::Status, cwd: None }))
        );
        assert_eq!(
            parse(&args(&["abeoncode", "deploy", "wait", "--cwd", "/p"])),
            Some(Ok(DeployCommand {
                action: DeployAction::Wait { timeout_secs: 540 },
                cwd: Some(PathBuf::from("/p")),
            }))
        );
        assert_eq!(
            parse(&args(&["abeoncode", "deploy", "wait", "--timeout", "60", "--cwd", "/p"])),
            Some(Ok(DeployCommand {
                action: DeployAction::Wait { timeout_secs: 60 },
                cwd: Some(PathBuf::from("/p")),
            }))
        );
        assert_eq!(
            parse(&args(&["abeoncode", "deploy", "wait", "--timeout", "99999"])),
            Some(Ok(DeployCommand {
                action: DeployAction::Wait { timeout_secs: 3600 },
                cwd: None,
            }))
        );
        let Some(Err(message)) = parse(&args(&["abeoncode", "deploy", "wait", "--timeout", "x"])) else {
            panic!("a non-numeric timeout must be rejected");
        };
        assert!(message.contains("--timeout"), "{message}");
        assert!(message.contains(USAGE), "{message}");
    }

    #[test]
    fn rejects_unknown_input_and_ignores_other_commands() {
        for rejected in [
            &["abeoncode", "deploy"][..],
            &["abeoncode", "deploy", "bogus"],
            &["abeoncode", "deploy", "status", "--timeout", "5"],
            &["abeoncode", "deploy", "wait", "--timeout"],
            &["abeoncode", "deploy", "wait", "--timeout", "-5"],
            &["abeoncode", "deploy", "wait", "--cwd"],
            &["abeoncode", "deploy", "wait", "--force"],
        ] {
            let parsed = parse(&args(rejected));
            assert!(matches!(parsed, Some(Err(_))), "{rejected:?}");
        }
        assert_eq!(
            parse(&args(&["abeoncode", "deploy", "status", "--force"])),
            Some(Err(USAGE.to_string()))
        );
        assert_eq!(parse(&args(&["abeoncode", "flow", "show"])), None);
        assert_eq!(parse(&args(&["abeoncode"])), None);
    }

    struct Fixture {
        repo: tempfile::TempDir,
        conn: crate::deploy::test_support::TestConn,
        flow: DeployFlow,
    }

    fn fixture(label: &str) -> Fixture {
        let (repo, flow) = repo_with_push(label);
        let conn = conn();
        deploy_flows_repo::upsert(&conn, &flow).unwrap();
        Fixture { repo, conn, flow }
    }

    const PUSH_MS: i64 = 1_795_009_000_000;
    const MINUTE_MS: i64 = 60_000;
    const HOUR_MS: i64 = 60 * MINUTE_MS;

    fn insert_at(
        fixture: &Fixture,
        label: &str,
        state: TrackingState,
        started_at: i64,
        finished_at: Option<i64>,
    ) -> Tracking {
        let mut tracking = Tracking::new(&fixture.flow, &sha(label), started_at);
        tracking.state = state;
        tracking.finished_at = finished_at;
        deploy_trackings_repo::insert(&fixture.conn, &tracking).unwrap()
    }

    fn insert(fixture: &Fixture, label: &str, state: TrackingState) -> Tracking {
        insert_at(fixture, label, state, PUSH_MS + 1_000, None)
    }

    fn run(fixture: &Fixture, limit: u64) -> (Verdict, Duration) {
        run_with(fixture, limit, |_| {})
    }

    fn run_with(fixture: &Fixture, limit: u64, hook: impl FnMut(Duration)) -> (Verdict, Duration) {
        run_from(fixture, limit, PUSH_MS + MINUTE_MS, hook)
    }

    fn run_from(
        fixture: &Fixture,
        limit: u64,
        started_ms: i64,
        mut hook: impl FnMut(Duration),
    ) -> (Verdict, Duration) {
        let clock = Cell::new(Duration::ZERO);
        let verdict = wait_loop(
            fixture.conn.db_path(),
            &fixture.flow.repo_path,
            secs(limit),
            started_ms,
            &|| clock.get(),
            &mut |duration| {
                clock.set(clock.get() + duration);
                hook(clock.get());
            },
        )
        .unwrap();
        (verdict, clock.get())
    }

    #[test]
    fn returns_at_once_for_a_tracking_of_the_pushed_commit() {
        let fixture = fixture("b");
        insert(&fixture, "a", TrackingState::Failed);
        let done = insert(&fixture, "b", TrackingState::Succeeded);
        let (verdict, waited) = run(&fixture, 540);
        assert_eq!(verdict.outcome, WaitOutcome::Succeeded);
        assert_eq!(verdict.tracking, Some(done));
        assert_eq!(waited, Duration::ZERO);
    }

    #[test]
    fn a_tracking_of_an_older_commit_is_not_the_answer() {
        let fixture = fixture("b");
        insert(&fixture, "a", TrackingState::Succeeded);
        let (verdict, waited) = run(&fixture, 540);
        assert_eq!(verdict.outcome, WaitOutcome::NoTracking);
        assert_eq!(verdict.tracking, None);
        assert_eq!(verdict.note.as_deref(), Some(NOT_STARTED_NOTICE));
        assert!(waited >= GRACE && waited <= GRACE + POLL_INTERVAL, "{waited:?}");
    }

    #[test]
    fn waits_for_the_tracking_to_appear_and_to_finish() {
        let fixture = fixture("b");
        let mut inserted: Option<Tracking> = None;
        let (verdict, waited) = run_with(&fixture, 540, |now| {
            if now >= secs(4) && inserted.is_none() {
                inserted = Some(insert(&fixture, "b", TrackingState::Building));
            }
            if now >= secs(10) {
                let mut tracking = inserted.clone().unwrap();
                tracking.state = TrackingState::Failed;
                deploy_trackings_repo::update(&fixture.conn, &tracking).unwrap();
            }
        });
        assert_eq!(verdict.outcome, WaitOutcome::Failed);
        assert_eq!(verdict.tracking.unwrap().state, TrackingState::Failed);
        assert_eq!(waited, secs(10));
    }

    #[test]
    fn a_superseded_tracking_hands_over_to_the_newer_push() {
        let fixture = fixture("a");
        let first = insert(&fixture, "a", TrackingState::Building);
        let (verdict, _) = run_with(&fixture, 540, |now| {
            if now == secs(2) {
                let mut superseded = first.clone();
                superseded.state = TrackingState::Superseded;
                deploy_trackings_repo::update(&fixture.conn, &superseded).unwrap();
                push(&fixture.flow.repo_path, "b");
                insert(&fixture, "b", TrackingState::Succeeded);
            }
        });
        assert_eq!(verdict.outcome, WaitOutcome::Succeeded);
        assert_eq!(verdict.tracking.unwrap().commit, sha("b"));
    }

    #[test]
    fn the_newer_commit_gets_its_own_grace_after_a_supersede() {
        let fixture = fixture("a");
        let first = insert(&fixture, "a", TrackingState::Building);
        let (verdict, waited) = run_with(&fixture, 540, |now| {
            if now == secs(100) {
                let mut superseded = first.clone();
                superseded.state = TrackingState::Superseded;
                deploy_trackings_repo::update(&fixture.conn, &superseded).unwrap();
                push(&fixture.flow.repo_path, "b");
            }
            if now == secs(116) {
                insert(&fixture, "b", TrackingState::Succeeded);
            }
        });
        assert_eq!(verdict.outcome, WaitOutcome::Succeeded);
        assert_eq!(verdict.tracking.unwrap().commit, sha("b"));
        assert_eq!(waited, secs(116));
    }

    #[test]
    fn a_newer_push_that_never_gets_a_tracking_ends_as_no_tracking_after_the_grace() {
        let fixture = fixture("a");
        let first = insert(&fixture, "a", TrackingState::Building);
        let (verdict, waited) = run_with(&fixture, 540, |now| {
            if now == secs(100) {
                let mut superseded = first.clone();
                superseded.state = TrackingState::Superseded;
                deploy_trackings_repo::update(&fixture.conn, &superseded).unwrap();
                push(&fixture.flow.repo_path, "b");
            }
        });
        assert_eq!(verdict.outcome, WaitOutcome::NoTracking);
        assert!(waited >= secs(130) && waited <= secs(132), "{waited:?}");
    }

    #[test]
    fn a_deployment_that_keeps_running_ends_as_still_running() {
        let fixture = fixture("b");
        insert(&fixture, "b", TrackingState::Building);
        let (verdict, waited) = run(&fixture, 10);
        assert_eq!(verdict.outcome, WaitOutcome::StillRunning);
        assert_eq!(verdict.note.as_deref(), Some(RUNNING_NOTICE));
        assert!(RUNNING_NOTICE.contains("AbeonCode must be running"));
        assert_eq!(waited, secs(10));
        assert_eq!(finish(verdict).code, 8);
    }

    #[test]
    fn a_short_timeout_before_any_tracking_says_none_has_appeared_yet() {
        let fixture = fixture("b");
        let (verdict, _) = run(&fixture, 4);
        assert_eq!(verdict.outcome, WaitOutcome::StillRunning);
        assert_eq!(verdict.tracking, None);
        assert_eq!(verdict.note.as_deref(), Some(NOT_SEEN_NOTICE));
    }

    #[test]
    fn a_blocker_that_lasts_asks_for_the_user_and_one_that_clears_does_not() {
        let fixture = fixture("b");
        let mut blocked = insert(&fixture, "b", TrackingState::Delivering);
        blocked.cluster_blocker = Some(Blocker::ClusterUnreachable);
        deploy_trackings_repo::update(&fixture.conn, &blocked).unwrap();
        let (verdict, waited) = run(&fixture, 540);
        assert_eq!(verdict.outcome, WaitOutcome::NeedsUser);
        assert!(waited > secs(120) && waited <= secs(124), "{waited:?}");
        assert_eq!(verdict.note.as_deref(), Some(BLOCKED_NOTICE));
        assert!(finish(verdict).stdout.contains("blocked: cluster unreachable (VPN?)"));

        let mut cleared = blocked.clone();
        let (verdict, waited) = run_with(&fixture, 300, |now| {
            if now == secs(100) {
                cleared.cluster_blocker = None;
                deploy_trackings_repo::update(&fixture.conn, &cleared).unwrap();
            }
            if now == secs(150) {
                cleared.cluster_blocker = Some(Blocker::ClusterUnreachable);
                deploy_trackings_repo::update(&fixture.conn, &cleared).unwrap();
            }
        });
        assert_eq!(verdict.outcome, WaitOutcome::NeedsUser);
        assert!(waited > secs(270) && waited <= secs(274), "{waited:?}");
    }

    #[test]
    fn a_paused_pipeline_needs_the_user_at_once() {
        let fixture = fixture("b");
        insert(&fixture, "b", TrackingState::Paused);
        let (verdict, waited) = run(&fixture, 540);
        assert_eq!(verdict.outcome, WaitOutcome::NeedsUser);
        assert_eq!(waited, Duration::ZERO);
        let finished = finish(verdict);
        assert_eq!(finished.code, 4);
        assert!(finished.stdout.contains(PAUSED_NOTICE));
        assert!(!finished.stdout.contains(BLOCKED_NOTICE));
    }

    #[test]
    fn no_flow_a_disabled_flow_or_nothing_to_track_answers_at_once() {
        let none = fixture("b");
        deploy_flows_repo::delete(&none.conn, &none.flow.repo_path).unwrap();
        let mut disabled = fixture("b");
        disabled.flow.enabled = false;
        let mut empty = fixture("b");
        empty.flow.build = BuildProvider::None;
        empty.flow.delivery = Delivery::None;
        for fixture in [&disabled, &empty] {
            deploy_flows_repo::upsert(&fixture.conn, &fixture.flow).unwrap();
        }
        for (fixture, reason) in [
            (&none, "no deployment flow"),
            (&disabled, "switched off"),
            (&empty, "neither a build nor a delivery"),
        ] {
            insert(fixture, "b", TrackingState::Succeeded);
            let (verdict, waited) = run(fixture, 540);
            assert_eq!(verdict.outcome, WaitOutcome::NoTracking, "{reason}");
            assert_eq!(waited, Duration::ZERO, "{reason}");
            let note = verdict.note.clone().unwrap();
            assert!(note.contains(reason), "{note}");
            let finished = finish(verdict);
            assert_eq!(finished.code, 3);
            assert_eq!(finished.stderr, "");
            assert!(finished.stdout.starts_with("abeon-code: no tracking: "), "{}", finished.stdout);
        }
    }

    #[test]
    fn a_delivery_only_flow_is_tracked() {
        let mut fixture = fixture("b");
        fixture.flow.build = BuildProvider::None;
        deploy_flows_repo::upsert(&fixture.conn, &fixture.flow).unwrap();
        insert(&fixture, "b", TrackingState::Succeeded);
        let (verdict, _) = run(&fixture, 540);
        assert_eq!(verdict.outcome, WaitOutcome::Succeeded);
    }

    fn fetch_after_push(fixture: &Fixture) {
        append(
            &fixture
                .repo
                .path()
                .join(".git/logs/refs/remotes/origin/master"),
            &format!(
                "{} {} Test User <test@example.com> 1795009100 +0100\tfetch origin: fast-forward",
                sha("b"),
                sha("c")
            ),
        );
    }

    #[test]
    fn an_old_finished_push_is_not_reported_as_a_deployment_of_this_wait() {
        let fixture = fixture("b");
        insert_at(&fixture, "b", TrackingState::Succeeded, PUSH_MS + 1_000, Some(PUSH_MS + 5 * MINUTE_MS));
        let started_ms = PUSH_MS + 3 * HOUR_MS + 10 * MINUTE_MS;
        let (verdict, waited) = run_from(&fixture, 540, started_ms, |_| {});
        assert_eq!(verdict.outcome, WaitOutcome::NoTracking);
        assert_eq!(verdict.tracking, None);
        assert_eq!(waited, Duration::ZERO);
        assert_eq!(
            verdict.note.as_deref(),
            Some(
                "no new push to origin/master: the newest push is bbbbbbb, 3 h ago, state succeeded \u{2014} check that your push went to this remote and branch"
            )
        );
        let finished = finish(verdict);
        assert_eq!(finished.code, 3);
        assert!(finished.stdout.starts_with("abeon-code: no new push to origin/master"));
    }

    #[test]
    fn an_old_push_with_an_open_tracking_is_followed_normally() {
        let fixture = fixture("b");
        let open = insert_at(&fixture, "b", TrackingState::Building, PUSH_MS + 1_000, None);
        let started_ms = PUSH_MS + 3 * HOUR_MS;
        let (verdict, waited) = run_from(&fixture, 540, started_ms, |now| {
            if now >= secs(6) {
                let mut done = open.clone();
                done.state = TrackingState::Succeeded;
                done.finished_at = Some(started_ms + 5_000);
                deploy_trackings_repo::update(&fixture.conn, &done).unwrap();
            }
        });
        assert_eq!(verdict.outcome, WaitOutcome::Succeeded);
        assert_eq!(waited, secs(6));
        let (verdict, _) = run_from(&fixture, 10, started_ms + HOUR_MS, |_| {});
        assert_eq!(verdict.outcome, WaitOutcome::NoTracking);
    }

    #[test]
    fn a_push_is_fresh_for_an_hour_and_a_tracking_that_finishes_during_the_wait_is_never_stale() {
        let finished_early = fixture("b");
        insert_at(
            &finished_early,
            "b",
            TrackingState::Succeeded,
            PUSH_MS + 1_000,
            Some(PUSH_MS + MINUTE_MS),
        );
        for (offset_ms, expected) in [
            (5 * MINUTE_MS, WaitOutcome::Succeeded),
            (59 * MINUTE_MS, WaitOutcome::Succeeded),
            (61 * MINUTE_MS, WaitOutcome::NoTracking),
        ] {
            let (verdict, _) = run_from(&finished_early, 540, PUSH_MS + offset_ms, |_| {});
            assert_eq!(verdict.outcome, expected, "{offset_ms}");
        }

        let finished_during_wait = fixture("b");
        insert_at(
            &finished_during_wait,
            "b",
            TrackingState::Failed,
            PUSH_MS + 1_000,
            Some(PUSH_MS + 4 * HOUR_MS),
        );
        let (verdict, _) =
            run_from(&finished_during_wait, 540, PUSH_MS + 4 * HOUR_MS - 1_000, |_| {});
        assert_eq!(verdict.outcome, WaitOutcome::Failed);
    }

    #[test]
    fn ages_are_described_in_minutes_hours_and_days() {
        assert_eq!(describe_age(61 * MINUTE_MS), "61 min ago");
        assert_eq!(describe_age(3 * HOUR_MS + 59 * MINUTE_MS), "3 h ago");
        assert_eq!(describe_age(49 * HOUR_MS), "2 days ago");
        assert_eq!(describe_age(-5), "0 min ago");
    }

    #[test]
    fn after_a_fetch_the_newest_recent_tracking_is_used() {
        let fixture = fixture("b");
        fetch_after_push(&fixture);
        let started_ms = PUSH_MS + MINUTE_MS;
        insert_at(&fixture, "d", TrackingState::Succeeded, started_ms - HOUR_MS, None);
        let (verdict, _) = run_from(&fixture, 540, started_ms, |_| {});
        assert_eq!(verdict.outcome, WaitOutcome::NoTracking);

        let recent = insert(&fixture, "e", TrackingState::Failed);
        let (verdict, waited) = run_from(&fixture, 540, started_ms, |_| {});
        assert_eq!(verdict.outcome, WaitOutcome::Failed);
        assert_eq!(verdict.tracking, Some(recent));
        assert_eq!(waited, Duration::ZERO);
    }

    #[test]
    fn in_fallback_mode_a_running_tracking_is_never_dropped_for_its_age() {
        let fixture = fixture("b");
        fetch_after_push(&fixture);
        let started_ms = PUSH_MS + 30 * MINUTE_MS;
        for age_ms in [9 * MINUTE_MS + 30_000, 11 * MINUTE_MS, 5 * HOUR_MS] {
            for state in [TrackingState::Building, TrackingState::Delivering] {
                let tracking = insert_at(&fixture, "d", state, started_ms - age_ms, None);
                let (verdict, waited) = run_from(&fixture, 120, started_ms, |_| {});
                assert_eq!(verdict.outcome, WaitOutcome::StillRunning, "{state:?} {age_ms}");
                assert_eq!(verdict.tracking, Some(tracking));
                assert_eq!(waited, secs(120));
            }
        }
    }

    #[test]
    fn finish_prints_every_outcome_on_stdout_and_leaves_stderr_for_errors() {
        let mut failed = tracking_in(TrackingState::Failed);
        failed.failure = Some(TrackingFailure {
            stage: TrackingStage::Build,
            reason: "pipeline failed".to_string(),
            log_excerpt: None,
        });
        let finished = finish(verdict(WaitOutcome::Failed, Some(failed.clone())));
        assert_eq!(finished, Finished { code: 1, stdout: render(&failed), stderr: String::new() });
        let missing = finish(verdict(WaitOutcome::NoTracking, None));
        assert_eq!(missing.code, 3);
        assert_eq!(missing.stderr, "");
        assert_eq!(missing.stdout, format!("abeon-code: {NOT_STARTED_NOTICE}"));
    }

    #[test]
    fn status_prints_the_newest_tracking_of_the_working_directorys_repository() {
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        std::fs::create_dir_all(dir.path().join("api/src")).unwrap();
        let conn = conn();
        projects_repo::insert(&conn, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        let repo = dir.path().join("api").canonicalize().unwrap();
        let repo_path = repo.to_string_lossy().to_string();

        assert_eq!(
            status_text(&conn, &dir.path().join("api/src")).unwrap(),
            "abeon-code: no deployment tracked for this repository"
        );

        let mut older = Tracking::new(&flow_at(&repo_path), &sha("a"), 1);
        older.state = TrackingState::Succeeded;
        deploy_trackings_repo::insert(&conn, &older).unwrap();
        let mut newer = Tracking::new(&flow_at(&repo_path), &sha("b"), 2);
        newer.state = TrackingState::Building;
        deploy_trackings_repo::insert(&conn, &newer).unwrap();
        assert_eq!(
            status_text(&conn, &dir.path().join("api/src")).unwrap(),
            render(&newer)
        );
    }

    #[test]
    fn status_of_a_folder_project_lists_each_repository_and_wait_wants_one() {
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        init_repo(&dir.path().join("web"));
        let conn = conn();
        projects_repo::insert(&conn, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        let api = dir.path().join("api").canonicalize().unwrap().to_string_lossy().to_string();
        let mut tracking = Tracking::new(&flow_at(&api), &sha("a"), 1);
        tracking.state = TrackingState::Failed;
        deploy_trackings_repo::insert(&conn, &tracking).unwrap();

        let text = status_text(&conn, dir.path()).unwrap();
        assert!(text.starts_with("repository: api\nstate: failed"), "{text}");
        assert!(
            text.contains("\n\nrepository: web\nabeon-code: no deployment tracked"),
            "{text}"
        );

        let error = single_repo(&conn, dir.path()).unwrap_err();
        assert!(error.contains("several repositories"), "{error}");
        assert_eq!(single_repo(&conn, &dir.path().join("api")).unwrap(), api);
    }

    #[test]
    fn status_and_wait_refuse_a_directory_outside_registered_projects() {
        let outside = tempdir().unwrap();
        init_repo(outside.path());
        let conn = conn();
        let expected = format!(
            "{} is not inside a repository of an AbeonCode project",
            outside.path().display()
        );
        assert_eq!(status_text(&conn, outside.path()).unwrap_err(), expected);
        assert_eq!(single_repo(&conn, outside.path()).unwrap_err(), expected);
    }
}

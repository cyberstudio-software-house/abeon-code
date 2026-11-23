# Deployment Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop app follows every push to a repository's production branch through CI and the cluster rollout, shows the result per project, and lets the user or an agent define that flow per repository.

**Architecture:** A new Rust module `src-tauri/src/deploy/` holds a pure state machine (`machine.rs`) fed by observations from thin adapters that shell out to `bkt`, `gh`, `kubectl` and `nmcli` through one `CommandRunner` trait. A runtime (`tracker.rs`) polls reflogs and the adapters on tokio tasks, persists flows, proposals and trackings in SQLite, and emits one `deploy://changed` event that the React side reloads from. The CLI (`abeon-code flow …`, `abeon-code deploy …`) reads and writes the same SQLite file and pings the app over the existing supervisor socket.

**Tech Stack:** Rust (Tauri 2, tokio, rusqlite, git2, serde, ts-rs, chrono), React 19 + Zustand 5 + Tailwind 4, Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-11-23-deployment-tracking-design.md`

## Global Constraints

- All paths below are relative to `DesktopApp/` unless they start with `docs/`.
- Identifiers in English; user-facing UI text in Polish. No code comments. No co-author trailer; Conventional Commits with scope `desktop`.
- Every Rust command has a typed wrapper in `src/lib/tauri.ts`; components never call `invoke` directly.
- Types crossing IPC are defined in Rust with `#[derive(TS)]`, `#[ts(export, export_to = "../../src/types/")]`, `#[serde(rename_all = "camelCase")]`; `i64` fields carry `#[ts(type = "number")]`. After `cargo test` regenerates them, add each new type to the barrel `src/types/index.ts` by hand.
- Commands are `#[tauri::command(async)]` or `async fn`. Nothing in this feature may run a child process or a blocking wait on the main thread (the compositor disconnects a blocked client).
- Child processes are started without a shell, with arguments as a list, and with a timeout.
- Only production is tracked: one production branch and one namespace per repository flow.
- The tracker only reads, except `nmcli connection up <name>` (Linux only).
- A cluster the app cannot reach, or a missing tool, is never a failed deployment.
- Success: one quiet desktop notification, nothing on Discord.
- Time values (spec §4): build poll 15 s, cluster poll 10 s, no CI run within 5 min → stalled, no rollout within 15 min after the build → stalled, paused kept 24 h, proposal expiry 24 h.
- Polish copy fixed by the spec: „Przepływ wdrożenia”, „Wykryj z repozytorium”, „Śledź wdrożenia”, „Zatwierdź”, „Otwórz pipeline”, „Spróbuj ponownie”, „Klaster niedostępny”, „Nie mogę sprawdzić”, „Wyślij do sesji”, „Wdrożono: <projekt>”, states „zastąpione” and „nie widać dalszego ciągu”.
- Run Rust tests with `cd DesktopApp/src-tauri && cargo test <filter>`, UI tests with `cd DesktopApp && npx vitest run --maxWorkers=3 <file>`, type check with `cd DesktopApp && npm run lint`.

## Review Focus

1. **A CI run for the same commit on another ref** (a pull-request pipeline, a tag build): the tracker must follow only the run whose branch is the production branch. Test in Task 4.
2. **The app restarts in the middle of a tracking, or starts with old pushes in the reflog:** unfinished trackings resume; pushes that happened before the app first saw the reflog start nothing; a push made while the app was closed is not tracked retroactively. Tests in Tasks 6 and 8.
3. **The cluster is unreachable when the tracking starts** (VPN off), so the baseline images are captured only after the build finished: the delivery stage must still be able to succeed. Test in Task 7.
4. **A workload name in the flow does not exist in the namespace:** the stage shows „Nie mogę sprawdzić” with the reason at once, not „nie widać dalszego ciągu” after 15 minutes. Tests in Tasks 5 and 7.
5. **Hostile or odd flow values** (a namespace such as `x; rm -rf ~`, a branch starting with `-`, a repository path with spaces): rejected on save for argument values, and passed intact as one argument for paths. Tests in Tasks 1 and 4.

---

## File Structure

Backend (`src-tauri/src/`):

| File | Responsibility |
|------|----------------|
| `db/migrations/008_deploy.sql` | tables `deploy_flows`, `deploy_flow_proposals`, `deploy_trackings` |
| `domain/deploy.rs` | IPC types: `DeployFlow`, `RepoFlow`, `FlowProposal`, `Tracking`, `TrackingView`, enums, `ToolStatus` |
| `deploy/mod.rs` | module list, event name, time constants |
| `deploy/validate.rs` | flow validation |
| `deploy/repos.rs` | repositories of a project, repository for a working directory |
| `deploy/detect.rs` | detection of a flow from a repository |
| `deploy/runner.rs` | `CommandRunner` trait, real and fake implementations |
| `deploy/ci/{mod,bitbucket,github}.rs` | CI observation and failure log |
| `deploy/excerpt.rs` | log tail and redaction |
| `deploy/cluster.rs` | `kubectl` observation |
| `deploy/vpn.rs` | `nmcli` |
| `deploy/reflog.rs` | reading the newest push from a reflog |
| `deploy/machine.rs` | pure state machine |
| `deploy/tracker.rs` | runtime: polling, persistence, events |
| `deploy/notify.rs` | desktop and Discord messages |
| `deploy/proposals.rs` | create, expire and resolve proposals |
| `db/deploy_flows_repo.rs`, `db/deploy_proposals_repo.rs`, `db/deploy_trackings_repo.rs` | SQL |
| `commands/deploy.rs` | Tauri commands |
| `cli/flow.rs`, `cli/deploy.rs` | `abeon-code flow …`, `abeon-code deploy …` |

Frontend (`src/`):

| File | Responsibility |
|------|----------------|
| `store/deploySlice.ts` | trackings, proposals, flows per project, actions |
| `lib/useDeploySync.ts` | listens to `deploy://changed`, reloads |
| `lib/deployStatus.ts` | labels, tone and priority of a tracking |
| `components/deploy/DeployFlowSection.tsx` | the flow form inside the project edit dialog |
| `components/deploy/DeployStatusChip.tsx` | compact status (sidebar row, header) |
| `components/deploy/DeployDetailsDialog.tsx` | stages, links, log, retry, send to session |
| `components/deploy/DeployBanner.tsx` | paused-pipeline banner in the header |
| `components/deploy/FlowProposalCard.tsx` | confirmation of an agent proposal |
| `components/settings/categories/DeployCategory.tsx` | VPN connection name, tool status |

---

### Task 1: Flow types, validation and storage

**Files:**
- Create: `src-tauri/src/db/migrations/008_deploy.sql`, `src-tauri/src/domain/deploy.rs`, `src-tauri/src/deploy/mod.rs`, `src-tauri/src/deploy/validate.rs`, `src-tauri/src/db/deploy_flows_repo.rs`
- Modify: `src-tauri/src/db/mod.rs` (register migration 008 the way 001–007 are registered, add the repo module), `src-tauri/src/domain/mod.rs`, `src-tauri/src/lib.rs` (`mod deploy;`), `src/types/index.ts`

**Interfaces:**
- Produces:

```rust
pub enum BuildProvider { Bitbucket, Github, None }
pub enum Delivery { Image, Kubemeter, None }
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
    pub updated_at: i64,
}
pub fn validate::validate_flow(flow: &DeployFlow) -> Result<(), Vec<FlowError>>;
pub struct FlowError { pub field: String, pub message: String }
pub fn deploy_flows_repo::get(conn: &Connection, repo_path: &str) -> AppResult<Option<DeployFlow>>;
pub fn deploy_flows_repo::list_enabled(conn: &Connection) -> AppResult<Vec<DeployFlow>>;
pub fn deploy_flows_repo::upsert(conn: &Connection, flow: &DeployFlow) -> AppResult<DeployFlow>;
pub fn deploy_flows_repo::delete(conn: &Connection, repo_path: &str) -> AppResult<()>;
```

`deploy_flows` is keyed by `repo_path` (TEXT PRIMARY KEY); `workloads` is stored as a JSON array; `upsert` sets `updated_at` to now in milliseconds. The migration also creates the two tables used later: `deploy_trackings` (columns in Task 7) and `deploy_flow_proposals` (`id` TEXT PRIMARY KEY, `repo_path` TEXT NOT NULL UNIQUE, `body` TEXT NOT NULL holding the proposed flow as JSON, `created_at` INTEGER, `expires_at` INTEGER).

Validation rules (messages in Polish, `field` is the camelCase field name):
- `remote`, `productionBranch`: non-empty, match `^[A-Za-z0-9][A-Za-z0-9._/-]*$`, no `..`.
- `buildRepo`: required unless `build` is `None`; matches `^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$`.
- `namespace`: required unless `delivery` is `None`; matches `^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$`.
- each workload: matches `^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$`; at most 20.
- `kubeContext`: when present, matches `^[A-Za-z0-9][A-Za-z0-9._@:/-]*$`.
- `repoPath`: absolute.

- [ ] **Step 1: Write the failing tests** in `deploy/validate.rs` and `db/deploy_flows_repo.rs`

```rust
#[test]
fn accepts_a_complete_bitbucket_image_flow() {
    assert_eq!(validate_flow(&flow()), Ok(()));
}

#[test]
fn rejects_values_that_could_change_a_command() {
    for (field, value) in [
        ("namespace", "x; rm -rf ~"),
        ("namespace", "--all-namespaces"),
        ("productionBranch", "-f"),
        ("productionBranch", "a..b"),
        ("buildRepo", "ws/repo/../x"),
        ("kubeContext", "$(id)"),
    ] {
        let errors = validate_flow(&flow_with(field, value)).unwrap_err();
        assert!(errors.iter().any(|e| e.field == field), "{field}={value}");
    }
}

#[test]
fn namespace_and_build_repo_are_optional_when_the_stage_is_off() {
    let mut f = flow();
    f.build = BuildProvider::None;
    f.build_repo = String::new();
    f.delivery = Delivery::None;
    f.namespace = String::new();
    assert_eq!(validate_flow(&f), Ok(()));
}

#[test]
fn upsert_round_trips_and_list_enabled_skips_disabled() {
    let conn = conn();
    let saved = upsert(&conn, &flow_at("/r/a")).unwrap();
    let mut off = flow_at("/r/b");
    off.enabled = false;
    upsert(&conn, &off).unwrap();
    assert_eq!(get(&conn, "/r/a").unwrap(), Some(saved.clone()));
    assert_eq!(list_enabled(&conn).unwrap(), vec![saved]);
    delete(&conn, "/r/a").unwrap();
    assert_eq!(get(&conn, "/r/a").unwrap(), None);
}
```

`flow()` is the test helper used across this plan: repo `/r/a`, enabled, remote `origin`, `Bitbucket`, `cybercode/hr-management`, branch `master`, `Image`, namespace `cs-app-hs`, workloads `["app"]`, no context.

- [ ] **Step 2: Run** `cargo test deploy::validate` and `cargo test deploy_flows_repo`. Expected: compile failure, the items do not exist.
- [ ] **Step 3: Implement** the migration, the types, `validate_flow` and the repo. Use the `tempfile` + `init_pool` pattern from `cli/notes.rs` tests for `conn()`.
- [ ] **Step 4: Run** the same commands and `cargo test db::` (the migration tests count versions). Expected: PASS; update the expected schema version in `db/mod.rs` tests to 8.
- [ ] **Step 5: Commit** `feat(desktop): add deployment flow types, validation and storage`

---

### Task 2: Repositories of a project and flow detection

**Files:**
- Create: `src-tauri/src/deploy/repos.rs`, `src-tauri/src/deploy/detect.rs`
- Modify: `src-tauri/src/git/mod.rs` (expose the directory walk of the private `discover_repos` as a path-only function)

**Interfaces:**
- Consumes: `DeployFlow`, `BuildProvider`, `Delivery` (Task 1).
- Produces:

```rust
pub fn git::repo_roots(path: &Path) -> Vec<PathBuf>;
pub fn repos::project_repos(project: &Project) -> Vec<PathBuf>;
pub fn repos::repo_for_dir(dir: &Path) -> Option<PathBuf>;
pub fn repos::projects_of_repo(projects: &[Project], repo: &Path) -> Vec<i64>;
pub fn repos::is_known_repo(projects: &[Project], repo: &Path) -> bool;
pub fn detect::detect_flow(repo: &Path) -> DeployFlow;
pub fn detect::parse_remote_url(url: &str) -> Option<(BuildProvider, String)>;
```

`repo_roots` returns the path itself when it is a repository, otherwise the direct child directories that are repositories (the same rule `discover_repos` applies today), canonicalised and sorted. `repo_for_dir` uses `git2::Repository::discover` and returns the work tree root. `projects_of_repo` returns the ids of projects whose path equals the repository or is its parent directory.

`detect_flow` returns a flow with `enabled: true`, empty `namespace` and `workloads`, `delivery: Image` when a build provider was found and `None` otherwise, and:
- `remote`: the only remote, else `origin`, else the first one alphabetically;
- `build`: `Bitbucket` when `bitbucket-pipelines.yml` exists at the root, else `Github` when `.github/workflows/` holds a `.yml`/`.yaml` file, else `None`; when both exist, the one matching the remote host wins;
- `build_repo`: from the remote URL when its host matches the provider (`bitbucket.org`, `github.com`), else empty;
- `production_branch`: `master` or `main`, whichever the remote has a remote-tracking ref for (`refs/remotes/<remote>/<name>`); when both or neither exist, the one named in the pipeline file's `branches:` block, else `main`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn parses_ssh_and_https_remote_urls() {
    assert_eq!(parse_remote_url("git@bitbucket.org:cybercode/hr-management.git"),
        Some((BuildProvider::Bitbucket, "cybercode/hr-management".into())));
    assert_eq!(parse_remote_url("https://user@bitbucket.org/cybercode/hr-management"),
        Some((BuildProvider::Bitbucket, "cybercode/hr-management".into())));
    assert_eq!(parse_remote_url("https://github.com/cyberstudio-software-house/abeon-code.git"),
        Some((BuildProvider::Github, "cyberstudio-software-house/abeon-code".into())));
    assert_eq!(parse_remote_url("ssh://git@example.com/a/b.git"), None);
}

#[test]
fn detects_a_bitbucket_repository_and_ignores_dev_branches() {
    let repo = repo_with_remote("origin", "git@bitbucket.org:cybercode/hr-management.git");
    write(&repo, "bitbucket-pipelines.yml",
        "pipelines:\n  branches:\n    development:\n      - step: {}\n    master:\n      - step: {}\n");
    remote_ref(&repo, "origin", "master");
    remote_ref(&repo, "origin", "development");
    let flow = detect_flow(repo.path());
    assert_eq!(flow.build, BuildProvider::Bitbucket);
    assert_eq!(flow.build_repo, "cybercode/hr-management");
    assert_eq!(flow.production_branch, "master");
    assert_eq!(flow.delivery, Delivery::Image);
    assert!(flow.namespace.is_empty() && flow.workloads.is_empty());
}

#[test]
fn a_repository_without_ci_gets_no_build_and_no_delivery() {
    let flow = detect_flow(repo_with_remote("origin", "git@example.com:a/b.git").path());
    assert_eq!((flow.build, flow.delivery), (BuildProvider::None, Delivery::None));
}

#[test]
fn a_folder_of_repositories_lists_each_child_repository() {
    let dir = tempdir().unwrap();
    init_repo(&dir.path().join("api"));
    init_repo(&dir.path().join("web"));
    std::fs::create_dir(dir.path().join("docs")).unwrap();
    let names: Vec<_> = repo_roots(dir.path()).iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
    assert_eq!(names, vec!["api", "web"]);
}

#[test]
fn a_repository_inside_a_parent_project_belongs_to_both_projects() {
    let projects = vec![project(1, "/p/hafen"), project(2, "/p/hafen/workshop_asp")];
    assert_eq!(projects_of_repo(&projects, Path::new("/p/hafen/workshop_asp")), vec![1, 2]);
    assert!(!is_known_repo(&projects, Path::new("/elsewhere/repo")));
}
```

- [ ] **Step 2: Run** `cargo test deploy::detect` and `cargo test deploy::repos`. Expected: compile failure.
- [ ] **Step 3: Implement.** Build test repositories with `git2` in a temp dir. Refactor `discover_repos` to call `repo_roots` so the rule lives in one place.
- [ ] **Step 4: Run** the two filters plus `cargo test git::`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): detect a deployment flow from a repository`

---

### Task 3: Flow commands and the settings section

**Files:**
- Create: `src-tauri/src/commands/deploy.rs`, `src/store/deploySlice.ts`, `src/components/deploy/DeployFlowSection.tsx`, `src/components/deploy/DeployFlowSection.test.tsx`
- Modify: `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs` (handler list), `src/lib/tauri.ts`, `src/store/index.ts`, `src/components/dialogs/EditProjectDialog.tsx`, `src/components/dialogs/EditProjectDialog.test.tsx`, `src-tauri/src/domain/deploy.rs`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces (Rust commands, each with a camelCase wrapper of the same name in `tauri.ts`):

```rust
pub struct RepoFlow { pub repo_path: String, pub label: String, pub flow: Option<DeployFlow>, pub proposal: Option<FlowProposal> }
deploy_list_repo_flows(project_id: i64) -> AppResult<Vec<RepoFlow>>
deploy_detect_flow(repo_path: String) -> AppResult<DeployFlow>
deploy_save_flow(flow: DeployFlow) -> AppResult<DeployFlow>
deploy_delete_flow(repo_path: String) -> AppResult<()>
```

`label` is the repository directory name. `proposal` is always `None` until Task 12 (define `FlowProposal { id: String, repo_path: String, flow: DeployFlow, created_at: i64, expires_at: i64 }` now). Every command that takes `repo_path` rejects a path that `repos::is_known_repo` does not accept. `deploy_save_flow` returns `AppError::Other` with the validation messages joined by `; ` when `validate_flow` fails, and emits `deploy://changed` (`DEPLOY_CHANGED_EVENT` in `deploy/mod.rs`, payload `{ repoPath: string | null }`) on success, as does `deploy_delete_flow`.

Store slice:

```ts
export type DeploySlice = {
  repoFlowsByProject: Record<number, RepoFlow[]>;
  loadRepoFlows: (projectId: number) => Promise<void>;
  saveFlow: (projectId: number, flow: DeployFlow) => Promise<void>;
  deleteFlow: (projectId: number, repoPath: string) => Promise<void>;
};
```

`DeployFlowSection` props: `{ projectId: number }`. Behaviour: loads the project's repository flows on mount; with more than one repository shows a „Repozytorium” select first; „Wykryj z repozytorium” calls `deployDetectFlow` and fills the form without saving; „Zapisz przepływ” saves; a project with no repository shows „Ten projekt nie zawiera repozytorium Git.”. Field labels as in the spec's sketch. The repository field of the CI and the fields under „Dostarczenie” are hidden when the respective choice is „brak”. Save errors are shown under the form.

- [ ] **Step 1: Write the failing UI tests** (`DeployFlowSection.test.tsx`), mocking `../../lib/tauri`:
  - `fills the form from detection without saving`: click „Wykryj z repozytorium”, expect the branch input to hold `master` and `deploySaveFlow` not called.
  - `saves the edited flow`: type namespace `cs-app-hs`, click „Zapisz przepływ”, expect `deploySaveFlow` called with `namespace: 'cs-app-hs'` and `repoPath` of the selected repository.
  - `shows a repository picker only for a multi-repository project`.
  - `hides namespace and workloads when delivery is brak`.
  - `shows the backend's validation message`.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=3 src/components/deploy/DeployFlowSection.test.tsx`. Expected: FAIL, module not found.
- [ ] **Step 3: Write the failing Rust test** in `commands/deploy.rs` for the pure helper `fn repo_flows(conn: &Connection, project: &Project) -> AppResult<Vec<RepoFlow>>`: a project folder with two repositories and one saved flow yields two entries, labels `api` and `web`, one with `flow: Some`.
- [ ] **Step 4: Implement** commands, wrappers, slice, component; mount the section in `EditProjectDialog` under the colour picker and widen the dialog to `w-[560px]` with a scrollable body.
- [ ] **Step 5: Run** the Vitest file, `EditProjectDialog.test.tsx`, `cargo test commands::deploy`, `npm run lint`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(desktop): edit the deployment flow in project settings`

---

### Task 4: Command runner and CI adapters

**Files:**
- Create: `src-tauri/src/deploy/runner.rs`, `src-tauri/src/deploy/excerpt.rs`, `src-tauri/src/deploy/ci/mod.rs`, `src-tauri/src/deploy/ci/bitbucket.rs`, `src-tauri/src/deploy/ci/github.rs`

**Interfaces:**
- Consumes: `DeployFlow`, `BuildProvider`.
- Produces:

```rust
pub struct CommandOutput { pub status: Option<i32>, pub stdout: String, pub stderr: String }
pub enum RunError { NotFound, TimedOut, Io(String) }
#[async_trait::async_trait]
pub trait CommandRunner: Send + Sync {
    async fn run(&self, program: &str, args: &[String], timeout: Duration) -> Result<CommandOutput, RunError>;
}
pub struct SystemRunner;
pub struct FakeRunner;            // test support: FakeRunner::new().on(program, args_prefix, result)
impl FakeRunner { pub fn calls(&self) -> Vec<(String, Vec<String>)>; }

pub enum CiStatus { Running, Paused, Failed, Succeeded }
pub struct CiRun { pub id: String, pub build_number: Option<i64>, pub url: String, pub status: CiStatus, pub finished_at: Option<i64> }
pub struct ToolProblem { pub tool: String, pub reason: String }
pub enum CiObservation { NoRun, Run(CiRun), Unavailable(ToolProblem) }
pub async fn ci::observe(runner: &dyn CommandRunner, flow: &DeployFlow, commit: &str) -> CiObservation;
pub async fn ci::failure_log(runner: &dyn CommandRunner, flow: &DeployFlow, run: &CiRun) -> Option<String>;
pub fn excerpt::tail_redacted(text: &str, lines: usize) -> String;
```

If `async-trait` is not yet a dependency, add it. `SystemRunner` uses `tokio::process::Command` with `kill_on_drop(true)` and `tokio::time::timeout`; `NotFound` maps from `io::ErrorKind::NotFound`. All CI calls use a 30 s timeout.

Bitbucket (`bkt`, verified on the user's machine on 2026-11-23: `bkt pipeline list` returns neither the commit nor the branch, `bkt api` does):
- list: `bkt api /repositories/<ws>/<repo>/pipelines/ -P sort=-created_on -P pagelen=30`; keep entries where `target.commit.hash == commit`, `target.ref_type == "branch"` and `target.ref_name == production_branch`; take the newest.
- status: `state.name == "COMPLETED"` with `state.result.name == "SUCCESSFUL"` → `Succeeded`; `COMPLETED` with any other result (`FAILED`, `ERROR`, `STOPPED`, `EXPIRED`) → `Failed`; `state.stage.name` of `PAUSED` or `HALTED` → `Paused`; everything else → `Running`.
- `id` = pipeline `uuid`, `build_number` = `build_number`, `url` = `https://bitbucket.org/<ws>/<repo>/pipelines/results/<build_number>`, `finished_at` = `completed_on` in milliseconds.
- failure log: `bkt api /repositories/<ws>/<repo>/pipelines/<uuid>/steps/`, first step whose `state.result.name` is `FAILED` or `ERROR`, then `bkt pipeline logs <build_number> --workspace <ws> --repo <repo> --step <step uuid>`.

GitHub (`gh`):
- list: `gh run list --repo <owner>/<repo> --commit <sha> --limit 30 --json databaseId,status,conclusion,url,headBranch,updatedAt`; keep `headBranch == production_branch`.
- aggregate over the kept runs: none → `NoRun`; any `status` of `waiting` or `action_required` → `Paused` (that run's id and url); any `status != "completed"` → `Running`; any `conclusion` in `failure`, `cancelled`, `timed_out`, `startup_failure` → `Failed` (that run); otherwise `Succeeded` (the newest run; `finished_at` = latest `updatedAt`).
- failure log: `gh run view <id> --repo <owner>/<repo> --log-failed`.

Both: `RunError::NotFound` → `Unavailable { tool, reason: "nie znaleziono polecenia" }`; a non-zero exit → `Unavailable` with the first non-empty stderr line; unparsable JSON → `Unavailable` with `"nieoczekiwana odpowiedź"`. `build: None` → `ci::observe` is never called (the machine skips the stage).

`tail_redacted` keeps the last `lines` lines, strips ANSI escapes, replaces the value in `KEY=value` / `KEY: value` when the key contains one of `token`, `secret`, `password`, `passwd`, `key`, `auth`, `credential` (case-insensitive) with `***`, replaces `Bearer <x>` and URL user-info (`://user:pass@`) the same way, and caps each line at 400 characters.

- [ ] **Step 1: Write the failing tests** (fixtures inline as JSON strings shaped like the real output)

```rust
#[tokio::test]
async fn bitbucket_follows_only_the_run_on_the_production_branch() {
    let runner = FakeRunner::new().on("bkt", &["api"], ok(BB_LIST_PR_AND_MASTER_SAME_COMMIT));
    let CiObservation::Run(run) = observe(&runner, &flow(), "0b3b32f") else { panic!() };
    assert_eq!(run.build_number, Some(307));
    assert_eq!(run.url, "https://bitbucket.org/cybercode/hr-management/pipelines/results/307");
    assert_eq!(run.status, CiStatus::Succeeded);
}

#[tokio::test]
async fn bitbucket_maps_paused_failed_and_running() {
    for (stage, state, result, expected) in [
        ("PAUSED", "IN_PROGRESS", None, CiStatus::Paused),
        ("RUNNING", "IN_PROGRESS", None, CiStatus::Running),
        ("", "PENDING", None, CiStatus::Running),
        ("", "COMPLETED", Some("FAILED"), CiStatus::Failed),
        ("", "COMPLETED", Some("STOPPED"), CiStatus::Failed),
    ] { /* build one-entry fixture, assert status == expected */ }
}

#[tokio::test]
async fn no_matching_commit_is_no_run() { /* list without the commit → CiObservation::NoRun */ }

#[tokio::test]
async fn a_missing_tool_is_unavailable_not_a_failure() {
    let runner = FakeRunner::new().on("bkt", &["api"], Err(RunError::NotFound));
    assert!(matches!(observe(&runner, &flow(), "abc").await,
        CiObservation::Unavailable(p) if p.tool == "bkt"));
}

#[tokio::test]
async fn github_aggregates_several_workflows_of_one_commit() {
    // two runs on main: one completed/success, one waiting → Paused with the waiting run's url
    // two runs: success + failure → Failed with the failing run's id
    // one run on another branch only → NoRun
}

#[tokio::test]
async fn arguments_are_passed_as_separate_values() {
    let mut f = flow();
    f.build_repo = "cybercode/hr-management".into();
    let runner = FakeRunner::new().on("bkt", &["api"], ok("{\"values\":[]}"));
    observe(&runner, &f, "abc").await;
    let (_, args) = &runner.calls()[0];
    assert_eq!(args[1], "/repositories/cybercode/hr-management/pipelines/");
}

#[test]
fn the_log_tail_hides_secrets() {
    let out = tail_redacted("a\nDOCKER_PASSWORD=hunter2\nAuthorization: Bearer abc.def\nhttps://u:p@host/x\nlast", 4);
    assert!(!out.contains("hunter2") && !out.contains("abc.def") && !out.contains("u:p@"));
    assert!(out.ends_with("last") && !out.starts_with("a\n"));
}
```

- [ ] **Step 2: Run** `cargo test deploy::ci` and `cargo test deploy::excerpt`. Expected: compile failure.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same filters. Expected: PASS.
- [ ] **Step 5: Verify the pause mapping against reality.** In `~/projects/cyberstudio/hs-training`, when a pipeline is waiting on „Approve production release”, run `bkt api /repositories/cybercode/hr-management/pipelines/ -P sort=-created_on -P pagelen=1` and compare `state` with the mapping above. If no paused run is available, record that in the task report; do not trigger a pipeline to produce one.
- [ ] **Step 6: Commit** `feat(desktop): read CI runs for a pushed commit`

---

### Task 5: Cluster observation and VPN

**Files:**
- Create: `src-tauri/src/deploy/cluster.rs`, `src-tauri/src/deploy/vpn.rs`

**Interfaces:**
- Consumes: `CommandRunner`, `ToolProblem`, `DeployFlow`.
- Produces:

```rust
pub struct PodFailure { pub pod: String, pub reason: String }
pub struct WorkloadState {
    pub name: String,
    pub images: Vec<String>,
    pub rollout_complete: bool,
    pub oldest_pod_started_at: Option<i64>,
    pub pods_ready: bool,
    pub failing: Option<PodFailure>,
}
pub enum ClusterObservation { Snapshot(Vec<WorkloadState>), Unreachable, Unavailable(ToolProblem) }
pub async fn cluster::observe(runner: &dyn CommandRunner, flow: &DeployFlow, new_pods_since: i64) -> ClusterObservation;
pub async fn cluster::pod_log(runner: &dyn CommandRunner, flow: &DeployFlow, pod: &str) -> Option<String>;
pub async fn vpn::connect(runner: &dyn CommandRunner, connection: &str) -> bool;
pub fn vpn::supported() -> bool;
```

Commands (prefix `--context <ctx>` when the flow has one; all with `--request-timeout=10s` and a 20 s runner timeout):
- `kubectl -n <ns> get deployments,statefulsets -o json`
- `kubectl -n <ns> get pods -o json`
- `kubectl -n <ns> logs <pod> --all-containers --tail=60`
- `nmcli connection up <name>` (30 s). `vpn::supported()` is `cfg!(target_os = "linux")`; `connect` returns `false` elsewhere without running anything. The connection name is validated with `^[A-Za-z0-9][A-Za-z0-9 ._-]*$` where it is saved (Task 11).

Rules:
- Workloads considered: those named in `flow.workloads`, or every Deployment when the list is empty. A named workload that is absent → `Unavailable { tool: "kubectl", reason: "nie znaleziono zasobu <name> w <ns>" }`.
- `images`: sorted, de-duplicated union of `spec.template.spec.containers[].image`, `initContainers[].image` and `volumes[].csi.volumeAttributes.image`.
- `rollout_complete`: `status.observedGeneration >= metadata.generation` and `updatedReplicas`, `readyReplicas` and `replicas` in `status` all equal `spec.replicas` (missing counts read as 0; `spec.replicas == 0` is complete).
- Pods of a workload: owner `StatefulSet` with that name, or owner `ReplicaSet` whose name is `<workload>-<hash>`.
- `oldest_pod_started_at`: the smallest `status.startTime` among those pods; `pods_ready`: every such pod has condition `Ready=True` and there is at least one.
- `failing`: a pod created after `new_pods_since` with a container (or init container) waiting with reason `CrashLoopBackOff`, `ImagePullBackOff`, `ErrImagePull`, `CreateContainerConfigError` or `InvalidImageName`.
- `Unreachable`: runner `TimedOut`, or stderr containing any of `Unable to connect to the server`, `dial tcp`, `i/o timeout`, `no route to host`, `connection refused`, `context deadline exceeded`, `no such host`. `NotFound` → `Unavailable("nie znaleziono polecenia")`. Any other non-zero exit → `Unavailable` with the first stderr line.

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test]
async fn reads_images_from_containers_and_csi_volumes() {
    // deployment "app": containers nginx:1.27, php-fpm:8.3, csi volume image repo/app:1.1.306
    let ClusterObservation::Snapshot(w) = observe(&runner(DEPLOY_CSI, PODS_READY), &flow(), 0).await else { panic!() };
    assert_eq!(w[0].images, vec!["nginx:1.27", "php-fpm:8.3", "repo/app:1.1.306"]);
    assert!(w[0].rollout_complete && w[0].pods_ready);
}

#[tokio::test]
async fn a_rollout_in_progress_is_not_complete() { /* updatedReplicas 1 of 2 → rollout_complete == false */ }

#[tokio::test]
async fn a_crash_looping_new_pod_is_reported_and_an_old_one_is_not() {
    // pod created at t=2000 in CrashLoopBackOff: failing with new_pods_since=1000, None with new_pods_since=3000
}

#[tokio::test]
async fn a_missing_named_workload_is_unavailable_with_its_name() {
    let mut f = flow();
    f.workloads = vec!["api".into()];
    assert!(matches!(observe(&runner(DEPLOY_CSI, PODS_READY), &f, 0).await,
        ClusterObservation::Unavailable(p) if p.reason.contains("api")));
}

#[tokio::test]
async fn connection_errors_are_unreachable() {
    for stderr in ["Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout",
                   "The connection to the server x was refused - connection refused"] {
        assert_eq!(observe(&failing_runner(stderr), &flow(), 0).await, ClusterObservation::Unreachable);
    }
    assert!(matches!(observe(&failing_runner("error: You must be logged in to the server (Unauthorized)"), &flow(), 0).await,
        ClusterObservation::Unavailable(_)));
}

#[tokio::test]
async fn the_context_flag_is_added_only_when_set() { /* assert on FakeRunner::calls() */ }
```

- [ ] **Step 2: Run** `cargo test deploy::cluster`. Expected: compile failure.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test deploy::cluster` and `cargo test deploy::vpn`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): read rollout state from the cluster`

---

### Task 6: Push detection from the reflog

**Files:**
- Create: `src-tauri/src/deploy/reflog.rs`

**Interfaces:**
- Consumes: `DeployFlow`.
- Produces:

```rust
pub struct PushEntry { pub commit: String, pub at: i64 }
pub fn reflog::reflog_path(repo: &Path, remote: &str, branch: &str) -> Option<PathBuf>;
pub fn reflog::latest_push(reflog: &Path) -> Option<PushEntry>;
pub struct PushDetector;
impl PushDetector {
    pub fn new() -> Self;
    pub fn poll(&mut self, flows: &[DeployFlow]) -> Vec<(DeployFlow, PushEntry)>;
}
```

`reflog_path` resolves `<common git dir>/logs/refs/remotes/<remote>/<branch>` through `git2` (`Repository::commondir`), so linked worktrees work. `latest_push` reads the last line of the file; a reflog line is `<old> <new> <name> <email> <unix ts> <tz>\t<message>`. It returns the entry only when the message starts with `update by push` and `<new>` is not all zeros; `at` is the timestamp in milliseconds.

`PushDetector::poll` is called every 3 s by the tracker. For each enabled flow it remembers the last seen `(commit, at)` per repository path. The first time it sees a repository (app start, a flow just enabled) it records the current value and reports nothing. Afterwards it reports an entry when it differs from the remembered one. A repository whose flow disappears from the list is forgotten.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn reads_the_newest_push_and_ignores_a_fetch() {
    let file = reflog(&[
        "0000000000000000000000000000000000000000 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa P S <p@x> 1795006808 +0100\tupdate by push",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb P S <p@x> 1795009011 +0100\tupdate by push",
    ]);
    assert_eq!(latest_push(&file), Some(PushEntry { commit: "b".repeat(40), at: 1795009011000 }));
    append(&file, "bbbb… cccc… P S <p@x> 1795009999 +0100\tfetch origin: fast-forward");
    assert_eq!(latest_push(&file), None);
}

#[test]
fn a_name_with_spaces_and_a_deleted_branch_do_not_confuse_the_parser() {
    // "Jan Maria Kowalski" as the name still yields the right commit;
    // new sha of 40 zeros (branch deleted by push) yields None
}

#[test]
fn pushes_from_before_the_first_poll_start_nothing() {
    let (repo, flow) = repo_with_push("a");
    let mut detector = PushDetector::new();
    assert!(detector.poll(&[flow.clone()]).is_empty());
    assert!(detector.poll(&[flow.clone()]).is_empty());
    push(&repo, "b");
    let found = detector.poll(&[flow.clone()]);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].1.commit, "b".repeat(40));
    assert!(detector.poll(&[flow]).is_empty());
}

#[test]
fn a_repository_that_was_never_pushed_reports_its_first_push() {
    // no reflog file on the first poll → remembered as "none"; file appears → reported
}

#[test]
fn a_repository_path_with_spaces_is_read() { /* tempdir "my repo" */ }
```

- [ ] **Step 2: Run** `cargo test deploy::reflog`. Expected: compile failure.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test deploy::reflog`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): detect pushes to the production branch from the reflog`

---

### Task 7: Tracking state machine and storage

**Files:**
- Create: `src-tauri/src/deploy/machine.rs`, `src-tauri/src/db/deploy_trackings_repo.rs`
- Modify: `src-tauri/src/domain/deploy.rs`, `src-tauri/src/db/mod.rs`, `src-tauri/src/deploy/mod.rs` (constants), `src/types/index.ts`

**Interfaces:**
- Consumes: `CiObservation`, `CiRun`, `CiStatus`, `ClusterObservation`, `WorkloadState`, `ToolProblem`, `DeployFlow`, `Delivery`, `BuildProvider`.
- Produces:

```rust
pub enum TrackingState { WaitingForRun, Building, Paused, Delivering, Succeeded, Failed, Stalled, Superseded }
pub enum TrackingStage { Build, Delivery }
pub enum Blocker { ClusterUnreachable, ToolUnavailable { tool: String, reason: String } }
pub struct TrackingFailure { pub stage: TrackingStage, pub reason: String, pub log_excerpt: Option<String> }
pub struct Tracking {
    pub id: i64,
    pub repo_path: String,
    pub branch: String,
    pub commit: String,
    pub state: TrackingState,
    pub blocker: Option<Blocker>,
    pub run_id: Option<String>,
    pub run_url: Option<String>,
    pub build_number: Option<i64>,
    pub failure: Option<TrackingFailure>,
    pub baseline_images: Option<Vec<String>>,
    pub baseline_at: Option<i64>,
    pub current_images: Vec<String>,
    pub started_at: i64,
    pub stage_started_at: i64,
    pub build_finished_at: Option<i64>,
    pub finished_at: Option<i64>,
    pub vpn_attempted: bool,
    pub dismissed: bool,
}
impl Tracking { pub fn new(flow: &DeployFlow, commit: &str, now: i64) -> Tracking; pub fn is_open(&self) -> bool; }

pub enum Observation { Ci(CiObservation), Cluster(ClusterObservation), Tick }
pub enum NotifyKind { Paused, Failed, Stalled, Succeeded }
pub enum Effect { Notify(NotifyKind), FetchBuildLog, FetchPodLog { pod: String }, ConnectVpn }
pub struct Step { pub tracking: Tracking, pub effects: Vec<Effect> }
pub fn machine::advance(tracking: &Tracking, flow: &DeployFlow, observation: Observation, now: i64) -> Step;
pub fn machine::needs(tracking: &Tracking, flow: &DeployFlow) -> Needs;   // { ci: bool, cluster: bool }
pub fn machine::supersede(tracking: &Tracking, now: i64) -> Tracking;

deploy_trackings_repo::{insert(&Connection, &Tracking) -> AppResult<Tracking>, update(&Connection, &Tracking) -> AppResult<()>,
    open(&Connection) -> AppResult<Vec<Tracking>>, latest_per_repo(&Connection) -> AppResult<Vec<Tracking>>,
    history(&Connection, repo_path: &str, limit: usize) -> AppResult<Vec<Tracking>>, get(&Connection, id: i64) -> AppResult<Tracking>,
    prune(&Connection, keep_per_repo: usize) -> AppResult<()>}
```

`deploy_trackings` stores scalar columns for the fields used in queries (`id`, `repo_path`, `commit`, `state`, `started_at`, `finished_at`, `dismissed`) and the whole `Tracking` as JSON in a `body` column. `is_open` is true for `WaitingForRun`, `Building`, `Paused`, `Delivering`. `latest_per_repo` returns, per repository, the newest tracking that is open or not dismissed. `prune` keeps the newest 10 closed trackings per repository.

Constants in `deploy/mod.rs`: `RUN_APPEAR_LIMIT = 5 min`, `ROLLOUT_LIMIT = 15 min`, `PAUSE_LIMIT = 24 h`, `BUILD_POLL = 15 s`, `CLUSTER_POLL = 10 s`, `BLOCKED_POLL = 60 s`, `PUSH_POLL = 3 s`.

Machine rules:
- `Tracking::new`: `WaitingForRun` when `flow.build != None`, else `Delivering` with `build_finished_at = now`; when both build and delivery are `None` no tracking is created (the tracker checks this).
- `needs`: `ci` in `WaitingForRun`, `Building`, `Paused`; `cluster` whenever the tracking is open and `delivery != None` (the baseline must be captured while the build runs).
- **Baseline:** the first `Cluster(Snapshot)` sets `baseline_images` (union over workloads) and `baseline_at = now`. Every snapshot updates `current_images`.
- **Blocker:** `Cluster(Unreachable)` sets `ClusterUnreachable` and, the first time, emits `ConnectVpn` and sets `vpn_attempted`. `Unavailable` from either side sets `ToolUnavailable`. Any successful observation of the same side clears the blocker. While a blocker is set or was set during the current stage, time limits measure from the moment it cleared: clearing a blocker sets `stage_started_at = now`. A blocker never changes `state`.
- **Build:** `NoRun` keeps `WaitingForRun`; after `RUN_APPEAR_LIMIT` since `stage_started_at` → `Stalled` + `Notify(Stalled)`. `Run` records `run_id`, `run_url`, `build_number`. `Running` → `Building`. `Paused` → `Paused` and `Notify(Paused)` only on the transition into it; after `PAUSE_LIMIT` → `Stalled`. Leaving `Paused` for `Running` returns to `Building`. `Failed` → `Failed`, failure `{ Build, "Pipeline zakończył się błędem" }`, effects `FetchBuildLog`, `Notify(Failed)`. `Succeeded` → `build_finished_at = run.finished_at.unwrap_or(now)`, then `Succeeded` + `Notify(Succeeded)` when `delivery == None`, else `Delivering` with `stage_started_at = now`.
- **Delivery, `Image`:** succeeded when every workload has `rollout_complete` and either `current_images != baseline_images`, or the baseline was captured after the build finished (`baseline_at > build_finished_at`) and every workload has `pods_ready` with `oldest_pod_started_at > build_finished_at`.
- **Delivery, `Kubemeter`:** succeeded when every workload has `pods_ready` and `oldest_pod_started_at > build_finished_at`.
- **Delivery, both:** any `failing` pod → `Failed`, failure `{ Delivery, "<pod>: <reason>" }`, effects `FetchPodLog`, `Notify(Failed)`. `ROLLOUT_LIMIT` since `stage_started_at` without success → `Stalled` + `Notify(Stalled)`.
- Closed states ignore every observation. `finished_at` is set on entering a closed state. `supersede` sets `Superseded` and `finished_at`, no notification.

- [ ] **Step 1: Write the failing tests** (`machine.rs`; helpers `run(status)`, `snapshot(images, complete)`, `t(seconds)`)

```rust
#[test]
fn the_happy_image_path_ends_with_one_quiet_notification() {
    let f = flow();
    let mut s = step(Tracking::new(&f, "abc", t(0)), &f, Observation::Cluster(snapshot(&["app:1"], true)), t(1));
    s = step(s.tracking, &f, Observation::Ci(CiObservation::Run(run(CiStatus::Running))), t(15));
    assert_eq!(s.tracking.state, TrackingState::Building);
    s = step(s.tracking, &f, Observation::Ci(CiObservation::Run(run(CiStatus::Succeeded))), t(300));
    assert_eq!(s.tracking.state, TrackingState::Delivering);
    assert!(s.effects.is_empty());
    s = step(s.tracking, &f, Observation::Cluster(snapshot(&["app:2"], false)), t(320));
    assert_eq!(s.tracking.state, TrackingState::Delivering);
    s = step(s.tracking, &f, Observation::Cluster(snapshot(&["app:2"], true)), t(340));
    assert_eq!(s.tracking.state, TrackingState::Succeeded);
    assert_eq!(s.effects, vec![Effect::Notify(NotifyKind::Succeeded)]);
}

#[test]
fn a_pause_notifies_once_and_resumes() {
    // Paused twice in a row → exactly one Notify(Paused); then Running → Building
}

#[test]
fn a_failed_build_asks_for_the_log_and_notifies() {
    // effects == [FetchBuildLog, Notify(Failed)], failure.stage == Build
}

#[test]
fn no_run_for_five_minutes_is_stalled_not_failed() {
    // NoRun at t(299) keeps WaitingForRun; NoRun at t(301) → Stalled + Notify(Stalled)
}

#[test]
fn an_unreachable_cluster_blocks_without_failing_and_asks_for_the_vpn_once() {
    // in Delivering: Unreachable at t(10) → blocker ClusterUnreachable, effects [ConnectVpn], state Delivering
    // Unreachable again → no ConnectVpn
    // Tick at t(10 + 16 min) → still Delivering (blocked time does not count)
    // Snapshot at t(2000) clears the blocker and restarts the 15 min limit from t(2000)
}

#[test]
fn a_baseline_captured_after_the_build_still_lets_the_rollout_succeed() {
    // build succeeds at t(300) with the cluster unreachable all along;
    // first Snapshot at t(400) with images already new, pods started at t(350), ready, rollout complete
    // → Succeeded
}

#[test]
fn a_missing_workload_shows_the_reason_and_does_not_stall() {
    // Cluster(Unavailable{kubectl, "nie znaleziono zasobu api w cs-app-hs"}) repeatedly past 15 min
    // → blocker ToolUnavailable with that reason, state Delivering
}

#[test]
fn a_crash_looping_pod_fails_the_delivery_with_its_reason() {
    // failure.reason == "app-7d9f-x: CrashLoopBackOff", effects [FetchPodLog{pod}, Notify(Failed)]
}

#[test]
fn kubemeter_waits_for_pods_restarted_after_the_build() {
    // pods started before build_finished_at → Delivering; after → Succeeded
}

#[test]
fn build_none_goes_straight_to_delivery_and_delivery_none_ends_at_the_build() {}

#[test]
fn closed_trackings_ignore_observations() {}
```

Repo test: `insert`, `update`, `open` returns only open ones, `latest_per_repo` hides a dismissed closed tracking but not an open one, `prune(2)` keeps two closed per repository.

- [ ] **Step 2: Run** `cargo test deploy::machine` and `cargo test deploy_trackings_repo`. Expected: compile failure.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same filters. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): add the deployment tracking state machine`

---

### Task 8: Tracker runtime

**Files:**
- Create: `src-tauri/src/deploy/tracker.rs`
- Modify: `src-tauri/src/lib.rs` (start the tracker in `.setup` after `supervisor::runtime::start`, `app.manage` it), `src-tauri/src/commands/deploy.rs`, `src/lib/tauri.ts`, `src-tauri/src/domain/deploy.rs`, `src/types/index.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces:

```rust
pub trait TrackerSink: Send + Sync {
    fn changed(&self, repo_path: Option<&str>);
    fn notify(&self, kind: NotifyKind, tracking: &Tracking, flow: &DeployFlow);
}
pub struct DeployTracker;
impl DeployTracker {
    pub fn start(app: AppHandle, db: DbPool) -> Arc<DeployTracker>;
    pub fn with_parts(db: DbPool, runner: Arc<dyn CommandRunner>, sink: Arc<dyn TrackerSink>, vpn_name: impl Fn() -> Option<String> + Send + Sync + 'static) -> Arc<DeployTracker>;
    pub async fn tick(&self, now: i64);
    pub fn retry(&self, tracking_id: i64);
    pub fn flows_changed(&self);
}
pub struct TrackingView { pub tracking: Tracking, pub project_ids: Vec<i64>, pub repo_label: String }

deploy_list_trackings() -> AppResult<Vec<TrackingView>>
deploy_tracking_history(repo_path: String) -> AppResult<Vec<TrackingView>>
deploy_retry(tracking_id: i64) -> AppResult<()>
deploy_dismiss(tracking_id: i64) -> AppResult<()>
```

Behaviour of `tick` (the production `start` spawns a tokio task calling it every `PUSH_POLL`):
1. Load enabled flows; `PushDetector::poll`. For each new push: `supersede` the open tracking of that repository if any, insert `Tracking::new`, call `sink.changed`.
2. For each open tracking whose poll is due (`BUILD_POLL` for CI, `CLUSTER_POLL` for the cluster, `BLOCKED_POLL` for a side that currently has a blocker; `retry` makes both due at once): gather the observations `needs` asks for, feed each through `advance`, then one `Tick`.
3. Execute effects: `FetchBuildLog` → `ci::failure_log` → `excerpt::tail_redacted(_, 60)` into `failure.log_excerpt`; `FetchPodLog` → `cluster::pod_log` the same way; `ConnectVpn` → `vpn::connect` with the configured name when `vpn::supported()` and a name is set, then make the cluster poll due; `Notify` → `sink.notify`.
4. Persist changed trackings, `prune(10)`, `sink.changed(repo)` for each change.

A flow that was deleted or disabled while its tracking is open closes the tracking as `Superseded`. On start, open trackings are loaded from the database and continue. Trackings of different repositories are advanced concurrently (`futures::future::join_all`); one slow command must not delay the others. The VPN name is read from the settings key `deployVpnConnection`. `deploy_dismiss` sets `dismissed` on a closed tracking only. The production sink emits `deploy://changed` and, until Task 9, logs notifications with `eprintln!`.

- [ ] **Step 1: Write the failing tests** (`tracker.rs`, with `FakeRunner`, a recording sink, a temp database and real temp git repositories from the Task 6 helpers)

```rust
#[tokio::test]
async fn a_push_starts_a_tracking_and_a_second_push_supersedes_it() {
    // tick (baseline), push "b", tick → one open tracking for "b"; push "c", tick →
    // tracking "b" is Superseded, tracking "c" is open; sink.changed called
}

#[tokio::test]
async fn an_open_tracking_survives_a_restart() {
    // create tracker A, start a tracking, drop A; create tracker B on the same database;
    // B.tick with CI Succeeded + rollout complete → the same tracking id ends Succeeded
}

#[tokio::test]
async fn a_push_made_before_the_app_started_is_not_tracked() {
    // repository already has pushes; new tracker; two ticks → no trackings
}

#[tokio::test]
async fn a_failed_build_stores_a_redacted_log_excerpt_and_notifies_once() {
    // FakeRunner returns a log containing "API_TOKEN=abc"; stored excerpt has no "abc";
    // sink.notify recorded exactly [Failed]
}

#[tokio::test]
async fn the_vpn_is_tried_once_and_only_with_a_configured_name() {
    // unreachable cluster, name Some("wg0") → one "nmcli connection up wg0" call across many ticks;
    // name None → no nmcli call
}

#[tokio::test]
async fn disabling_the_flow_closes_its_open_tracking() {}

#[tokio::test]
async fn polls_respect_their_intervals() {
    // ticks 3 s apart: the CI command runs once per 15 s, the cluster command once per 10 s
}
```

- [ ] **Step 2: Run** `cargo test deploy::tracker`. Expected: compile failure.
- [ ] **Step 3: Implement** the tracker, the four commands with wrappers, and the wiring in `lib.rs`. `deploy_save_flow` / `deploy_delete_flow` call `flows_changed`.
- [ ] **Step 4: Run** `cargo test deploy::` and `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): track deployments after a push`

---

### Task 9: Notifications (desktop and Discord)

**Files:**
- Create: `src-tauri/src/deploy/notify.rs`
- Modify: `src-tauri/src/notifications/desktop.rs`, `src-tauri/src/supervisor/runtime.rs`, `src-tauri/src/deploy/tracker.rs` (production sink)

**Interfaces:**
- Consumes: `NotifyKind`, `Tracking`, `DeployFlow`, `TrackerSink`.
- Produces:

```rust
pub fn notifications::desktop::show_link_notification(app: &AppHandle, title: String, body: String, url: Option<String>);
pub struct DiscordNotice { pub title: String, pub body: String, pub link: Option<(String, String)>, pub buttons: Vec<DiscordButton> }
pub struct DiscordButton { pub label: String, pub custom_id: String, pub primary: bool }
pub async fn supervisor::runtime::post_discord_notice(app: &AppHandle, notice: DiscordNotice) -> bool;
pub struct NoticeText { pub title: String, pub body: String, pub url: Option<String>, pub to_discord: bool }
pub fn notify::notice_text(kind: NotifyKind, tracking: &Tracking, label: &str) -> NoticeText;
pub fn notify::discord_payload(notice: &DiscordNotice) -> serde_json::Value;
```

`show_link_notification`: on Linux a `notify_rust` notification with the `default` action; activating it opens `url` with the opener plugin when present, otherwise raises the main window (reuse `activate_main_window`'s window part). Other platforms: a plain plugin notification.

`post_discord_notice` returns `false` without sending when the supervisor's Discord channel is not live, or when `presence::route(discord_active, present, mute_when_present)` yields `App`. It sends a Components V2 message built by `discord_payload` (wrap with `render::v2_payload`) to the configured DM channel through the live client that `supervisor/discord/buttons.rs` already uses. `discord_payload`: a text display `**<title>**\n<body>`, then one action row holding the link as a link button (`type: 2`, `style: 5`, `url`) followed by `buttons` (`style: 3` when `primary`, else `2`).

`notice_text` (`label` = repository directory name):

| Kind | title | body | url | Discord |
|------|-------|------|-----|---------|
| Paused | `Pipeline czeka na Ciebie: <label>` | `Wdrożenie <short commit> jest wstrzymane do Twojej akceptacji.` | run url | yes |
| Failed | `Wdrożenie nie powiodło się: <label>` | failure reason | run url | yes |
| Stalled | `Wdrożenie utknęło: <label>` | `Nie widać dalszego ciągu po <etap>.` (`budowaniu` / `wypchnięciu`) | run url | yes |
| Succeeded | `Wdrożono: <label>` | `<short commit>` | none | no |

The Discord link label is „Otwórz pipeline”. The production sink calls `show_link_notification` always and `post_discord_notice` when `to_discord`.

- [ ] **Step 1: Write the failing tests** for `notice_text` (the four rows above, exact strings) and `discord_payload` (link button has `style == 5` and the url; a primary button has `style == 3`; with no link and no buttons there is no action row).
- [ ] **Step 2: Run** `cargo test deploy::notify`. Expected: compile failure.
- [ ] **Step 3: Implement.** Read how `supervisor/runtime.rs` holds the live Discord state (around the `DiscordClient::new(config.token)` call) and expose `post_discord_notice` next to it.
- [ ] **Step 4: Run** `cargo test deploy::notify` and `cargo test supervisor::`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): notify about paused, failed and finished deployments`

---

### Task 10: Status in the sidebar and header, details, banner

**Files:**
- Create: `src/lib/deployStatus.ts`, `src/lib/deployStatus.test.ts`, `src/lib/useDeploySync.ts`, `src/components/deploy/DeployStatusChip.tsx`, `src/components/deploy/DeployDetailsDialog.tsx`, `src/components/deploy/DeployBanner.tsx`, tests next to each component
- Modify: `src/store/deploySlice.ts`, `src/components/sidebar/ProjectItem.tsx`, `src/components/layout/AppHeader.tsx`, `src/components/layout/AppShell.tsx` (mount `useDeploySync` once per window shell that shows the sidebar)

**Interfaces:**
- Consumes: `TrackingView`, the Task 8 wrappers.
- Produces:

```ts
// deploySlice additions
trackings: TrackingView[];
loadTrackings: () => Promise<void>;
retryTracking: (id: number) => Promise<void>;
dismissTracking: (id: number) => Promise<void>;

// deployStatus.ts
export type DeployTone = 'running' | 'attention' | 'problem' | 'done' | 'muted';
export function trackingTone(t: Tracking): DeployTone;
export function trackingLabel(t: Tracking): string;
export function trackingPriority(t: Tracking): number;
export function projectTracking(views: TrackingView[], projectId: number): { top: TrackingView; count: number } | null;
```

Labels and tones:

| State / blocker | Label | Tone |
|-----------------|-------|------|
| `waitingForRun` | Czekam na pipeline | running |
| `building` | Budowanie | running |
| `paused` | Pipeline czeka na Ciebie | attention |
| `delivering` | Wdrażanie na klaster | running |
| `succeeded` | Wdrożono | done |
| `failed` | Wdrożenie nie powiodło się | problem |
| `stalled` | Nie widać dalszego ciągu | problem |
| `superseded` | Zastąpione | muted |
| blocker `clusterUnreachable` (any open state) | Klaster niedostępny | problem |
| blocker `toolUnavailable` | Nie mogę sprawdzić | problem |

Priority (highest first): paused, failed, stalled, blocker, open states, succeeded, superseded. `projectTracking` picks the highest-priority view among those whose `projectIds` include the project and returns how many non-dismissed views the project has.

Components:
- `DeployStatusChip { projectId }`: nothing when the project has no tracking; otherwise a dot coloured by tone plus the label (the label is hidden in the sidebar row and shown in a `title`; shown in full in the header), plus `+N` when `count > 1`. Click opens `DeployDetailsDialog`. Tone `attention` uses a filled accent pill that is visually stronger than the session "waiting" marker (`lib/activity.ts` blue).
- `DeployDetailsDialog { projectId, onClose }`: one block per tracking of the project (repository label, short commit, stage lines with times, blocker reason, and the line `Obraz zawiera numer builda <n>` when one of `currentImages` ends with `.<buildNumber>` or `:<buildNumber>`), the log excerpt in a `<pre>` on failure, „Otwórz pipeline” (`openUrl` from `@tauri-apps/plugin-opener`) when `runUrl` exists, „Spróbuj ponownie” when a blocker is set, „Ukryj” for closed trackings, and „Wyślij do sesji” on a failed tracking: a select of the project's open agent sessions and a button that types the summary into the chosen session through the same store action `FileEntryMenu` uses for „Wstaw ścieżkę do sesji”. The summary text: `Wdrożenie <short commit> nie powiodło się na etapie <etap>: <reason>\n\n<log excerpt>`.
- `DeployBanner`: rendered in `AppHeader` when any tracking of the active project is `paused`; text `Pipeline czeka na Twoją akceptację` and the „Otwórz pipeline” button.
- `useDeploySync`: loads trackings on mount and on every `deploy://changed`.

- [ ] **Step 1: Write the failing tests**
  - `deployStatus.test.ts`: label and tone for each row of the table; a blocker overrides the open state's label; `projectTracking` returns the paused view over a succeeded one and `count: 2`; a repository shared by two projects appears for both.
  - `DeployStatusChip.test.tsx`: renders nothing without a tracking; shows `+1` with two; click opens the dialog.
  - `DeployDetailsDialog.test.tsx`: „Otwórz pipeline” calls `openUrl` with `runUrl`; „Spróbuj ponownie” only with a blocker and calls `deployRetry`; „Wyślij do sesji” is disabled with no open session and types the summary otherwise; the log excerpt is rendered.
  - `DeployBanner.test.tsx`: visible only for a paused tracking of the active project.
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=3 src/lib/deployStatus.test.ts src/components/deploy`. Expected: FAIL.
- [ ] **Step 3: Implement**, then mount the chip in `ProjectItem` (right side of the project row) and in `AppHeader`, and the banner in `AppHeader`.
- [ ] **Step 4: Run** the same Vitest command, the existing `Sidebar.test.tsx`, and `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): show deployment status per project`

---

### Task 11: Settings — VPN connection and tool status

**Files:**
- Create: `src/components/settings/categories/DeployCategory.tsx`, `DeployCategory.test.tsx`
- Modify: `src/lib/settingsCategories.ts` (category id `deploy`, label „Wdrożenia”, in the `integrations` group, keywords `vpn`, `pipeline`, `kubectl`, `wdrożenie`), `src/components/settings/SettingsView.tsx`, `src-tauri/src/commands/deploy.rs`, `src/lib/tauri.ts`, `src-tauri/src/domain/deploy.rs`, `src/types/index.ts`

**Interfaces:**
- Produces:

```rust
pub struct ToolStatus { pub tool: String, pub found: bool, pub detail: String }
deploy_tools_status() -> AppResult<Vec<ToolStatus>>      // bkt, gh, kubectl, nmcli (nmcli only on Linux)
deploy_get_vpn_connection() -> AppResult<Option<String>>
deploy_set_vpn_connection(name: Option<String>) -> AppResult<()>
```

`deploy_tools_status` runs `<tool> --version` through `SystemRunner` (5 s) and reports the first output line as `detail`, or `nie znaleziono` when missing. `deploy_set_vpn_connection` trims, stores under settings key `deployVpnConnection`, deletes the key for `None`/empty, and rejects a name that does not match `^[A-Za-z0-9][A-Za-z0-9 ._-]*$` with „Nazwa połączenia zawiera niedozwolone znaki”.

UI: section „Połączenie VPN” with a text field „Nazwa połączenia w NetworkManagerze” and the hint „Gdy klaster jest niedostępny, aplikacja spróbuje włączyć to połączenie i dokończy sprawdzanie wdrożenia.”; on non-Linux the field is replaced by „Automatyczne łączenie z VPN działa tylko na Linuksie.”. Section „Narzędzia” lists the four tools with found / not found and the detail.

- [ ] **Step 1: Write the failing tests**: UI (saves the trimmed name on blur; shows the backend error; lists tool statuses) and Rust (`set` then `get` round-trips; an invalid name is rejected; empty clears).
- [ ] **Step 2: Run** `npx vitest run --maxWorkers=3 src/components/settings/categories/DeployCategory.test.tsx` and `cargo test commands::deploy`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same commands plus `SettingsView.test.tsx` and `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): add deployment settings for the VPN and tools`

---

### Task 12: `abeon-code flow` and proposal confirmation

**Files:**
- Create: `src-tauri/src/cli/flow.rs`, `src-tauri/src/deploy/proposals.rs`, `src-tauri/src/db/deploy_proposals_repo.rs`, `src/components/deploy/FlowProposalCard.tsx`, `FlowProposalCard.test.tsx`
- Modify: `src-tauri/src/cli/mod.rs`, `src-tauri/src/lib.rs` (call `cli::flow::try_run` next to `cli::notes::try_run`), `src-tauri/src/supervisor/ipc.rs` (`IpcRequest::DeployChanged`, answered with `Ack` like `NotesChanged`), `src-tauri/src/supervisor/runtime.rs` (handle it: expire proposals, emit `deploy://changed`, send the Discord confirmation), `src-tauri/src/supervisor/discord/interactions.rs` and `registry.rs` (route the two custom ids), `src-tauri/src/commands/deploy.rs`, `src/lib/tauri.ts`, `src/store/deploySlice.ts`, `src/components/layout/AppShell.tsx`

**Interfaces:**
- Consumes: `DeployFlow`, `FlowProposal`, `validate_flow`, `detect_flow`, `repos::repo_for_dir`, `repos::is_known_repo`, `post_discord_notice`.
- Produces:

```rust
pub fn proposals::create(conn: &Connection, flow: DeployFlow, now: i64) -> Result<FlowProposal, String>;
pub fn proposals::pending(conn: &Connection, now: i64) -> AppResult<Vec<FlowProposal>>;
pub fn proposals::resolve(conn: &Connection, id: &str, approve: bool, now: i64) -> AppResult<Option<DeployFlow>>;
pub fn proposals::diff(current: Option<&DeployFlow>, proposed: &DeployFlow) -> Vec<FlowChange>;
pub struct FlowChange { pub field: String, pub label: String, pub before: Option<String>, pub after: String }
pub fn cli::flow::try_run(args: &[String]) -> Option<i32>;
deploy_list_proposals() -> AppResult<Vec<ProposalView>>     // { proposal, repoLabel, projectIds, changes }
deploy_resolve_proposal(proposal_id: String, approve: bool) -> AppResult<()>
```

CLI (`--cwd <dir>` accepted like `note`; output prefixed `abeon-code:` for messages; exit 0 on success, 2 on error):
- `abeon-code flow show`: JSON of `{ repoPath, flow, proposal }` for the repository of the working directory, or an array of them when the directory is a registered project that is a folder of repositories.
- `abeon-code flow detect`: JSON of `detect_flow` for the repository.
- `abeon-code flow propose`: reads a `DeployFlow` JSON from stdin (camelCase; `repoPath` optional and defaulting to the working directory's repository; `updatedAt` ignored), validates, stores a proposal, pings the app (`IpcRequest::DeployChanged`), prints `abeon-code: proposal <id> is waiting for the user's confirmation in AbeonCode`. Errors: stdin is a terminal → usage; the directory is not inside a repository of a registered project → `… is not inside a repository of an AbeonCode project`; validation errors listed one per line.

`proposals::create` replaces an older pending proposal of the same repository, sets `expires_at = now + 24 h`, `id` = 8 random hex characters. `resolve` on approve upserts the flow and deletes the proposal; on reject deletes it; an expired or unknown id returns `Ok(None)`. `pending` deletes expired rows first. `diff` lists only fields that differ, with Polish labels matching the settings form; a proposal for a repository without a flow lists every field with `before: None`.

Confirmation:
- App: `FlowProposalCard` is rendered by `AppShell` for each pending proposal (stacked, bottom-right, above other content): title `Agent proponuje przepływ wdrożenia: <repoLabel>`, the change list (`<label>: <before> → <after>`), buttons „Zatwierdź” and „Odrzuć”.
- Discord: on `DeployChanged` with a new proposal, `post_discord_notice` with the same title, the change list as body and two buttons with custom ids `abeon:flow:<id>:approve` (primary, „Zatwierdź”) and `abeon:flow:<id>:reject` („Odrzuć”). The gateway already passes `abeon:` interactions to the app; add a `ButtonTarget::FlowProposal { proposal_id, approve }` and resolve it through `proposals::resolve`, replying by editing the message to `Zatwierdzono przepływ: <repoLabel>` / `Odrzucono przepływ: <repoLabel>` / `Propozycja wygasła`.
- Every resolution emits `deploy://changed` and calls `DeployTracker::flows_changed`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_proposal_changes_nothing_until_it_is_approved() {
    let conn = conn();
    let p = create(&conn, flow(), 0).unwrap();
    assert_eq!(deploy_flows_repo::get(&conn, "/r/a").unwrap(), None);
    assert_eq!(resolve(&conn, &p.id, true, 1).unwrap().map(|f| f.namespace), Some("cs-app-hs".into()));
    assert!(deploy_flows_repo::get(&conn, "/r/a").unwrap().is_some());
    assert!(pending(&conn, 2).unwrap().is_empty());
}

#[test]
fn a_rejected_or_expired_proposal_leaves_the_flow_untouched() {
    // reject → flow None; create at 0, resolve at 24 h + 1 ms → Ok(None), flow None
}

#[test]
fn a_newer_proposal_replaces_the_older_one_for_the_same_repository() {}

#[test]
fn an_invalid_proposal_is_refused_with_the_field_names() {
    // namespace "x; rm" → Err containing "namespace"
}

#[test]
fn the_diff_lists_only_changed_fields() {
    // production_branch master → main, everything else equal → one FlowChange { field: "productionBranch", before: Some("master"), after: "main" }
}

#[test]
fn parses_the_three_subcommands_and_rejects_others() {
    // ["abeoncode","flow","show"], ["…","flow","propose","--cwd","/p"], ["…","flow","bogus"] → usage error; ["…","note","list"] → None
}

#[test]
fn propose_rejects_a_directory_outside_registered_projects() {}
```

UI test: the card lists the changes; „Zatwierdź” calls `deployResolveProposal(id, true)`; „Odrzuć” calls it with `false`.

Discord test in `interactions.rs`: custom id `abeon:flow:ab12cd34:approve` decodes to `FlowProposal { proposal_id: "ab12cd34", approve: true }`; a malformed id is ignored.

- [ ] **Step 2: Run** `cargo test deploy::proposals`, `cargo test cli::flow`, `cargo test supervisor::discord`, and the Vitest file. Expected: FAIL.
- [ ] **Step 3: Implement.** Follow `cli/notes.rs` for argument parsing, the database open and the `#[cfg(unix)]` socket ping. Fill `RepoFlow.proposal` in `deploy_list_repo_flows`.
- [ ] **Step 4: Run** the same commands plus `cargo test supervisor::` and `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): let an agent propose a deployment flow for confirmation`

---

### Task 13: `abeon-code deploy status` and `deploy wait`

**Files:**
- Create: `src-tauri/src/cli/deploy.rs`
- Modify: `src-tauri/src/cli/mod.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `deploy_flows_repo`, `deploy_trackings_repo`, `reflog::{reflog_path, latest_push}`, `repos::repo_for_dir`, `Tracking`.
- Produces:

```rust
pub fn cli::deploy::try_run(args: &[String]) -> Option<i32>;
pub fn cli::deploy::render(tracking: &Tracking) -> String;
pub fn cli::deploy::exit_code(outcome: &WaitOutcome) -> i32;
pub enum WaitOutcome { Succeeded, Failed, NeedsUser, StillRunning, NoTracking }
pub fn cli::deploy::wait_outcome(tracking: Option<&Tracking>, waited: Duration, limit: Duration, grace: Duration) -> Option<WaitOutcome>;
```

- `abeon-code deploy status [--cwd <dir>]`: prints `render` of the newest tracking of the working directory's repository, or `abeon-code: no deployment tracked for this repository`. Exit 0.
- `abeon-code deploy wait [--timeout <seconds>] [--cwd <dir>]`: default timeout 540 s (below the 10-minute command limit of agent shells), maximum 3600. It reads the newest push from the reflog of the flow's production branch, then polls the database every 2 s for a tracking of that commit.

`wait_outcome` (returns `None` to keep waiting):
- no tracking for the commit after `grace` (30 s) → `NoTracking`; message: `no tracking started (no flow for this repository, tracking is off, or AbeonCode is not running)`;
- `succeeded` → `Succeeded`; `failed` or `stalled` → `Failed`; `paused` → `NeedsUser`; `superseded` → keep waiting for the tracking of the newer commit (re-read the reflog);
- an open tracking with a blocker set for more than 120 s → `NeedsUser`;
- `waited >= limit` → `StillRunning`.

Exit codes: `Succeeded` 0, `Failed` 1, `NoTracking` 3, `NeedsUser` 4, `StillRunning` 8.

`render` (English, for agents), one field per line: `state`, `commit`, `pipeline` (url), `blocked` (reason), `failure` (stage and reason), then the log excerpt after a blank line. For `NeedsUser` with a paused pipeline it adds: `The pipeline is waiting for the user's approval. Do not try to approve it; tell the user and stop.`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn outcomes_follow_the_tracking_state() {
    let s = |state| tracking_in(state);
    assert_eq!(wait_outcome(Some(&s(TrackingState::Succeeded)), secs(5), secs(540), secs(30)), Some(WaitOutcome::Succeeded));
    assert_eq!(wait_outcome(Some(&s(TrackingState::Stalled)), secs(5), secs(540), secs(30)), Some(WaitOutcome::Failed));
    assert_eq!(wait_outcome(Some(&s(TrackingState::Paused)), secs(5), secs(540), secs(30)), Some(WaitOutcome::NeedsUser));
    assert_eq!(wait_outcome(Some(&s(TrackingState::Building)), secs(5), secs(540), secs(30)), None);
    assert_eq!(wait_outcome(Some(&s(TrackingState::Building)), secs(540), secs(540), secs(30)), Some(WaitOutcome::StillRunning));
    assert_eq!(wait_outcome(None, secs(29), secs(540), secs(30)), None);
    assert_eq!(wait_outcome(None, secs(31), secs(540), secs(30)), Some(WaitOutcome::NoTracking));
}

#[test]
fn exit_codes_are_stable() { /* 0, 1, 3, 4, 8 as listed */ }

#[test]
fn render_includes_the_link_the_reason_and_the_log() {}

#[test]
fn parses_status_and_wait_with_a_bounded_timeout() {
    // "--timeout 99999" → clamped to 3600; "--timeout x" → usage error
}
```

- [ ] **Step 2: Run** `cargo test cli::deploy`. Expected: compile failure.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cargo test cli::`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): add abeon-code deploy status and wait`

---

### Task 14: Skill, documentation and QA checklist

**Files:**
- Modify: `src-tauri/src/cli/skill.rs`, `DesktopApp/CLAUDE.md`, `docs/abeon-code-cli.md`
- Create: `docs/superpowers/specs/2026-11-23-deployment-tracking-qa-checklist.md`

**Interfaces:**
- Consumes: the CLI of Tasks 12–13.
- Produces: `skill::install` writes a third skill directory `abeon-deploy` and returns three paths.

Skill content (English, frontmatter `name: abeon-deploy`). The description must trigger on: setting up or changing how a project deploys ("ustaw przepływ wdrożenia", "skonfiguruj śledzenie wdrożeń", "set up deployment tracking"), and on waiting for a deployment after a push ("sprawdź pipeline", "czy się wdrożyło", "wait for the deploy"). Body, two parts:

1. **After a push to the production branch:** run `abeon-code deploy wait` instead of `sleep` and `bkt`/`gh` polling; the meaning of each exit code; on 8 run it again; on 4 tell the user and stop; on 1 read the log excerpt and fix the cause; on 3 fall back to checking the pipeline the usual way. This replaces any instruction to check the pipeline with `bkt` while working inside AbeonCode.
2. **Setting up a flow:** run `abeon-code flow show` and `abeon-code flow detect`; settle the open values (namespace, workloads, delivery) with the user, looking the namespace up with the Bandzior MCP tools (`project_find`, `project_show`) when available; send the result with `abeon-code flow propose <<'ABEON_FLOW'` followed by the JSON; tell the user the proposal waits for their „Zatwierdź” in AbeonCode or on Discord; never claim the flow is active before `abeon-code flow show` shows it without a pending proposal. Include the JSON field list with allowed values.

`DesktopApp/CLAUDE.md`: add a "Deployment tracking" section (module map, the rule that the state machine is pure and all process calls go through `CommandRunner`, the reflog trigger and why not hooks, the `deploy://changed` event, blocker vs failure, settings keys, CLI and exit codes, the proposal confirmation rule) and mention the new files in the folder map.

QA checklist (Polish, the format of `2026-11-11-file-browser-qa-checklist.md`), at least: flow form and detection on a Bitbucket and a GitHub repository; a multi-repository project; a real push in a test project through to „Wdrożono”; a paused pipeline in `hs-training` (accent, banner, desktop notification click, Discord link); a failed pipeline with the log excerpt and „Wyślij do sesji”; VPN off at push time with and without a configured connection name; app restart during a tracking; `abeon-code deploy wait` from a session; an agent proposal confirmed in the app and on Discord; both themes.

- [ ] **Step 1: Update the failing test** `install_writes_both_skills_and_overwrites` in `cli/skill.rs` to expect three paths, the third being `abeon-deploy/SKILL.md`, whose content starts with `---\nname: abeon-deploy\n` and contains `abeon-code deploy wait` and `abeon-code flow propose`.
- [ ] **Step 2: Run** `cargo test cli::skill`. Expected: FAIL.
- [ ] **Step 3: Implement** the skill and write the three documents.
- [ ] **Step 4: Run the whole suite:** `cd DesktopApp/src-tauri && cargo test`, `cd DesktopApp && npx vitest run --maxWorkers=3`, `npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit** `docs(desktop): document deployment tracking and bundle the abeon-deploy skill`

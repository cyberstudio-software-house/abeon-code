# Deployment tracking and per-project deployment flow — design

Date: 2026-11-23 · App: `DesktopApp/` · Status: draft, read once by an independent builder, waiting for the user's approval

Scope: a per-project description of what happens after a push to the production branch (the
"deployment flow"), a tracker inside the app that follows every such push to its end, and a way for
an agent to set the flow up during a conversation with the user.

This is the first of two related designs. The second one, per-project approval policies for the
supervisor, is written separately and builds on the flow defined here.

## Why

The user works in about 7 projects a day and switches between them about 21 times a day. In the 60
days before this design, roughly 14 % of their prompts were about pushing, 163 about deployments and
49 about pipelines. After a push, each session waits and polls by itself
(`sleep 20 && bkt pipeline list …`), or ends its turn and nobody watches.

In the user's words, the two things that go wrong in practice:

- „Czasami zauważam, że VPN jest wyłączony. Skrypt mógłby spokojnie sam połączyć się z VPN-em i
  zrealizować zadanie do końca.”
- „Problem też stanowią ewentualnie pauzy w pipeline'ach, które wymuszają na mnie reakcję. W takich
  przypadkach przydałby się gdzieś mocniejszy akcent i najlepiej link też do takiego pipeline'a.”

And on configuration: „w ustawieniach projektu też można było definiować takie rzeczy jak przepływ
czy łańcuch, jaki ma dany projekt. Dobrze, żebym też mógł z agentem ustawić taki projekt, czyli
żeby agent ustawił go zgodnie z tym, co ustalimy w trakcie konwersacji.”

## The user's deployment chains (as described by the user)

1. **Bitbucket.** Push to `master`/`main` → Bitbucket pipeline → image pushed to Docker Hub →
   Docker Hub webhook to the management panel (Bandzior) → Bandzior updates the version, Argo rolls
   it out on the cluster.
2. **GitHub.** The same chain; only the build platform differs (GitHub Actions).
3. **Kubemeter (rare).** No image is pushed. The pipeline sends a webhook to Kubemeter with the
   information about the change, and the pod's init container pulls the newest code.

Facts checked on the user's machine on 2026-11-23:

- 26 projects in `~/projects/cyberstudio` have `bitbucket-pipelines.yml`; 9 have GitHub workflows.
- Image tags are derived from the build number, but the scheme differs per project
  (`1.1.${BITBUCKET_BUILD_NUMBER}` in two projects, `1.${BITBUCKET_BUILD_NUMBER}` in `hs-training`).
- `hs-training` and `hs-training-pentests` have a `trigger: manual` step ("Approve production
  release"). These are the pipelines that pause.
- `bkt`, `gh` and `kubectl` are installed and authenticated; `argocd` is not installed. `bkt
  pipeline` offers `list`, `view`, `logs` and `run`; it has no command to resume a manual step.
- The VPN is a WireGuard connection managed by NetworkManager (`nmcli`).
- Git records pushes in the reflog of the remote-tracking branch
  (`.git/logs/refs/remotes/<remote>/<branch>`, message `update by push`).
- Some projects have no cluster target at all. AbeonCode itself ends in a GitHub release.

## Goals

- A push to a project's production branch is followed to the end without the user or a session
  watching it.
- The user sees, per project, where the deployment is and how it ended.
- A paused pipeline is impossible to miss and is one click away.
- A switched-off VPN does not stop the tracking: the app connects it and carries on.
- The flow of a project can be set in the project's settings, detected from the repository, or set
  by an agent after a conversation with the user.

## Non-goals (this version)

- Approval policies for the supervisor (separate design).
- Resuming a paused pipeline from inside the app or from Discord. The app links to the pipeline.
- Talking to Argo or Bandzior directly. The cluster state is read with `kubectl`.
- Projects deployed outside the cluster (shared hosting).
- Connecting a VPN on Windows and macOS. There the app only reports that the cluster is unreachable.
- Rollbacks or any other write to the cluster, the CI or Bandzior. The tracker only reads, with one
  exception: bringing the VPN connection up.

## Anti-goals

- A deployment reported as failed because the VPN was off or a tool was missing.
- Notifications for every stage. A successful deployment produces one quiet message.
- Model tokens spent on waiting or polling.
- An agent changing a project's flow without the user confirming it.

## Approaches

1. **Tracker inside the app (chosen).** A Rust module polls the CI and the cluster with the
   installed tools and emits events to the UI, the notifications and the supervisor. No tokens,
   works with the supervisor switched off, survives the end of the session and an app restart.
2. **The supervisor agent tracks.** The supervisor session runs the commands itself. Cheap to
   build, but it costs tokens on every poll, depends on the supervisor being on, and the
   supervisor's permissions are deliberately narrow.
3. **A script started by the session.** A skill tells the session to launch a background watcher
   after a push. It dies with the session and gives no cross-project view.

The user left the choice of approach to Claude; approach 1 is Claude's call.

## Design

### 1. Deployment flow of a repository

A flow belongs to a **git repository**, identified by its root path, not to a project. Reason: 8 of
the user's 57 registered projects are folders holding several repositories with their own pipelines
(yachtic has 7, podyplomowka 4), the project root is then not a repository at all, and some
repositories are registered both as their own project and inside a parent project. A project shows
the flows of all repositories it contains (the app already finds them with `discover_repos`); a
repository reachable from two projects has one flow, visible in both.

One optional flow per repository, stored in SQLite (new migration). Fields:

| Field | Values |
|-------|--------|
| Tracking enabled | on / off |
| Remote | the git remote whose pushes count (default: the only remote, else `origin`) |
| Build | `bitbucket` / `github` / `none` |
| Build repository | workspace + repo slug, or owner + repo; derived from the remote URL, editable |
| Environments | one or more, see below |

An **environment** is where a branch deploys to. About 30 of the user's ~50 Bitbucket pipelines
deploy a second branch (`dev`, `development`, `release-to-dev`, `beta`, …) to a separate dev
namespace, so one namespace per flow is not enough. Each environment has:

| Field | Values |
|-------|--------|
| Name | free label, e.g. „Produkcja”, „Dev” |
| Branch | the branch whose push deploys here |
| Production | yes / no. The approval-policies design reads this flag. |
| Delivery | `image` (Docker Hub → Bandzior → Argo) / `kubemeter` (webhook, init container) / `none` |
| Namespace | Kubernetes namespace (required unless delivery is `none`) |
| Workloads | Deployment / StatefulSet names in that namespace that this repository deploys; empty = all Deployments in the namespace |
| Kube context | optional; empty = the current context |

Every value that ends up as a command argument is validated against a strict character set when
saved, and commands are run without a shell.

A repository without a flow, or with tracking off, behaves exactly as today. A push to a branch
that no environment names is not tracked.

### 2. Three ways to set the flow

**Project settings.** The project edit dialog (today: name and colour) gains a "Przepływ wdrożenia"
section. A project with several repositories gets a repository picker first. Changes made here by
the user take effect immediately. Sketch:

```
Przepływ wdrożenia     Repozytorium [ isp-manager-panel ▾ ]   [ Wykryj z repozytorium ]
  Śledź wdrożenia        [x]
  Zdalne repozytorium    [ origin  ▾ ]
  Budowanie              ( Bitbucket Pipelines ) ( GitHub Actions ) ( brak )
  Repozytorium (CI)      [ cybercode/podyplomowka-isp-manager-panel ]

  Środowiska                                                    [ + Dodaj ]
  ┌ Produkcja ── gałąź [ master ]       [x] produkcyjne
  │   Dostarczenie ( Obraz + Bandzior/Argo ) ( Webhook Kubemeter ) ( brak )
  │   Namespace [ cs-app-podyplomowka ]        Zasoby [ app ]
  └ Dev ──────── gałąź [ development ]  [ ] produkcyjne
      Dostarczenie ( Obraz + Bandzior/Argo ) …
      Namespace [ cs-app-podyplomowka-dev ]    Zasoby [ app ]
```

**Detection.** "Wykryj z repozytorium" fills the form from what the repository shows: which
pipeline file exists, the remote URL, the default branch and the branches named in the pipeline
file. Each branch the pipeline deploys becomes an environment; `main`/`master` is marked as
production and every other branch as not production, for the user to correct. It does not save; the
user reviews and saves. Namespace and workloads cannot be read from the repository and stay empty.

**Agent.** A new CLI subcommand next to `abeon-code note` and `abeon-code session`, plus a bundled
skill (working name `abeon-project-flow`) installed the same way as the two existing skills:

- `abeon-code flow show`: prints the current flow of the repository the working directory is in
  (or, from a project root that is not a repository, the flows of all its repositories), and any
  proposal waiting for confirmation.
- `abeon-code flow detect`: prints what detection finds, as a starting point.
- `abeon-code flow propose`: reads a flow as JSON from stdin, validates it and stores it as a
  **proposal**.

A proposal changes nothing by itself. The app shows a confirmation card with the difference between
the current flow and the proposal, and the flow is replaced only when the user presses „Zatwierdź”.
With the supervisor's Discord channel on, the app also sends the confirmation there with buttons.
A proposal expires after 24 h; a newer proposal for the same repository replaces the older one. The skill tells the agent to settle the values with the user first, to find the
namespace through the Bandzior MCP tools when it has them, and to tell the user that the proposal
is waiting for their confirmation.

The confirmation applies to every agent proposal, also in a session where the user typed the
request. Reason: the second design (approval policies) will read from this flow which branches are
production, so the flow must not be something an agent can rewrite alone.

### 3. What starts a tracking

A push to the branch of one of the flow's environments, on the flow's remote. The tracker notices
it from git itself: the remote-tracking ref moved and its reflog entry says `update by push`. This
covers pushes from agent sessions of every provider, from the terminal drawer and from a terminal
outside the app, whether the user or an agent asked for the push, and it does not depend on the
supervisor's hooks. A ref that moved because of a fetch starts nothing.

A tracking is tied to the repository, the environment and the pushed commit. It is **not** tied to
a session: the supervisor's guard does not look at pushes that follow the user's own prompt and is
absent when the supervisor is off, so it cannot tell reliably which session pushed. Sessions get
the result by asking for it (§7).

A new push to the same branch while a tracking is still running supersedes it: the older one is
closed as "zastąpione" and the new commit is followed. Several trackings (different repositories or
environments of one project) can run at the same time.

### 4. Stages

A tracking goes through the stages the flow defines.

**Build** (skipped when build is `none`): find the CI run for the pushed commit on that branch
(`bkt` or `gh`), then follow it. States: waiting for the run to appear, running, **paused** (a
manual step or an approval is waiting), failed, succeeded. The run's web address is kept for links.
On failure, the tail of the failing step's log is fetched and redacted with the supervisor's
existing redaction rules.

**Delivery, `image`:** at the start of the tracking the app records the images the workloads run.
After the build succeeds it waits until the workloads run a different image and the rollout is
complete (all replicas updated and ready). "Image" covers both container images and images mounted
as CSI volumes (`container-image.csi.k8s.io`, `volumeAttributes.image`): in the user's manifests
the application code arrives as such a volume while the nginx/php-fpm containers stay unchanged.
With several workloads listed, one changed workload is enough to start waiting, and the stage is
done when no listed workload has a rollout in progress. It does not compute the expected tag, because the tag
scheme differs per project; when the build number appears in the new tag, the details view says so.
If the pods of the new version fail to become ready (crash loop, image pull error), the stage fails
with the pod's reason and the tail of its log.

**Delivery, `kubemeter`:** after the build succeeds the app waits until the workloads' pods have
been restarted after that moment and are ready. No pipeline in `~/projects/cyberstudio` calls
Kubemeter today, so this variant is built without a real project to test against. The user confirmed that checking with `kubectl` is
enough here; Kubemeter can also show the pod's state, but the app does not talk to it.

**Delivery, `none`:** the tracking ends when the build succeeds.

**Time limits (builder may tune):** the build is polled every 15 s, the cluster every 10 s. No CI
run for the commit within 5 min, or no rollout within 15 min after the build → the tracking stops
as "nie widać dalszego ciągu", which is shown as a problem but worded differently from a failure.
A paused pipeline has no short limit; it is kept for 24 h.

Trackings are stored in SQLite, so the state survives an app restart and unfinished ones resume on
start. The last few per repository are kept as history.

### 5. VPN and other reasons the app cannot look

- **Cluster unreachable.** When `kubectl` fails with a connection error and a VPN connection name is
  set in the app settings (new field, Linux only), the app brings it up once per tracking with
  `nmcli connection up <name>` and retries. It leaves the VPN connected afterwards. If that does not
  help, or no name is set, the stage shows „Klaster niedostępny” with a „Spróbuj ponownie” button
  and keeps retrying slowly. This is never reported as a failed deployment.
- **Tool missing or not logged in** (`bkt`, `gh`, `kubectl`): the stage shows „Nie mogę sprawdzić”
  with the reason. The settings view shows which tools the app found.

### 6. What the user sees

- **Project row in the sidebar and the header of the active project:** a compact status while a
  tracking runs (which stage, running / done), and the last result afterwards until the next push
  or until the user dismisses it. With several trackings in one project, the row shows the one that
  most needs attention and a count.
- **Details** (click on the status): the stages with their times, the commit, links to the pipeline,
  the log excerpt on failure, „Spróbuj ponownie” where it applies.
- **Paused pipeline, the strong accent:** the project is marked as needing the user in the sidebar
  with a stronger look than a session waiting for input, the header shows a banner with a „Otwórz
  pipeline” button, a desktop notification is sent whose click opens the pipeline in the browser,
  and, when the supervisor's Discord channel is on, the app itself sends a Discord message with a
  link button, following the existing routing (including "mute when present"). The mark stays until
  the pipeline moves on or the tracking ends.
- **Failure and "nie widać dalszego ciągu":** desktop notification, the same mark as a session
  needing attention, and a Discord message under the same routing.
- **Success:** one quiet desktop notification („Wdrożono: <projekt>”), no Discord message.

Exact shapes, colours and Polish copy beyond the labels quoted here are the builder's call, within
the Grafit design.

### 7. Sessions and the supervisor

- **Sessions ask instead of polling.** `abeon-code deploy status` prints the state of the current
  trackings for the working directory's repository. `abeon-code deploy wait` blocks until the
  tracking of the most recent push ends or needs the user (or until a time limit that fits the
  agent's command timeout, after which it says the deployment is still running), and prints the
  outcome with the link and the log excerpt. The bundled skill tells agents to run `deploy wait`
  after a push instead of `sleep` and `bkt`/`gh` loops. This is how a failure gets back to the
  session that pushed: the session itself is waiting for it and can start fixing at once. A new push
  remains subject to the production guard.
- **„Wyślij do sesji”.** The details view of a failed tracking lets the user pick one of the
  project's open sessions and types the summary into it.
- **The supervisor gets no new events or tools in this version.** Its events, escalations and
  Discord batches are all tied to a session, and a deployment has none. The app sends the
  deployment messages itself, so nothing is sent twice and no model tokens are used. A session that
  ends its turn because `deploy wait` reported a pause or a failure is handled by the supervisor
  like any other ended turn.

The user's global `CLAUDE.md` tells agents to check the pipeline with `bkt` after a push to the
main branch. Inside AbeonCode the skill's `deploy wait` serves the same purpose; changing the
global file is the user's decision and outside this design.

## Decided with the user (2026-11-23)

1. **Kubemeter.** "Deployed" is verified with `kubectl`: the pods were restarted after the build
   finished and are ready.
2. **Paused pipeline.** A link to the pipeline page is enough. Approving the manual step from the
   app or from Discord is out of scope.

## Calls made by Claude (not discussed with the user)

- Approach 1 (tracker inside the app).
- Reading state through the installed `bkt`, `gh` and `kubectl` instead of storing API tokens.
- Detecting pushes from the git reflog rather than from session hooks.
- A flow per repository rather than per project (after the reviewer found the multi-repository
  projects).
- Environments: each tracked branch has its own namespace, workloads and production flag (pending
  the user's confirmation that dev deployments should be tracked).
- No link between a tracking and a session; sessions get results through `abeon-code deploy wait`,
  and the supervisor gets no new events in this version.
- The Kubemeter variant stays in this version although nothing can exercise it today.
- "Deployed" for the image chain means: the workloads run a new image and the rollout is complete.
- Every agent proposal of a flow needs the user's confirmation; edits in the settings do not.
- The VPN is brought up automatically only on Linux through NetworkManager and is left connected.
- A cluster the app cannot reach, or a missing tool, is never a failed deployment.
- Success is quiet: one desktop notification, nothing on Discord.
- New CLI commands `abeon-code flow …` and `abeon-code deploy …`, and one new bundled skill.

## Left to the builder

- Module layout, table shapes, the polling loop and its back-off.
- How pause states are recognised in the `bkt` and `gh` output (to be confirmed against a real
  paused run in `hs-training` and a GitHub run waiting for approval).
- The visual design of the status, the details view and the banner.
- Where the flow section lives if the project edit dialog becomes too crowded.
- Tests, following the existing split (cargo for the Rust side, Vitest for the UI).

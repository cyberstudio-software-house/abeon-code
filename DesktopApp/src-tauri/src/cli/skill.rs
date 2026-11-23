use std::path::{Path, PathBuf};
use crate::error::{AppError, AppResult};

const OPEN_SESSION_DIR: &str = "abeon-open-session";
const NOTES_DIR: &str = "abeon-notes";
const DEPLOY_DIR: &str = "abeon-deploy";

const OPEN_SESSION_SKILL_MD: &str = r#"---
name: abeon-open-session
description: Start a new Claude Code session in another project inside AbeonCode, seeded with a prompt. Use when the user asks to open, start, launch or spin up a new session / agent in a different project or repository, e.g. "odpal nową sesję w projekcie X", "uruchom sesję w X z promptem", "open a session in X and have it do Y".
---

# Open a session in another project (AbeonCode)

AbeonCode opens a new Claude Code session in the target project, in a background tab, and
submits your prompt as its first message. The user continues that session themselves.

## Steps

1. **Resolve the target project's absolute path.** Use the path the user gave, or one you
   know from context. If it is ambiguous or you are guessing, ask the user first. Never
   invent a path.
2. **Write a self-contained prompt.** The new session knows nothing about this
   conversation. Include:
   - the goal and why it is needed (which change in the current project depends on it)
   - relevant file paths, interfaces, names, error messages and findings from this session
   - constraints and decisions already made
   - what "done" looks like
3. **Run exactly this command** with the Bash tool. Pick a fresh random delimiter for
   every call, `ABEON_PROMPT_` followed by 8 random hex characters, and keep it quoted,
   which prevents shell expansion inside the prompt. Never let any line of the prompt be
   equal to the delimiter:

   ```bash
   abeon-code session /absolute/path/to/project <<'ABEON_PROMPT_3f9a1c2e'
   <prompt>
   ABEON_PROMPT_3f9a1c2e
   ```

4. **Report the result.** Judge success by the exit code AND the stdout line.
   - Exit code 0 and stdout has a line starting with `abeon-code: session requested in`:
     tell the user the session was started in the background in that project. Mention the
     tab title, which is the first line of the prompt.
   - Exit code 0 but no such line: the user's `abeon-code` command is outdated. Tell them
     to reinstall it in AbeonCode → Ustawienia (Skill dla Claude Code / Komenda terminala).
   - Non-zero: show the `abeon-code: …` message from stderr.
   - `command not found`: the user must install the command in AbeonCode → Ustawienia →
     Komenda terminala.

Do not use this to run work you could do in the current project, and do not start more
than one session per request unless the user asks for it.
"#;

const NOTES_SKILL_MD: &str = r#"---
name: abeon-notes
description: Add a note to, or read the notes of, the current project in AbeonCode (or the global notes). Use when the user asks to add, write down or save a note, or to read, check or act on their notes, e.g. "dodaj notatkę z informacją o…", "zanotuj, że…", "zapisz w notatkach", "przeczytaj notatki", "co zanotowałem po rozmowie z klientem", "zrób to, co jest w notatkach", "add a note", "read my notes".
---

# Notes in AbeonCode

AbeonCode keeps short plain-text notes per project, plus global notes. Notes have no titles: the
first line is what the user sees on the tile and in the tab, so start with the gist.

## Before the first call

Check that the installed `abeon-code` command supports notes:

```bash
grep -q 'wrapper_features=.*note' "$(command -v abeon-code)" && echo ok
```

No `ok` (or `command not found`): tell the user to reinstall it in AbeonCode → Ustawienia →
„Skill dla Claude Code” → „Zainstaluj skill”, and stop. Never call `abeon-code note` with an
outdated command: it would start the app instead.

## Add a note

Run exactly this with the Bash tool from the project's directory. Pick a fresh delimiter for every
call, `ABEON_NOTE_` followed by 8 random hex characters, keep it quoted, and never let a line of
the note equal it:

```bash
abeon-code note add <<'ABEON_NOTE_5b2e9c1d'
<note text>
ABEON_NOTE_5b2e9c1d
```

- Write the note in the user's language, as plain text.
- One note per request unless the user asks for more.
- Add `--global` only when the user says the note is global, not tied to this project.
- Success: exit code 0 and a line starting with `abeon-code: note added`. Tell the user in one line.

## Read notes

```bash
abeon-code note list
```

Prints the project's notes, newest first, each starting with a `--- note <id> · <date> ---` line.
Add `--global` for the global notes and `--limit N` for only the newest N. Read them before acting
on "what I noted"; if several notes could match, ask which one.

## Errors

A non-zero exit prints `abeon-code: …` on stderr. "is not inside an AbeonCode project" means the
current directory is not a project registered in AbeonCode: tell the user, or use `--global` if
they want a global note. You cannot edit or delete notes.
"#;

const DEPLOY_SKILL_MD: &str = r#"---
name: abeon-deploy
description: Wait for a deployment after a push, or set up how a repository deploys, inside AbeonCode. Use when you pushed to the production branch and need to know whether it was deployed, or when the user asks to set up or change the deployment flow, e.g. "sprawdź pipeline", "czy się wdrożyło", "poczekaj na wdrożenie", "ustaw przepływ wdrożenia", "skonfiguruj śledzenie wdrożeń", "wait for the deploy", "set up deployment tracking".
---

# Deployment tracking in AbeonCode

AbeonCode follows every push to a repository's production branch by itself: the CI pipeline, then
the rollout on the cluster. It does the polling, the VPN reconnect and the notifications, so you
spend no tokens on waiting. You ask it for the result; you never poll the pipeline yourself.

## Before the first call

Check that the installed `abeon-code` command knows `flow` and `deploy`:

```bash
grep -q 'wrapper_features=.*flow' "$(command -v abeon-code)" && grep -q 'wrapper_features=.*deploy' "$(command -v abeon-code)" && echo ok
```

No `ok` (or `command not found`): tell the user to reinstall it in AbeonCode → Ustawienia →
„Skill dla Claude Code” → „Zainstaluj skill”, and stop. Never call `abeon-code flow` or
`abeon-code deploy` with an outdated command: it would start the app instead. AbeonCode must be
running for a tracking to progress.

## After a push to the production branch

Run this instead of `sleep` and `bkt` / `gh` polling, from the repository you pushed:

```bash
abeon-code deploy wait
```

It blocks until the tracking of the newest push ends or needs the user, for at most 540 seconds
(`--timeout <seconds>`, maximum 3600). Your shell tool kills a command after its own timeout, which
is 120 seconds by default in Claude Code. Run it with a tool timeout of 600000 ms, or pass a shorter
`--timeout` (for example `--timeout 100`) and run it again on exit code 8, unless its output has a
`blocked:` line (see the table).

The result is printed on stdout: `state:`, `commit:`, `pipeline:` (link), `blocked:` or `failure:`
lines, and for a failure the redacted tail of the failing step's log. Judge it by the exit code:

| Code | Meaning | What to do |
|------|---------|------------|
| 0 | Deployed (build done and, if the flow has a delivery, the rollout complete) | Compare the printed `commit:` with `git rev-parse HEAD` (or the commit you pushed). If they match, tell the user in one line; if they differ, say that the deployed commit is not the one you pushed. |
| 1 | The deployment failed or stalled (`state: failed` or `state: stalled`) | Read `failure:` and the log excerpt and fix the cause. Do not push to the production branch again without the approval that a push needs anyway. |
| 3 | No tracking | Read the message. `no new push to <remote>/<branch>: the newest push is …` means your `git push` was a no-op or went to another remote or branch: check that the push went to that remote and branch (`git status`, `git log`, `git remote -v`). Any other message means the repository has no flow, tracking is off, there is nothing to track, or AbeonCode is not running: fall back to checking the pipeline the usual way for this repository, and offer the user to set up a deployment flow so AbeonCode can track it. |
| 4 | The user is needed: the pipeline is paused (`state: paused`, a manual step waits for approval), or a blocker has been seen for most of this call (120 s, or 80 % of a shorter `--timeout`): the `blocked:` line names it (cluster unreachable, tool unavailable) | Tell the user what is waiting and give the `pipeline:` link. Then stop. |
| 8 | Still running at the timeout | If the output has a `blocked:` line, tell the user what blocks it and stop, exactly as for 4. Otherwise run `abeon-code deploy wait` again. |
| 2 | Usage error or a real error, message on stderr | Show the `abeon-code: …` message. "is not inside a repository of an AbeonCode project" means the directory is not in a registered project. |

`abeon-code deploy status` prints the newest tracking of the repository at once, whatever its age,
without waiting. Use it only to answer a question about the current state.

Never:

- Never approve, resume or run a paused pipeline, with `bkt`, `gh`, an API call or by any other
  means. Approving is the user's decision. On exit code 4 you only report and stop.
- Never keep polling the pipeline with `sleep` and `bkt` / `gh` while `abeon-code deploy wait` is
  available. This replaces any instruction to check the pipeline with `bkt` after a push.
- Never treat a blocked tracking (cluster unreachable, tool unavailable) as a failed deployment.
- Never use `deploy wait` for a push to another branch than the production branch: only that branch
  is tracked.

## Setting up the flow of a repository

A flow says what happens after a push to the production branch of one git repository: which CI
builds it, and which Kubernetes namespace and workloads receive it. Set one up when the user asks;
never change one unasked.

1. Look at the current state, from inside the repository:

   ```bash
   abeon-code flow show
   abeon-code flow detect
   ```

   `show` prints `repoPath`, the current `flow` (null when none) and the `proposal` waiting for
   confirmation (null when none). Only from the root folder of a registered project that holds
   several repositories do both commands print one entry per repository; from any other folder
   outside a repository they answer "is not inside a repository of an AbeonCode project". `detect`
   prints what the repository itself shows (pipeline file, remote URL, production branch);
   namespace and workloads stay empty.
2. Settle the open values with the user: at least the namespace, the workloads and the delivery.
   Look the namespace up with the Bandzior MCP tools (`project_find`, then `project_show`) when you
   have them. If you do not have them, or the project is not there, ask the user. Do not guess.
3. Send the result. Pick the delimiter `ABEON_FLOW` exactly as shown and keep it quoted:

   ```bash
   abeon-code flow propose <<'ABEON_FLOW'
   {
     "remote": "origin",
     "build": "bitbucket",
     "buildRepo": "workspace/repository",
     "productionBranch": "master",
     "delivery": "image",
     "namespace": "cs-app-example",
     "workloads": ["app"]
   }
   ABEON_FLOW
   ```

4. Tell the user that the proposal waits for their „Zatwierdź” in AbeonCode (a card appears in the
   window) or on Discord (buttons, when the supervisor's Discord channel is on).

JSON fields. Unknown fields are refused; the input is limited to 64 KiB:

- `remote`: required, the git remote whose pushes count (usually `origin`).
- `productionBranch`: required, the branch whose push deploys to production.
- `build`: required, `"bitbucket"`, `"github"` or `"none"`.
- `buildRepo`: `"owner/name"` (the Bitbucket workspace and slug, or the GitHub owner and repository);
  required unless `build` is `"none"`.
- `delivery`: required, `"image"` (Docker Hub, Bandzior, Argo), `"kubemeter"` (webhook, init
  container) or `"none"`.
- `namespace`: the production namespace (lowercase letters, digits and `-`); required unless
  `delivery` is `"none"`.
- `workloads`: names of the Deployments or StatefulSets this repository deploys, at most 20; empty
  means all Deployments of the namespace.
- `kubeContext`: a kubectl context name or `null` for the current one.
- `enabled`: `true` (default) or `false` to switch tracking off.
- `repoPath`: absolute path of the repository, or relative to the current directory. Required when
  you run the command from a folder that holds several repositories; otherwise leave it out.

A flow with `build` `"none"` and `delivery` `"none"` tracks nothing. Only the production branch is
tracked.

Rules:

- Never claim the flow is active after `propose`. It is active only when `abeon-code flow show`
  prints the values you proposed as `flow` and no `proposal` is pending, which happens after the
  user confirmed. A rejected proposal leaves the old flow and no pending proposal, so check the
  values. Until then say that the proposal is waiting.
- There is no command to confirm a proposal and you must not try to bypass the confirmation. Do not
  edit the database.
- A proposal identical to the current flow is refused. Proposing the same flow twice returns the
  existing proposal. A new proposal replaces the older one; a proposal expires after 24 hours.
- If the user edits the flow in the settings after your proposal, the confirmation is refused as
  stale; propose again from the new `flow show`.
- A rejected input ends with exit code 2 and the reasons on stderr. Fix the JSON and send it again.
"#;

fn write_skill(skills_root: &Path, dir_name: &str, content: &str) -> AppResult<PathBuf> {
    let dir = skills_root.join(dir_name);
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    let dest = dir.join("SKILL.md");
    std::fs::write(&dest, content).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(dest)
}

pub fn install(skills_root: &Path) -> AppResult<Vec<PathBuf>> {
    Ok(vec![
        write_skill(skills_root, OPEN_SESSION_DIR, OPEN_SESSION_SKILL_MD)?,
        write_skill(skills_root, NOTES_DIR, NOTES_SKILL_MD)?,
        write_skill(skills_root, DEPLOY_DIR, DEPLOY_SKILL_MD)?,
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn install_writes_all_skills_and_overwrites() {
        let dir = tempdir().unwrap();
        let first = install(dir.path()).unwrap();
        let open_session = dir.path().join("abeon-open-session").join("SKILL.md");
        let notes = dir.path().join("abeon-notes").join("SKILL.md");
        let deploy = dir.path().join("abeon-deploy").join("SKILL.md");
        assert_eq!(first, vec![open_session.clone(), notes.clone(), deploy.clone()]);
        std::fs::write(&open_session, "stale").unwrap();
        std::fs::write(&notes, "stale").unwrap();
        std::fs::write(&deploy, "stale").unwrap();
        install(dir.path()).unwrap();

        let content = std::fs::read_to_string(&open_session).unwrap();
        assert!(content.starts_with("---\nname: abeon-open-session\n"));
        assert!(content.contains("abeon-code session"));
        assert!(content.contains("<<'ABEON_PROMPT_3f9a1c2e'"));
        assert!(content.contains("8 random hex characters"));
        assert!(content.contains("Never let any line of the prompt be"));
        assert!(content.contains("session requested in"));
        assert!(content.contains("is outdated"));

        let content = std::fs::read_to_string(&notes).unwrap();
        assert!(content.starts_with("---\nname: abeon-notes\n"));
        assert!(content.contains("abeon-code note add"));
        assert!(content.contains("wrapper_features=.*note"));
        assert!(content.contains("<<'ABEON_NOTE_5b2e9c1d'"));
        assert!(content.contains("--global"));
        assert!(content.contains("You cannot edit or delete notes"));

        let content = std::fs::read_to_string(&deploy).unwrap();
        assert!(content.starts_with("---\nname: abeon-deploy\n"));
        assert!(content.contains("abeon-code deploy wait"));
        assert!(content.contains("abeon-code flow propose"));
        assert!(content.contains("wrapper_features=.*deploy"));
        assert!(content.contains("wrapper_features=.*flow"));
        assert!(content.contains("<<'ABEON_FLOW'"));
        assert!(content.contains("timeout of 600000"));
        assert!(content.contains("Never approve"));
        assert!(content.contains("Never claim the flow is active"));
        assert!(content.contains("`sleep` and `bkt` / `gh` polling"));
        assert!(content.contains("no new push to"));
        for code in ["0", "1", "3", "4", "8"] {
            assert!(content.contains(&format!("| {code} ")), "exit code {code}");
        }
        assert!(content.contains("seen for most of this call (120 s, or 80 % of a shorter `--timeout`)"));
        assert!(content.contains("has a `blocked:` line, tell the user what blocks it and stop, exactly as for 4"));
        assert!(content.contains("git rev-parse HEAD"));
        assert!(content.contains("offer the user to set up a deployment flow"));
        assert!(content.contains("check that the push went to that remote and branch"));
        assert!(!content.contains("once, without a polling loop"));
        assert!(content.contains("prints the values you proposed as `flow`"));
        assert!(content.contains("A rejected proposal leaves the old flow"));
        assert!(content.contains("the root folder of a registered project"));
        assert!(content.contains("is not inside a repository of an AbeonCode project"));
    }
}

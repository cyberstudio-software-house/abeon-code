use std::path::{Path, PathBuf};
use crate::error::{AppError, AppResult};

const OPEN_SESSION_DIR: &str = "abeon-open-session";
const NOTES_DIR: &str = "abeon-notes";

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
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn install_writes_both_skills_and_overwrites() {
        let dir = tempdir().unwrap();
        let first = install(dir.path()).unwrap();
        let open_session = dir.path().join("abeon-open-session").join("SKILL.md");
        let notes = dir.path().join("abeon-notes").join("SKILL.md");
        assert_eq!(first, vec![open_session.clone(), notes.clone()]);
        std::fs::write(&open_session, "stale").unwrap();
        std::fs::write(&notes, "stale").unwrap();
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
    }
}

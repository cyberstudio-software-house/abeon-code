use std::path::{Path, PathBuf};
use crate::error::{AppError, AppResult};

const SKILL_DIR: &str = "abeon-open-session";

const SKILL_MD: &str = r#"---
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
3. **Run exactly this command** with the Bash tool. Keep the quoted delimiter, which
   prevents shell expansion inside the prompt:

   ```bash
   abeon-code session /absolute/path/to/project <<'ABEON_PROMPT'
   <prompt>
   ABEON_PROMPT
   ```

4. **Report the result.**
   - Exit code 0: tell the user the session was started in the background in that project.
     Mention the tab title, which is the first line of the prompt.
   - Non-zero: show the `abeon-code: …` message from stderr.
   - `command not found`: the user must install the command in AbeonCode → Ustawienia →
     Komenda terminala.

Do not use this to run work you could do in the current project, and do not start more
than one session per request unless the user asks for it.
"#;

pub fn install(skills_root: &Path) -> AppResult<PathBuf> {
    let dir = skills_root.join(SKILL_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    let dest = dir.join("SKILL.md");
    std::fs::write(&dest, SKILL_MD).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn install_writes_skill_file_and_overwrites() {
        let dir = tempdir().unwrap();
        let first = install(dir.path()).unwrap();
        assert_eq!(first, dir.path().join("abeon-open-session").join("SKILL.md"));
        std::fs::write(&first, "stale").unwrap();
        install(dir.path()).unwrap();
        let content = std::fs::read_to_string(&first).unwrap();
        assert!(content.starts_with("---\nname: abeon-open-session\n"));
        assert!(content.contains("abeon-code session"));
        assert!(content.contains("<<'ABEON_PROMPT'"));
    }
}

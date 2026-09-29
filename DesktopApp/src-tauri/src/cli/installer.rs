use std::path::{Path, PathBuf};
use crate::error::{AppError, AppResult};
use crate::commands::pty::MAX_INITIAL_PROMPT_BYTES;

const CALLER_SESSION_ENV_VARS: &[&str] = &[
    "CLAUDECODE",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_BRIDGE_SESSION_ID",
    "CLAUDE_PID",
    "CLAUDE_EFFORT",
    "AI_AGENT",
];

pub fn wrapper_script(exe_path: &str) -> String {
    let unset_args = CALLER_SESSION_ENV_VARS
        .iter()
        .map(|v| format!("-u {v}"))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r#"#!/usr/bin/env bash
set -euo pipefail
exe="{exe_path}"
max_prompt_bytes={MAX_INITIAL_PROMPT_BYTES}
unset_args=({unset_args})

fail() {{
  echo "abeon-code: $1" >&2
  exit 2
}}

if [ "${{1:-}}" = "session" ]; then
  target="${{2:-}}"
  [ -n "$target" ] || fail "usage: abeon-code session <project-dir> <<'ABEON_PROMPT' ... ABEON_PROMPT"
  [ -d "$target" ] || fail "not a directory: $target"
  [ ! -t 0 ] || fail "expected the prompt on stdin (use a heredoc)"
  prompt="$(cat)"
  [[ $prompt =~ [^[:space:]] ]] || fail "empty prompt"
  bytes="$(printf '%s' "$prompt" | wc -c | tr -d ' ')"
  [ "$bytes" -le "$max_prompt_bytes" ] || fail "prompt too long ($bytes bytes, max $max_prompt_bytes)"
  abs="$(cd "$target" && pwd -P)"
  [ -x "$exe" ] || fail "AbeonCode executable not found: $exe (reinstall the command in AbeonCode settings)"
  if command -v setsid >/dev/null 2>&1; then
    setsid env "${{unset_args[@]}}" "$exe" "$abs" --prompt "$prompt" --background </dev/null >/dev/null 2>&1 &
  else
    nohup env "${{unset_args[@]}}" "$exe" "$abs" --prompt "$prompt" --background </dev/null >/dev/null 2>&1 &
  fi
  echo "abeon-code: session requested in $abs"
  exit 0
fi

target="${{1:-.}}"
if [ -d "$target" ]; then
  abs="$(cd "$target" && pwd -P)"
else
  abs="$(cd "$(dirname -- "$target")" 2>/dev/null && pwd -P)/$(basename -- "$target")"
fi
[ -x "$exe" ] || fail "AbeonCode executable not found: $exe (reinstall the command in AbeonCode settings)"
exec env "${{unset_args[@]}}" "$exe" "$abs"
"#
    )
}

pub fn install(exe_path: &str, target_dir: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(target_dir).map_err(|e| AppError::Other(e.to_string()))?;
    let dest = target_dir.join("abeon-code");
    std::fs::write(&dest, wrapper_script(exe_path)).map_err(|e| AppError::Other(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn script_contains_shebang_and_exe() {
        let s = wrapper_script("/opt/AbeonCode/abeoncode");
        assert!(s.starts_with("#!/usr/bin/env bash"));
        assert!(s.contains("/opt/AbeonCode/abeoncode"));
    }

    #[test]
    fn install_writes_executable_file() {
        let dir = tempdir().unwrap();
        let dest = install("/opt/AbeonCode/abeoncode", dir.path()).unwrap();
        assert_eq!(dest.file_name().unwrap().to_string_lossy(), "abeon-code");
        assert!(dest.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111);
        }
    }

    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    fn fake_exe(dir: &Path, delay_secs: u32) -> PathBuf {
        let exe = dir.join("fake-exe");
        std::fs::write(
            &exe,
            format!(
                "#!/usr/bin/env bash\nsleep {delay_secs}\nenv > \"$ABEON_TEST_OUT.env\"\nprintf '%s\\0' \"$@\" > \"$ABEON_TEST_OUT.tmp\"\nmv \"$ABEON_TEST_OUT.tmp\" \"$ABEON_TEST_OUT\"\n"
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755)).unwrap();
        exe
    }

    fn run_wrapper(wrapper: &Path, args: &[&str], stdin: &str, out: &Path) -> std::process::Output {
        let mut child = Command::new("bash")
            .arg(wrapper)
            .args(args)
            .env("ABEON_TEST_OUT", out)
            .env("CLAUDECODE", "1")
            .env("CLAUDE_CODE_SESSION_ID", "leak-session")
            .env("AI_AGENT", "leak-agent")
            .env("CLAUDE_CODE_USE_BEDROCK", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let _ = child.stdin.take().unwrap().write_all(stdin.as_bytes());
        child.wait_with_output().unwrap()
    }

    fn wait_for_argv(out: &Path) -> Vec<String> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !out.exists() {
            assert!(Instant::now() < deadline, "fake exe never ran");
            std::thread::sleep(Duration::from_millis(50));
        }
        let raw = std::fs::read(out).unwrap();
        raw.split(|b| *b == 0)
            .filter(|s| !s.is_empty())
            .map(|s| String::from_utf8(s.to_vec()).unwrap())
            .collect()
    }

    #[test]
    fn session_mode_passes_prompt_verbatim_and_background() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let out = dir.path().join("argv");
        let prompt = "Fix it's \"bug\"\n$(id) `x`\n-dash line\nzażółć";
        let res = run_wrapper(&wrapper, &["session", project.to_str().unwrap()], prompt, &out);
        assert!(res.status.success(), "stderr: {}", String::from_utf8_lossy(&res.stderr));
        let canonical = std::fs::canonicalize(&project).unwrap();
        assert_eq!(
            wait_for_argv(&out),
            vec![canonical.to_string_lossy().to_string(), "--prompt".into(), prompt.into(), "--background".into()]
        );
    }

    #[test]
    fn session_mode_returns_before_the_launched_exe_finishes() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let exe = fake_exe(dir.path(), 3);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let out = dir.path().join("argv");
        let started = Instant::now();
        let res = run_wrapper(&wrapper, &["session", project.to_str().unwrap()], "hello", &out);
        assert!(res.status.success());
        assert!(started.elapsed() < Duration::from_secs(2), "wrapper blocked on the exe");
        wait_for_argv(&out);
    }

    #[test]
    fn session_mode_rejects_empty_prompt() {
        let dir = tempdir().unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let res = run_wrapper(&wrapper, &["session", dir.path().to_str().unwrap()], "  \n\t\n", &dir.path().join("argv"));
        assert_eq!(res.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&res.stderr).contains("abeon-code: empty prompt"));
    }

    #[test]
    fn session_mode_rejects_missing_directory() {
        let dir = tempdir().unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let res = run_wrapper(&wrapper, &["session", "/definitely/not/here"], "x", &dir.path().join("argv"));
        assert_eq!(res.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&res.stderr).contains("abeon-code: not a directory"));
    }

    #[test]
    fn session_mode_rejects_missing_path_argument() {
        let dir = tempdir().unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let res = run_wrapper(&wrapper, &["session"], "x", &dir.path().join("argv"));
        assert_eq!(res.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&res.stderr).contains("abeon-code: usage"));
    }

    #[test]
    fn session_mode_rejects_oversized_prompt() {
        let dir = tempdir().unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let big = "a".repeat(crate::commands::pty::MAX_INITIAL_PROMPT_BYTES + 1);
        let res = run_wrapper(&wrapper, &["session", dir.path().to_str().unwrap()], &big, &dir.path().join("argv"));
        assert_eq!(res.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&res.stderr).contains("abeon-code: prompt too long"));
    }

    #[test]
    fn legacy_mode_still_execs_with_absolute_path() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let out = dir.path().join("argv");
        let res = run_wrapper(&wrapper, &[project.to_str().unwrap()], "", &out);
        assert!(res.status.success());
        let canonical = std::fs::canonicalize(&project).unwrap();
        assert_eq!(wait_for_argv(&out), vec![canonical.to_string_lossy().to_string()]);
    }

    fn read_env(out: &Path) -> String {
        std::fs::read_to_string(format!("{}.env", out.display())).unwrap()
    }

    #[test]
    fn session_mode_strips_caller_session_env_but_keeps_user_settings() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let out = dir.path().join("argv");
        let res = run_wrapper(&wrapper, &["session", project.to_str().unwrap()], "hi", &out);
        assert!(res.status.success());
        wait_for_argv(&out);
        let env = read_env(&out);
        assert!(!env.contains("CLAUDECODE="));
        assert!(!env.contains("CLAUDE_CODE_SESSION_ID="));
        assert!(!env.contains("AI_AGENT="));
        assert!(env.contains("CLAUDE_CODE_USE_BEDROCK=1"));
    }

    #[test]
    fn legacy_mode_strips_caller_session_env_but_keeps_user_settings() {
        let dir = tempdir().unwrap();
        let project = dir.path().join("proj");
        std::fs::create_dir(&project).unwrap();
        let exe = fake_exe(dir.path(), 0);
        let wrapper = install(&exe.to_string_lossy(), dir.path()).unwrap();
        let out = dir.path().join("argv");
        let res = run_wrapper(&wrapper, &[project.to_str().unwrap()], "", &out);
        assert!(res.status.success());
        wait_for_argv(&out);
        let env = read_env(&out);
        assert!(!env.contains("CLAUDECODE="));
        assert!(env.contains("CLAUDE_CODE_USE_BEDROCK=1"));
    }

    #[test]
    fn session_mode_fails_when_executable_is_missing() {
        let dir = tempdir().unwrap();
        let wrapper = install("/definitely/not/here/abeoncode", dir.path()).unwrap();
        let res = run_wrapper(&wrapper, &["session", dir.path().to_str().unwrap()], "hi", &dir.path().join("argv"));
        assert_eq!(res.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&res.stderr).contains("abeon-code: AbeonCode executable not found"));
        assert!(!String::from_utf8_lossy(&res.stdout).contains("session requested"));
    }

    #[test]
    fn legacy_mode_fails_when_executable_is_missing() {
        let dir = tempdir().unwrap();
        let wrapper = install("/definitely/not/here/abeoncode", dir.path()).unwrap();
        let res = run_wrapper(&wrapper, &[dir.path().to_str().unwrap()], "", &dir.path().join("argv"));
        assert_eq!(res.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&res.stderr).contains("abeon-code: AbeonCode executable not found"));
    }
}

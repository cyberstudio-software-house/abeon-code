use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};

use super::files::DiscordFiles;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscordBlocker {
    BunMissing,
    TokenMissing,
}

impl fmt::Display for DiscordBlocker {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = match self {
            DiscordBlocker::BunMissing => "Nie znaleziono Bun (~/.bun/bin/bun)",
            DiscordBlocker::TokenMissing => "Brak tokenu bota Discord",
        };
        formatter.write_str(text)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscordLaunch {
    pub path_prefix: Option<PathBuf>,
}

const BUN_BINARY: &str = "bun";
const BUN_HOME_DIR: &str = ".bun";
const BIN_DIR: &str = "bin";
const PATH_KEY: &str = "PATH";
const BUN_INSTALL_KEY: &str = "BUN_INSTALL";
#[cfg(unix)]
const EXECUTE_BITS: u32 = 0o111;

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path)
        .map(|meta| meta.is_file() && meta.permissions().mode() & EXECUTE_BITS != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

fn bun_on_path(env: &HashMap<String, String>) -> Option<PathBuf> {
    let path = env.get(PATH_KEY)?;
    std::env::split_paths(path)
        .map(|dir| dir.join(BUN_BINARY))
        .find(|candidate| is_executable_file(candidate))
}

fn bun_outside_path(env: &HashMap<String, String>, home: &Path) -> Option<PathBuf> {
    let from_install = env
        .get(BUN_INSTALL_KEY)
        .filter(|install| !install.is_empty())
        .map(|install| Path::new(install).join(BIN_DIR).join(BUN_BINARY));
    from_install
        .into_iter()
        .chain(std::iter::once(
            home.join(BUN_HOME_DIR).join(BIN_DIR).join(BUN_BINARY),
        ))
        .find(|candidate| is_executable_file(candidate))
}

pub fn resolve_bun(env: &HashMap<String, String>, home: &Path) -> Option<PathBuf> {
    bun_on_path(env).or_else(|| bun_outside_path(env, home))
}

pub fn discord_launch(
    env: &HashMap<String, String>,
    home: &Path,
    files: &DiscordFiles,
) -> Result<DiscordLaunch, DiscordBlocker> {
    let path_prefix = if bun_on_path(env).is_some() {
        None
    } else {
        let bun = bun_outside_path(env, home).ok_or(DiscordBlocker::BunMissing)?;
        bun.parent().map(Path::to_path_buf)
    };
    if files.token().is_none() {
        return Err(DiscordBlocker::TokenMissing);
    }
    Ok(DiscordLaunch { path_prefix })
}

pub fn with_path_prefix(
    mut env: HashMap<String, String>,
    prefix: Option<&Path>,
) -> HashMap<String, String> {
    let Some(prefix) = prefix else {
        return env;
    };
    let prefix = prefix.to_string_lossy();
    let value = match env.get(PATH_KEY) {
        Some(existing) if !existing.is_empty() => format!("{prefix}:{existing}"),
        _ => prefix.into_owned(),
    };
    env.insert(PATH_KEY.to_string(), value);
    env
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn make_bun(dir: &Path, mode: u32) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join("bun");
        std::fs::write(&path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode)).unwrap();
        path
    }

    fn env_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn bun_on_path_needs_no_prefix() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        let bun = make_bun(&bin, 0o755);
        let home = root.path().join("home");
        let env = env_of(&[("PATH", &format!("/nonexistent:{}", bin.display()))]);
        assert_eq!(resolve_bun(&env, &home), Some(bun));
        let files = DiscordFiles::new(root.path().join("discord"));
        std::fs::create_dir_all(root.path().join("discord")).unwrap();
        std::fs::write(
            root.path().join("discord").join(".env"),
            "DISCORD_BOT_TOKEN=abc\n",
        )
        .unwrap();
        assert_eq!(
            discord_launch(&env, &home, &files),
            Ok(DiscordLaunch { path_prefix: None })
        );
    }

    #[test]
    fn bun_from_bun_install_or_home_gets_a_prefix() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("install");
        let bun = make_bun(&install.join("bin"), 0o755);
        let home = root.path().join("home");
        let env = env_of(&[
            ("PATH", "/usr/bin"),
            ("BUN_INSTALL", install.to_str().unwrap()),
        ]);
        assert_eq!(resolve_bun(&env, &home), Some(bun));

        let home_bun = make_bun(&home.join(".bun").join("bin"), 0o755);
        let env = env_of(&[("PATH", "/usr/bin")]);
        assert_eq!(resolve_bun(&env, &home), Some(home_bun));

        let files = DiscordFiles::new(root.path().join("discord"));
        std::fs::create_dir_all(root.path().join("discord")).unwrap();
        std::fs::write(
            root.path().join("discord").join(".env"),
            "DISCORD_BOT_TOKEN=abc\n",
        )
        .unwrap();
        assert_eq!(
            discord_launch(&env, &home, &files),
            Ok(DiscordLaunch {
                path_prefix: Some(home.join(".bun").join("bin"))
            })
        );
    }

    #[test]
    fn non_executable_bun_is_ignored() {
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        make_bun(&bin, 0o644);
        let home = root.path().join("home");
        std::fs::create_dir_all(home.join(".bun").join("bin").join("bun")).unwrap();
        let env = env_of(&[("PATH", bin.to_str().unwrap())]);
        assert_eq!(resolve_bun(&env, &home), None);
    }

    #[test]
    fn launch_blocked_without_bun_or_token() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let env = env_of(&[("PATH", "/nonexistent")]);
        let dir = root.path().join("discord");
        std::fs::create_dir_all(&dir).unwrap();
        let files = DiscordFiles::new(dir.clone());
        assert_eq!(
            discord_launch(&env, &home, &files),
            Err(DiscordBlocker::BunMissing)
        );

        make_bun(&home.join(".bun").join("bin"), 0o755);
        assert_eq!(
            discord_launch(&env, &home, &files),
            Err(DiscordBlocker::TokenMissing)
        );

        std::fs::write(dir.join(".env"), "DISCORD_BOT_TOKEN=abc\n").unwrap();
        assert!(discord_launch(&env, &home, &files).is_ok());
    }

    #[test]
    fn blocker_messages_are_polish() {
        assert_eq!(
            DiscordBlocker::BunMissing.to_string(),
            "Nie znaleziono Bun (~/.bun/bin/bun)"
        );
        assert_eq!(
            DiscordBlocker::TokenMissing.to_string(),
            "Brak tokenu bota Discord"
        );
    }

    #[test]
    fn path_prefix_is_prepended_once() {
        let prefix = Path::new("/h/.bun/bin");
        let with_path = with_path_prefix(env_of(&[("PATH", "/usr/bin")]), Some(prefix));
        assert_eq!(with_path["PATH"], "/h/.bun/bin:/usr/bin");
        let without_path = with_path_prefix(HashMap::new(), Some(prefix));
        assert_eq!(without_path["PATH"], "/h/.bun/bin");
        let unchanged = with_path_prefix(env_of(&[("PATH", "/usr/bin")]), None);
        assert_eq!(unchanged["PATH"], "/usr/bin");
    }
}

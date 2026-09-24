use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::State;

use crate::commands::settings::{ensure_shell_env, resolve_shell};
use crate::domain::{ClaudeOptions, DetectedModel};
use crate::state::AppState;

const MAX_FALLBACK_FILES: usize = 50;
const NON_MODEL_FAMILIES: [&str; 5] = ["code", "cli", "desktop", "eval", "instant"];
const FALLBACK_EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];
const HELP_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_MINOR_VERSION: u32 = 100;
const EFFORT_LIST_MAX_DISTANCE: usize = 400;

/// Pull every `claude-...` ASCII token out of a byte blob (CLI binary or JSONL).
/// A token runs while bytes stay in `[a-z0-9-]`, so `claude-opus-4-8[1m]` yields
/// `claude-opus-4-8` (the `[` terminates it).
fn scan_aliases(bytes: &[u8]) -> Vec<String> {
    let needle = b"claude-";
    let mut out = Vec::new();
    let mut i = 0usize;
    while i + needle.len() <= bytes.len() {
        if &bytes[i..i + needle.len()] == needle {
            let mut j = i + needle.len();
            while j < bytes.len()
                && (bytes[j].is_ascii_lowercase() || bytes[j].is_ascii_digit() || bytes[j] == b'-')
            {
                j += 1;
            }
            if let Ok(s) = std::str::from_utf8(&bytes[i..j]) {
                out.push(s.to_string());
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    out
}

/// Reduce a raw token to its clean `claude-family-major[-minor]` alias.
/// Accepts any alphabetic family plus at least one numeric version segment;
/// drops date / `-v1` / `-fast` suffixes; rejects an explicit `.0` minor
/// (base alias) and tokens without a numeric version. Returns `(clean_id, family)`.
fn normalize_alias(token: &str) -> Option<(String, String)> {
    let rest = token.strip_prefix("claude-")?;
    let mut parts = rest.split('-');
    let family = parts.next()?;
    if family.is_empty() || !family.chars().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    if NON_MODEL_FAMILIES.contains(&family) {
        return None;
    }
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: Option<u32> = parts
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|m| *m < MAX_MINOR_VERSION);
    if minor == Some(0) {
        return None;
    }
    let clean = match minor {
        Some(m) => format!("claude-{family}-{major}-{m}"),
        None => format!("claude-{family}-{major}"),
    };
    Some((clean, family.to_string()))
}

fn version_key(model_id: &str) -> (u32, u32) {
    let base = model_id.trim_end_matches("[1m]");
    let mut numbers = base.split('-').skip(2).filter_map(|s| s.parse::<u32>().ok());
    (numbers.next().unwrap_or(0), numbers.next().unwrap_or(0))
}

/// Normalize + dedupe raw tokens into `DetectedModel`s. Opus aliases also get a
/// synthesized `[1m]` variant (the CLI applies that suffix at runtime).
fn build_models(tokens: Vec<String>, source: &str) -> Vec<DetectedModel> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for tok in tokens {
        let Some((clean, family)) = normalize_alias(&tok) else { continue; };
        let mut variants = vec![clean.clone()];
        if family == "opus" {
            variants.push(format!("{clean}[1m]"));
        }
        for v in variants {
            if seen.insert(v.clone()) {
                out.push(DetectedModel {
                    model_id: v,
                    family: family.clone(),
                    source: source.to_string(),
                    latest: false,
                });
            }
        }
    }
    let mut newest: HashMap<String, (u32, u32)> = HashMap::new();
    for model in &out {
        let version = version_key(&model.model_id);
        let entry = newest.entry(model.family.clone()).or_insert(version);
        if version > *entry {
            *entry = version;
        }
    }
    for model in &mut out {
        model.latest = newest.get(&model.family) == Some(&version_key(&model.model_id));
    }
    out.sort_by(|a, b| {
        a.family
            .cmp(&b.family)
            .then_with(|| version_key(&b.model_id).cmp(&version_key(&a.model_id)))
            .then_with(|| a.model_id.cmp(&b.model_id))
    });
    out
}

pub(crate) fn locate_binary(state: &AppState, name: &str) -> Option<PathBuf> {
    let path_var = state
        .db
        .get()
        .ok()
        .map(|conn| resolve_shell(&conn))
        .map(|shell| ensure_shell_env(state, &shell))
        .and_then(|env| env.get("PATH").cloned())
        .or_else(|| std::env::var("PATH").ok());
    if let Some(path_var) = path_var {
        for dir in path_var.split(':') {
            if dir.is_empty() {
                continue;
            }
            let candidate = Path::new(dir).join(name);
            if candidate.is_file() {
                return Some(std::fs::canonicalize(&candidate).unwrap_or(candidate));
            }
        }
    }
    default_binary_path(name)
}

fn default_binary_path_for(name: &str, home: Option<&Path>) -> Option<PathBuf> {
    match name {
        "opencode" => home.map(|path| path.join(".opencode/bin/opencode")),
        _ => None,
    }
}

pub(crate) fn default_binary_path(name: &str) -> Option<PathBuf> {
    default_binary_path_for(name, dirs::home_dir().as_deref()).filter(|path| path.is_file())
}

fn locate_claude(state: &AppState) -> Option<PathBuf> {
    locate_binary(state, "claude")
}

fn mtime_ms(path: &Path) -> i64 {
    path.metadata()
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Fallback: scan the most-recently-modified session JSONL files for model IDs.
fn detect_from_sessions() -> Vec<DetectedModel> {
    let Some(root) = dirs::home_dir().map(|h| h.join(".claude").join("projects")) else {
        return vec![];
    };
    let Ok(projects) = std::fs::read_dir(&root) else {
        return vec![];
    };
    let mut files: Vec<(i64, PathBuf)> = Vec::new();
    for proj in projects.filter_map(Result::ok) {
        let Ok(entries) = std::fs::read_dir(proj.path()) else {
            continue;
        };
        for e in entries.filter_map(Result::ok) {
            let p = e.path();
            if p.extension().map(|x| x == "jsonl").unwrap_or(false) {
                files.push((mtime_ms(&p), p));
            }
        }
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    files.truncate(MAX_FALLBACK_FILES);

    let mut tokens = Vec::new();
    for (_, p) in files {
        if let Ok(bytes) = std::fs::read(&p) {
            tokens.extend(scan_aliases(&bytes));
        }
    }
    build_models(tokens, "session")
}

fn parse_effort_levels(help: &str) -> Option<Vec<String>> {
    let start = help.find("--effort")?;
    let rest = &help[start..];
    let open = rest.find('(')?;
    if open > EFFORT_LIST_MAX_DISTANCE {
        return None;
    }
    let close = open + rest[open..].find(')')?;
    let levels: Vec<String> = rest[open + 1..close]
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase()))
        .map(String::from)
        .collect();
    (!levels.is_empty()).then_some(levels)
}

fn shell_env(state: &AppState) -> HashMap<String, String> {
    state
        .db
        .get()
        .ok()
        .map(|conn| resolve_shell(&conn))
        .map(|shell| ensure_shell_env(state, &shell))
        .unwrap_or_default()
}

fn read_claude_help(binary: &Path, env: &HashMap<String, String>) -> Option<String> {
    let mut child = std::process::Command::new(binary)
        .arg("--help")
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + HELP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    Some(out)
}

/// Best-effort discovery of Claude models and effort levels. Never errors.
/// Result is cached in `AppState`; pass `force: true` to re-scan.
#[tauri::command]
pub fn detect_claude_options(state: State<AppState>, force: Option<bool>) -> ClaudeOptions {
    if force != Some(true) {
        if let Some(cached) = state.claude_options.lock().clone() {
            return cached;
        }
    }
    let result = scan_options(&state);
    *state.claude_options.lock() = Some(result.clone());
    result
}

fn scan_options(state: &AppState) -> ClaudeOptions {
    let binary = locate_claude(state);
    let models = binary
        .as_deref()
        .and_then(|path| std::fs::read(path).ok())
        .map(|bytes| build_models(scan_aliases(&bytes), "binary"))
        .filter(|models| !models.is_empty())
        .unwrap_or_else(detect_from_sessions);
    let effort_levels = binary
        .as_deref()
        .and_then(|path| read_claude_help(path, &shell_env(state)))
        .and_then(|help| parse_effort_levels(&help))
        .unwrap_or_else(|| FALLBACK_EFFORT_LEVELS.iter().map(|s| s.to_string()).collect());
    ClaudeOptions { models, effort_levels }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_tokens_and_stops_at_non_alias_bytes() {
        let blob = b"xx claude-opus-4-8[1m] yy claude-sonnet-4-6\0tail";
        let toks = scan_aliases(blob);
        assert!(toks.contains(&"claude-opus-4-8".to_string()));
        assert!(toks.contains(&"claude-sonnet-4-6".to_string()));
    }

    #[test]
    fn resolves_the_default_opencode_install_path() {
        assert_eq!(
            default_binary_path_for("opencode", Some(Path::new("/home/developer"))),
            Some(PathBuf::from("/home/developer/.opencode/bin/opencode"))
        );
        assert_eq!(default_binary_path_for("claude", Some(Path::new("/home/developer"))), None);
    }

    #[test]
    fn normalizes_clean_alias() {
        assert_eq!(
            normalize_alias("claude-opus-4-8"),
            Some(("claude-opus-4-8".to_string(), "opus".to_string()))
        );
    }

    #[test]
    fn accepts_single_major_and_unknown_family() {
        assert_eq!(
            normalize_alias("claude-fable-5"),
            Some(("claude-fable-5".to_string(), "fable".to_string()))
        );
        assert_eq!(
            normalize_alias("claude-newfamily-7"),
            Some(("claude-newfamily-7".to_string(), "newfamily".to_string()))
        );
    }

    #[test]
    fn strips_date_and_v1_suffixes() {
        assert_eq!(
            normalize_alias("claude-haiku-4-5-20251001"),
            Some(("claude-haiku-4-5".to_string(), "haiku".to_string()))
        );
        assert_eq!(
            normalize_alias("claude-opus-4-6-v1"),
            Some(("claude-opus-4-6".to_string(), "opus".to_string()))
        );
        assert_eq!(
            normalize_alias("claude-opus-4-6-fast"),
            Some(("claude-opus-4-6".to_string(), "opus".to_string()))
        );
    }

    #[test]
    fn rejects_zero_minor_numeric_family_and_no_version() {
        assert_eq!(normalize_alias("claude-opus-4-0"), None);
        assert_eq!(normalize_alias("claude-3-5-sonnet"), None);
        assert_eq!(normalize_alias("claude-code"), None);
        assert_eq!(normalize_alias("claude-cli"), None);
    }

    #[test]
    fn rejects_versioned_non_model_families() {
        assert_eq!(normalize_alias("claude-code-4"), None);
        assert_eq!(normalize_alias("claude-cli-2-1"), None);
    }

    #[test]
    fn scan_handles_empty_and_binary_noise() {
        assert!(scan_aliases(b"").is_empty());
        assert!(scan_aliases(&[0u8; 64]).is_empty());
    }

    #[test]
    fn build_adds_1m_variant_for_opus_only_and_dedupes() {
        let toks = vec![
            "claude-opus-4-9".to_string(),
            "claude-opus-4-9-20260101".to_string(),
            "claude-fable-5".to_string(),
        ];
        let models = build_models(toks, "binary");
        let ids: Vec<&str> = models.iter().map(|m| m.model_id.as_str()).collect();
        assert!(ids.contains(&"claude-opus-4-9"));
        assert!(ids.contains(&"claude-opus-4-9[1m]"));
        assert!(ids.contains(&"claude-fable-5"));
        assert!(!ids.contains(&"claude-fable-5[1m]"));
        assert_eq!(ids.iter().filter(|i| **i == "claude-opus-4-9").count(), 1);
        assert!(models.iter().all(|m| m.source == "binary"));
    }
    #[test]
    fn rejects_new_denylisted_families() {
        assert_eq!(normalize_alias("claude-desktop-3"), None);
        assert_eq!(normalize_alias("claude-eval-9"), None);
        assert_eq!(normalize_alias("claude-instant-1"), None);
    }

    #[test]
    fn treats_date_segment_as_no_minor() {
        assert_eq!(
            normalize_alias("claude-opus-4-20250514"),
            Some(("claude-opus-4".to_string(), "opus".to_string()))
        );
    }

    #[test]
    fn flags_latest_per_family_and_inherits_it_for_1m() {
        let toks = vec![
            "claude-opus-4-8".to_string(),
            "claude-opus-5-5".to_string(),
            "claude-opus-5".to_string(),
            "claude-sonnet-5".to_string(),
            "claude-sonnet-4-6".to_string(),
        ];
        let models = build_models(toks, "binary");
        let latest: Vec<&str> = models.iter().filter(|m| m.latest).map(|m| m.model_id.as_str()).collect();
        assert_eq!(latest, vec!["claude-opus-5-5", "claude-opus-5-5[1m]", "claude-sonnet-5"]);
    }

    #[test]
    fn sorts_by_family_then_newest_version_first() {
        let toks = vec![
            "claude-sonnet-4-6".to_string(),
            "claude-opus-4-8".to_string(),
            "claude-sonnet-5".to_string(),
            "claude-opus-5-5".to_string(),
        ];
        let ids: Vec<String> = build_models(toks, "binary").into_iter().map(|m| m.model_id).collect();
        assert_eq!(
            ids,
            vec![
                "claude-opus-5-5",
                "claude-opus-5-5[1m]",
                "claude-opus-4-8",
                "claude-opus-4-8[1m]",
                "claude-sonnet-5",
                "claude-sonnet-4-6",
            ]
        );
    }

    #[test]
    fn parses_effort_levels_from_help() {
        let help = "  --debug        Enable debug\n  --effort <level>                      Effort level for the current session\n                                        (low, medium, high, xhigh, max)\n  --environment <id>   Cloud env (not this one)\n";
        assert_eq!(
            parse_effort_levels(help),
            Some(vec!["low", "medium", "high", "xhigh", "max"].into_iter().map(String::from).collect())
        );
    }

    #[test]
    fn effort_parser_returns_none_without_flag_or_list() {
        assert_eq!(parse_effort_levels(""), None);
        assert_eq!(parse_effort_levels("  --model <model>  (opus, sonnet)"), None);
        assert_eq!(parse_effort_levels("  --effort <level>  Effort level\n"), None);
    }

    #[test]
    fn effort_parser_drops_non_word_entries() {
        let help = "--effort <level>  (low, High, x y, max)";
        assert_eq!(parse_effort_levels(help), Some(vec!["low".to_string(), "max".to_string()]));
    }
}

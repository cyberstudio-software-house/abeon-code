use std::path::{Path, PathBuf};
use tauri::State;

use crate::commands::settings::{ensure_shell_env, resolve_shell};
use crate::domain::DetectedModel;
use crate::state::AppState;

const MAX_FALLBACK_FILES: usize = 50;

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
    let major: u32 = parts.next()?.parse().ok()?;
    let minor: Option<u32> = parts.next().and_then(|s| s.parse::<u32>().ok());
    if minor == Some(0) {
        return None;
    }
    let clean = match minor {
        Some(m) => format!("claude-{family}-{major}-{m}"),
        None => format!("claude-{family}-{major}"),
    };
    Some((clean, family.to_string()))
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
                });
            }
        }
    }
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
        .or_else(|| std::env::var("PATH").ok())?;
    for dir in path_var.split(':') {
        if dir.is_empty() {
            continue;
        }
        let candidate = Path::new(dir).join(name);
        if candidate.is_file() {
            return Some(std::fs::canonicalize(&candidate).unwrap_or(candidate));
        }
    }
    None
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

/// Best-effort model discovery. Never errors: returns `[]` when nothing is found.
/// Result is cached in `AppState` (the CLI binary is large); pass `force: true`
/// to bypass the cache and re-scan.
#[tauri::command]
pub fn detect_models(state: State<AppState>, force: Option<bool>) -> Vec<DetectedModel> {
    if force != Some(true) {
        if let Some(cached) = state.detected_models.lock().clone() {
            return cached;
        }
    }
    let result = scan_models(&state);
    *state.detected_models.lock() = Some(result.clone());
    result
}

/// Run the actual scan: CLI binary first, session JSONL fallback.
fn scan_models(state: &AppState) -> Vec<DetectedModel> {
    if let Some(path) = locate_claude(state) {
        if let Ok(bytes) = std::fs::read(&path) {
            let models = build_models(scan_aliases(&bytes), "binary");
            if !models.is_empty() {
                return models;
            }
        }
    }
    detect_from_sessions()
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
}

use crate::domain::{Provider, ProviderLimits, RateLimitWindow};
use crate::error::AppResult;
use chrono::DateTime;
use serde::Deserialize;
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;

const SHORT_WINDOW_MINUTES: u64 = 300;
const WEEKLY_WINDOW_MINUTES: u64 = 7 * 24 * 60;

#[derive(Deserialize)]
struct ClaudeUsageCache {
    limits: ClaudeLimits,
}

#[derive(Deserialize)]
struct ClaudeLimits {
    five_hour: Option<ClaudeWindow>,
    seven_day: Option<ClaudeWindow>,
}

#[derive(Deserialize)]
struct ClaudeWindow {
    utilization: f64,
    resets_at: Option<String>,
}

fn parse_iso_timestamp(value: Option<&str>) -> Option<i64> {
    value
        .and_then(|timestamp| DateTime::parse_from_rfc3339(timestamp).ok())
        .map(|timestamp| timestamp.timestamp())
}

fn claude_window(value: Option<ClaudeWindow>, window_minutes: u64) -> Option<RateLimitWindow> {
    value.map(|window| RateLimitWindow {
        used_percent: window.utilization,
        window_minutes,
        resets_at: parse_iso_timestamp(window.resets_at.as_deref()),
    })
}

pub fn parse_claude_limits<R: Read>(reader: R) -> AppResult<ProviderLimits> {
    let cache: ClaudeUsageCache = serde_json::from_reader(reader)?;
    Ok(ProviderLimits {
        short_window: claude_window(cache.limits.five_hour, SHORT_WINDOW_MINUTES),
        weekly: claude_window(cache.limits.seven_day, WEEKLY_WINDOW_MINUTES),
    })
}

fn codex_window(value: &Value) -> Option<RateLimitWindow> {
    Some(RateLimitWindow {
        used_percent: value.get("used_percent")?.as_f64()?,
        window_minutes: value.get("window_minutes")?.as_u64()?,
        resets_at: value.get("resets_at").and_then(Value::as_i64),
    })
}

fn classify_codex_window(limits: &mut ProviderLimits, window: RateLimitWindow) {
    if window.window_minutes >= WEEKLY_WINDOW_MINUTES {
        limits.weekly = Some(window);
    } else {
        limits.short_window = Some(window);
    }
}

pub fn parse_codex_limits<R: BufRead>(reader: R) -> ProviderLimits {
    let mut latest = None;
    for line in reader.lines().map_while(Result::ok) {
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(rate_limits) = value
            .get("payload")
            .and_then(|payload| payload.get("rate_limits"))
        else {
            continue;
        };
        let mut limits = ProviderLimits::default();
        for key in ["primary", "secondary"] {
            if let Some(window) = rate_limits.get(key).and_then(codex_window) {
                classify_codex_window(&mut limits, window);
            }
        }
        latest = Some(limits);
    }
    latest.unwrap_or_default()
}

fn claude_limits_root(home: &Path) -> ProviderLimits {
    let path = home.join(".claude").join(".usage_cache.json");
    let Ok(file) = fs::File::open(path) else {
        return ProviderLimits::default();
    };
    parse_claude_limits(BufReader::new(file)).unwrap_or_default()
}

fn codex_limits_root(home: &Path) -> ProviderLimits {
    let root = home.join(".codex").join("sessions");
    for session in crate::sessions::codex::reader::scan_sessions(&root) {
        let Ok(reader) = crate::sessions::codex::reader::open_lines(&session.path) else {
            continue;
        };
        let limits = parse_codex_limits(reader);
        if limits.short_window.is_some() || limits.weekly.is_some() {
            return limits;
        }
    }
    ProviderLimits::default()
}

pub fn read_provider_limits(home: &Path, provider: Provider) -> ProviderLimits {
    match provider {
        Provider::Claude => claude_limits_root(home),
        Provider::Codex => codex_limits_root(home),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Cursor;
    use tempfile::TempDir;

    #[test]
    fn parses_claude_short_and_weekly_limits() {
        let input = r#"{
            "limits": {
                "five_hour": {"utilization": 24.0, "resets_at": "2026-09-15T10:00:00Z"},
                "seven_day": {"utilization": 67.0, "resets_at": "2026-09-18T00:00:00Z"}
            }
        }"#;

        let result = parse_claude_limits(Cursor::new(input)).unwrap();

        let short = result.short_window.unwrap();
        assert_eq!(short.used_percent, 24.0);
        assert_eq!(short.window_minutes, 300);
        assert_eq!(short.resets_at, Some(1_789_466_400));
        let weekly = result.weekly.unwrap();
        assert_eq!(weekly.used_percent, 67.0);
        assert_eq!(weekly.window_minutes, 10_080);
        assert_eq!(weekly.resets_at, Some(1_789_689_600));
    }

    #[test]
    fn parses_latest_codex_rate_limit_event_and_classifies_windows() {
        let input = concat!(
            r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":11.0,"window_minutes":300,"resets_at":1789459200},"secondary":{"used_percent":30.0,"window_minutes":10080,"resets_at":1789678800}}}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":24.0,"window_minutes":300,"resets_at":1789459300},"secondary":{"used_percent":67.0,"window_minutes":10080,"resets_at":1789678900}}}}"#,
        );

        let result = parse_codex_limits(Cursor::new(input));

        let short = result.short_window.unwrap();
        assert_eq!(short.used_percent, 24.0);
        assert_eq!(short.window_minutes, 300);
        assert_eq!(short.resets_at, Some(1_789_459_300));
        let weekly = result.weekly.unwrap();
        assert_eq!(weekly.used_percent, 67.0);
        assert_eq!(weekly.window_minutes, 10_080);
        assert_eq!(weekly.resets_at, Some(1_789_678_900));
    }

    #[test]
    fn ignores_malformed_codex_lines_and_missing_windows() {
        let input = concat!(
            "not-json\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":14.0,"window_minutes":10080,"resets_at":1789974906},"secondary":null}}}"#,
        );

        let result = parse_codex_limits(Cursor::new(input));

        assert!(result.short_window.is_none());
        assert_eq!(result.weekly.unwrap().used_percent, 14.0);
    }

    #[test]
    fn reads_claude_limits_from_the_usage_cache() {
        let home = TempDir::new().unwrap();
        let directory = home.path().join(".claude");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join(".usage_cache.json"),
            r#"{
            "limits": {
                "five_hour": {"utilization": 31.0, "resets_at": null},
                "seven_day": {"utilization": 72.0, "resets_at": null}
            }
        }"#,
        )
        .unwrap();

        let result = read_provider_limits(home.path(), Provider::Claude);

        assert_eq!(result.short_window.unwrap().used_percent, 31.0);
        assert_eq!(result.weekly.unwrap().used_percent, 72.0);
    }

    #[test]
    fn reads_codex_limits_from_a_rollout() {
        let home = TempDir::new().unwrap();
        let directory = home
            .path()
            .join(".codex")
            .join("sessions")
            .join("2026")
            .join("09")
            .join("15");
        fs::create_dir_all(&directory).unwrap();
        let content = concat!(
            r#"{"type":"session_meta","payload":{"id":"abc","cwd":"/project"}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":42.0,"window_minutes":300,"resets_at":1789459200},"secondary":{"used_percent":81.0,"window_minutes":10080,"resets_at":1789678800}}}}"#,
        );
        fs::write(directory.join("rollout-test.jsonl"), content).unwrap();

        let result = read_provider_limits(home.path(), Provider::Codex);

        assert_eq!(result.short_window.unwrap().used_percent, 42.0);
        assert_eq!(result.weekly.unwrap().used_percent, 81.0);
    }
}

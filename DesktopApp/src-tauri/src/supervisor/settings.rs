use crate::db::settings_repo;
use crate::domain::supervisor::SupervisorLevel;
use rusqlite::Connection;
use std::time::Duration;

const DEFAULT_GRACE_SECONDS: u64 = 60;
const DEFAULT_PRESENCE_MINUTES: u64 = 5;

#[derive(Clone, Debug, PartialEq)]
pub struct SupervisorSettings {
    pub level: SupervisorLevel,
    pub grace: Duration,
    pub presence: Duration,
    pub model_id: Option<String>,
    pub extra_rules: Vec<String>,
}

fn read(conn: &Connection, key: &str) -> Option<String> {
    settings_repo::get(conn, key).ok().flatten()
}

fn read_number(conn: &Connection, key: &str, default: u64, min: u64, max: u64) -> u64 {
    read(conn, key)
        .and_then(|value| value.trim().parse::<u64>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn parse_level(value: &str) -> SupervisorLevel {
    match value.trim() {
        "relay" => SupervisorLevel::Relay,
        "assistant" => SupervisorLevel::Assistant,
        "autonomous" => SupervisorLevel::Autonomous,
        _ => SupervisorLevel::Off,
    }
}

impl SupervisorSettings {
    pub fn load(conn: &Connection) -> SupervisorSettings {
        let level = read(conn, "supervisorLevel")
            .map(|value| parse_level(&value))
            .unwrap_or_default();
        let grace = read_number(conn, "supervisorGraceSeconds", DEFAULT_GRACE_SECONDS, 15, 300);
        let presence = read_number(conn, "supervisorPresenceMinutes", DEFAULT_PRESENCE_MINUTES, 1, 60);
        let model_id = read(conn, "supervisorModelId")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let extra_rules = read(conn, "supervisorExtraRules")
            .and_then(|value| serde_json::from_str::<Vec<String>>(&value).ok())
            .unwrap_or_default();
        SupervisorSettings {
            level,
            grace: Duration::from_secs(grace),
            presence: Duration::from_secs(presence * 60),
            model_id,
            extra_rules,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, settings_repo};
    use crate::domain::supervisor::SupervisorLevel;
    use std::time::Duration;
    use tempfile::NamedTempFile;

    fn pool() -> crate::db::DbPool {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        std::mem::forget(file);
        init_pool(&path).unwrap()
    }

    #[test]
    fn defaults_when_keys_missing() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let settings = SupervisorSettings::load(&conn);
        assert_eq!(settings.level, SupervisorLevel::Off);
        assert_eq!(settings.grace, Duration::from_secs(60));
        assert_eq!(settings.presence, Duration::from_secs(300));
        assert_eq!(settings.model_id, None);
        assert!(settings.extra_rules.is_empty());
    }

    #[test]
    fn clamps_and_parses() {
        let pool = pool();
        let conn = pool.get().unwrap();
        settings_repo::set(&conn, "supervisorGraceSeconds", "5").unwrap();
        settings_repo::set(&conn, "supervisorPresenceMinutes", "999").unwrap();
        settings_repo::set(&conn, "supervisorLevel", "assistant").unwrap();
        settings_repo::set(&conn, "supervisorModelId", "claude-sonnet-5-5").unwrap();
        settings_repo::set(&conn, "supervisorExtraRules", r#"["bash:^make deploy"]"#).unwrap();
        let settings = SupervisorSettings::load(&conn);
        assert_eq!(settings.level, SupervisorLevel::Assistant);
        assert_eq!(settings.grace, Duration::from_secs(15));
        assert_eq!(settings.presence, Duration::from_secs(60 * 60));
        assert_eq!(settings.model_id.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(settings.extra_rules, vec!["bash:^make deploy".to_string()]);
    }

    #[test]
    fn invalid_values_fall_back_to_defaults() {
        let pool = pool();
        let conn = pool.get().unwrap();
        settings_repo::set(&conn, "supervisorLevel", "bogus").unwrap();
        settings_repo::set(&conn, "supervisorGraceSeconds", "abc").unwrap();
        settings_repo::set(&conn, "supervisorModelId", "").unwrap();
        settings_repo::set(&conn, "supervisorExtraRules", "not json").unwrap();
        let settings = SupervisorSettings::load(&conn);
        assert_eq!(settings.level, SupervisorLevel::Off);
        assert_eq!(settings.grace, Duration::from_secs(60));
        assert_eq!(settings.model_id, None);
        assert!(settings.extra_rules.is_empty());
    }
}

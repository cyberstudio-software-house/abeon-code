use std::fmt;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::PLUGIN_ID;

const TOKEN_KEY: &str = "DISCORD_BOT_TOKEN";
const ENV_FILE: &str = ".env";
const ACCESS_FILE: &str = "access.json";
const APPROVED_DIR: &str = "approved";
const CHANNELS_DIR: &str = "channels";
const DISCORD_DIR: &str = "discord";
const SETTINGS_FILE: &str = "settings.json";
const FAILURE_CACHE_FILE: &str = "mcp-needs-auth-cache.json";
const FAILURE_CACHE_KEY: &str = "plugin:discord:discord";
const ENABLED_PLUGINS_KEY: &str = "enabledPlugins";
const DEFAULT_DM_POLICY: &str = "pairing";
const ALLOWLIST_DM_POLICY: &str = "allowlist";
const TEMP_SUFFIX: &str = ".tmp";
const PRIVATE_FILE_MODE: u32 = 0o600;
const PRIVATE_DIR_MODE: u32 = 0o700;
const INVALID_TOKEN: &str = "Token ma nieprawidłowy format";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Access {
    pub dm_policy: String,
    pub allow_from: Vec<String>,
    pub pending_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedUser {
    pub sender_id: String,
    pub chat_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairError {
    UnknownCode,
    Expired,
    Io(String),
}

impl fmt::Display for PairError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PairError::UnknownCode => write!(f, "Nieznany kod parowania"),
            PairError::Expired => write!(f, "Kod parowania wygasł — napisz do bota ponownie"),
            PairError::Io(reason) => write!(f, "Nie udało się zapisać dostępu: {reason}"),
        }
    }
}

impl From<std::io::Error> for PairError {
    fn from(error: std::io::Error) -> Self {
        PairError::Io(error.to_string())
    }
}

pub struct DiscordFiles {
    dir: PathBuf,
}

impl DiscordFiles {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn for_claude_home(claude_home: &Path) -> Self {
        Self::new(claude_home.join(CHANNELS_DIR).join(DISCORD_DIR))
    }

    pub fn token(&self) -> Option<String> {
        let body = std::fs::read_to_string(self.dir.join(ENV_FILE)).ok()?;
        body.lines().find_map(token_from_line)
    }

    pub fn save_token(&self, token: &str) -> std::io::Result<()> {
        let token = validate_token(token)
            .map_err(|reason| std::io::Error::new(std::io::ErrorKind::InvalidInput, reason))?;
        self.ensure_dir()?;
        let path = self.dir.join(ENV_FILE);
        let existing = std::fs::read_to_string(&path).unwrap_or_default();
        let entry = format!("{TOKEN_KEY}={token}");
        let mut replaced = false;
        let mut lines: Vec<String> = existing
            .lines()
            .map(|line| {
                if is_token_line(line) {
                    replaced = true;
                    entry.clone()
                } else {
                    line.to_string()
                }
            })
            .collect();
        if !replaced {
            lines.push(entry);
        }
        let mut body = lines.join("\n");
        body.push('\n');
        write_private(&path, body.as_bytes())
    }

    pub fn access(&self) -> Access {
        let value = self.read_access();
        Access {
            dm_policy: value
                .get("dmPolicy")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_DM_POLICY)
                .to_string(),
            allow_from: value
                .get("allowFrom")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default(),
            pending_count: value
                .get("pending")
                .and_then(Value::as_object)
                .map_or(0, Map::len),
        }
    }

    pub fn pair(&self, code: &str, now_ms: i64) -> Result<PairedUser, PairError> {
        let mut access = self.read_access();
        let code = code.trim().to_lowercase();
        let entry = access
            .get("pending")
            .and_then(|pending| pending.get(&code))
            .ok_or(PairError::UnknownCode)?;
        let expires_at = entry.get("expiresAt").and_then(Value::as_i64).unwrap_or(0);
        if expires_at < now_ms {
            return Err(PairError::Expired);
        }
        let paired = PairedUser {
            sender_id: string_field(entry, "senderId").ok_or(PairError::UnknownCode)?,
            chat_id: string_field(entry, "chatId").ok_or(PairError::UnknownCode)?,
        };
        if !is_safe_file_name(&paired.sender_id) {
            return Err(PairError::UnknownCode);
        }

        let root = access.as_object_mut().ok_or(PairError::UnknownCode)?;
        let allow_from = root
            .entry("allowFrom")
            .or_insert_with(|| Value::Array(Vec::new()));
        if !allow_from.is_array() {
            *allow_from = Value::Array(Vec::new());
        }
        if let Some(list) = allow_from.as_array_mut() {
            if !list
                .iter()
                .any(|item| item.as_str() == Some(&paired.sender_id))
            {
                list.push(json!(paired.sender_id));
            }
        }
        if let Some(pending) = root.get_mut("pending").and_then(Value::as_object_mut) {
            pending.remove(&code);
        }
        root.insert("dmPolicy".to_string(), json!(ALLOWLIST_DM_POLICY));

        self.ensure_dir()?;
        let body = serde_json::to_vec_pretty(&access).map_err(std::io::Error::other)?;
        write_private(&self.dir.join(ACCESS_FILE), &body)?;
        let approved_dir = self.dir.join(APPROVED_DIR);
        std::fs::create_dir_all(&approved_dir)?;
        write_private(
            &approved_dir.join(&paired.sender_id),
            paired.chat_id.as_bytes(),
        )?;
        Ok(paired)
    }

    fn read_access(&self) -> Value {
        std::fs::read_to_string(self.dir.join(ACCESS_FILE))
            .ok()
            .and_then(|body| serde_json::from_str::<Value>(&body).ok())
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}))
    }

    fn ensure_dir(&self) -> std::io::Result<()> {
        if self.dir.exists() {
            return Ok(());
        }
        if let Some(parent) = self.dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        create_private_dir(&self.dir)
    }
}

pub fn validate_token(token: &str) -> Result<String, &'static str> {
    let trimmed = token.trim();
    if trimmed.is_empty() || trimmed.chars().any(char::is_whitespace) {
        return Err(INVALID_TOKEN);
    }
    Ok(trimmed.to_string())
}

pub fn global_plugin_enabled(claude_home: &Path) -> bool {
    read_json_file(&claude_home.join(SETTINGS_FILE))
        .and_then(|settings| {
            settings
                .get(ENABLED_PLUGINS_KEY)
                .and_then(|plugins| plugins.get(PLUGIN_ID))
                .and_then(Value::as_bool)
        })
        .unwrap_or(false)
}

pub fn disable_global_plugin(claude_home: &Path) -> std::io::Result<bool> {
    let path = claude_home.join(SETTINGS_FILE);
    let Some(mut settings) = read_json_file(&path) else {
        return Ok(false);
    };
    let Some(entry) = settings
        .get_mut(ENABLED_PLUGINS_KEY)
        .and_then(Value::as_object_mut)
        .and_then(|plugins| plugins.get_mut(PLUGIN_ID))
    else {
        return Ok(false);
    };
    if entry.as_bool() == Some(false) {
        return Ok(false);
    }
    *entry = Value::Bool(false);
    write_json_file(&path, &settings)?;
    Ok(true)
}

pub fn clear_failure_cache(claude_home: &Path) -> std::io::Result<bool> {
    let path = claude_home.join(FAILURE_CACHE_FILE);
    let Some(mut cache) = read_json_file(&path) else {
        return Ok(false);
    };
    let removed = cache
        .as_object_mut()
        .and_then(|entries| entries.remove(FAILURE_CACHE_KEY))
        .is_some();
    if !removed {
        return Ok(false);
    }
    write_json_file(&path, &cache)?;
    Ok(true)
}

fn token_from_line(line: &str) -> Option<String> {
    let value = line.strip_prefix(TOKEN_KEY)?.strip_prefix('=')?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn is_token_line(line: &str) -> bool {
    line.strip_prefix(TOKEN_KEY)
        .is_some_and(|rest| rest.starts_with('='))
}

fn string_field(entry: &Value, key: &str) -> Option<String> {
    entry.get(key).and_then(Value::as_str).map(str::to_string)
}

fn is_safe_file_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains(['/', '\\', '\0'])
}

fn read_json_file(path: &Path) -> Option<Value> {
    let body = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&body)
        .ok()
        .filter(Value::is_object)
}

fn write_json_file(path: &Path, value: &Value) -> std::io::Result<()> {
    let body = serde_json::to_vec_pretty(value).map_err(std::io::Error::other)?;
    write_atomic(path, &body, None)
}

fn write_private(path: &Path, body: &[u8]) -> std::io::Result<()> {
    write_atomic(path, body, Some(PRIVATE_FILE_MODE))
}

fn write_atomic(path: &Path, body: &[u8], mode: Option<u32>) -> std::io::Result<()> {
    let mut temp = path.as_os_str().to_owned();
    temp.push(TEMP_SUFFIX);
    let temp = PathBuf::from(temp);
    let result = write_temp(&temp, body, mode).and_then(|()| std::fs::rename(&temp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

fn write_temp(temp: &Path, body: &[u8], mode: Option<u32>) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    if let Some(mode) = mode {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    let mut file = options.open(temp)?;
    file.write_all(body)?;
    file.sync_all()
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(PRIVATE_DIR_MODE);
    }
    builder.create(path)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::Path;

    const NOW: i64 = 5_000_000;
    const SENDER: &str = "844465727611863040";
    const CHAT: &str = "1565442299968757861";

    fn mode(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    fn pairing_fixture(dir: &Path, expires_at: i64) {
        let body = json!({
            "dmPolicy": "pairing",
            "allowFrom": [],
            "groups": {"g1": {"requireMention": true, "allowFrom": []}},
            "mentionPatterns": ["@bot"],
            "pending": {"4f7541": {
                "senderId": SENDER,
                "chatId": CHAT,
                "createdAt": 1000,
                "expiresAt": expires_at,
                "replies": 1
            }}
        });
        fs::write(dir.join("access.json"), body.to_string()).unwrap();
    }

    #[test]
    fn save_token_rejects_a_token_with_a_newline() {
        let dir = tempfile::tempdir().unwrap();
        let files = DiscordFiles::new(dir.path().join("discord"));
        let error = files.save_token("abc\nDISCORD_EVIL=1").unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        assert!(!dir.path().join("discord").join(".env").exists());
        assert_eq!(files.token(), None);
    }

    #[test]
    fn token_reads_the_bot_token_line() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join(".env"),
            "FOO=1\nDISCORD_BOT_TOKEN=abc.def\n",
        )
        .unwrap();
        let files = DiscordFiles::new(dir.path().to_path_buf());
        assert_eq!(files.token(), Some("abc.def".to_string()));
    }

    #[test]
    fn token_missing_file_or_line_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let files = DiscordFiles::new(dir.path().to_path_buf());
        assert_eq!(files.token(), None);
        fs::write(dir.path().join(".env"), "FOO=1\n").unwrap();
        assert_eq!(files.token(), None);
    }

    #[test]
    fn save_token_replaces_only_the_token_line_and_sets_mode_600() {
        let dir = tempfile::tempdir().unwrap();
        let env = dir.path().join(".env");
        fs::write(&env, "DISCORD_STATE_DIR=/x\nDISCORD_BOT_TOKEN=old\n").unwrap();
        let files = DiscordFiles::new(dir.path().to_path_buf());
        files.save_token("new").unwrap();
        let body = fs::read_to_string(&env).unwrap();
        assert!(body.contains("DISCORD_STATE_DIR=/x"));
        assert!(body.contains("DISCORD_BOT_TOKEN=new"));
        assert!(!body.contains("old"));
        assert_eq!(mode(&env), 0o600);

        let nested = dir.path().join("missing").join("discord");
        let fresh = DiscordFiles::new(nested.clone());
        fresh.save_token("tok").unwrap();
        assert_eq!(mode(&nested), 0o700);
        assert_eq!(mode(&nested.join(".env")), 0o600);
        assert_eq!(fresh.token(), Some("tok".to_string()));
    }

    #[test]
    fn validate_token_rejects_whitespace_and_empty() {
        for bad in ["", "  ", "a b", "ab\ncd"] {
            assert!(validate_token(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            validate_token(" MTU2.Gx_y-z "),
            Ok("MTU2.Gx_y-z".to_string())
        );
    }

    #[test]
    fn access_defaults_when_missing_or_corrupt() {
        let dir = tempfile::tempdir().unwrap();
        let files = DiscordFiles::new(dir.path().to_path_buf());
        let missing = files.access();
        assert_eq!(missing.dm_policy, "pairing");
        assert!(missing.allow_from.is_empty());
        assert_eq!(missing.pending_count, 0);
        fs::write(dir.path().join("access.json"), "{").unwrap();
        let corrupt = files.access();
        assert_eq!(corrupt.dm_policy, "pairing");
        assert!(corrupt.allow_from.is_empty());
        assert_eq!(corrupt.pending_count, 0);
    }

    #[test]
    fn pair_moves_sender_to_allowlist_and_switches_policy() {
        let dir = tempfile::tempdir().unwrap();
        pairing_fixture(dir.path(), NOW + 3_600_000);
        let files = DiscordFiles::new(dir.path().to_path_buf());
        let paired = files.pair("4F7541 ", NOW).unwrap();
        assert_eq!(
            paired,
            PairedUser {
                sender_id: SENDER.to_string(),
                chat_id: CHAT.to_string()
            }
        );
        let access = read_json(&dir.path().join("access.json"));
        assert_eq!(access["allowFrom"], json!([SENDER]));
        assert_eq!(access["pending"], json!({}));
        assert_eq!(access["dmPolicy"], "allowlist");
        assert_eq!(
            access["groups"],
            json!({"g1": {"requireMention": true, "allowFrom": []}})
        );
        assert_eq!(access["mentionPatterns"], json!(["@bot"]));
        assert_eq!(
            fs::read_to_string(dir.path().join("approved").join(SENDER)).unwrap(),
            CHAT
        );
        assert_eq!(mode(&dir.path().join("access.json")), 0o600);
        let summary = files.access();
        assert_eq!(summary.dm_policy, "allowlist");
        assert_eq!(summary.allow_from, vec![SENDER.to_string()]);
        assert_eq!(summary.pending_count, 0);
    }

    #[test]
    fn pair_dedupes_an_already_allowed_sender() {
        let dir = tempfile::tempdir().unwrap();
        pairing_fixture(dir.path(), NOW + 1000);
        let path = dir.path().join("access.json");
        let mut access = read_json(&path);
        access["allowFrom"] = json!([SENDER]);
        fs::write(&path, access.to_string()).unwrap();
        DiscordFiles::new(dir.path().to_path_buf())
            .pair("4f7541", NOW)
            .unwrap();
        assert_eq!(read_json(&path)["allowFrom"], json!([SENDER]));
    }

    #[test]
    fn pair_rejects_unknown_and_expired_codes() {
        let dir = tempfile::tempdir().unwrap();
        pairing_fixture(dir.path(), NOW - 1);
        let path = dir.path().join("access.json");
        let before = fs::read(&path).unwrap();
        let files = DiscordFiles::new(dir.path().to_path_buf());
        assert_eq!(files.pair("zzzzzz", NOW), Err(PairError::UnknownCode));
        assert_eq!(files.pair("4f7541", NOW), Err(PairError::Expired));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(!dir.path().join("approved").exists());
    }

    #[test]
    fn pair_error_texts_are_polish() {
        assert_eq!(PairError::UnknownCode.to_string(), "Nieznany kod parowania");
        assert_eq!(
            PairError::Expired.to_string(),
            "Kod parowania wygasł — napisz do bota ponownie"
        );
        assert_eq!(
            PairError::Io("boom".to_string()).to_string(),
            "Nie udało się zapisać dostępu: boom"
        );
    }

    #[test]
    fn clear_failure_cache_removes_only_the_discord_key() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("mcp-needs-auth-cache.json");
        fs::write(
            &path,
            r#"{"plugin:discord:discord":{"timestamp":1},"plugin:linear:linear":{"timestamp":2}}"#,
        )
        .unwrap();
        assert!(clear_failure_cache(home.path()).unwrap());
        assert_eq!(
            read_json(&path),
            json!({"plugin:linear:linear": {"timestamp": 2}})
        );
    }

    #[test]
    fn clear_failure_cache_leaves_missing_or_corrupt_files_alone() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("mcp-needs-auth-cache.json");
        assert!(!clear_failure_cache(home.path()).unwrap());
        assert!(!path.exists());

        fs::write(&path, "not json").unwrap();
        assert!(!clear_failure_cache(home.path()).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "not json");

        fs::write(&path, r#"{"plugin:linear:linear":{"timestamp":2}}"#).unwrap();
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();
        assert!(!clear_failure_cache(home.path()).unwrap());
        assert_eq!(fs::metadata(&path).unwrap().modified().unwrap(), mtime);
    }

    #[test]
    fn global_plugin_flag_reads_and_disables_only_the_discord_entry() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("settings.json");
        fs::write(
            &path,
            r#"{"enabledPlugins":{"discord@claude-plugins-official":true,"x@y":true},"hooks":{"Stop":[]}}"#,
        )
        .unwrap();
        assert!(global_plugin_enabled(home.path()));
        assert!(disable_global_plugin(home.path()).unwrap());
        let settings = read_json(&path);
        assert_eq!(
            settings["enabledPlugins"]["discord@claude-plugins-official"],
            false
        );
        assert_eq!(settings["enabledPlugins"]["x@y"], true);
        assert!(settings["hooks"].is_object());
        assert!(!global_plugin_enabled(home.path()));
        assert!(!disable_global_plugin(home.path()).unwrap());
    }

    #[test]
    fn disable_global_plugin_leaves_missing_or_corrupt_files_alone() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("settings.json");
        assert!(!global_plugin_enabled(home.path()));
        assert!(!disable_global_plugin(home.path()).unwrap());
        assert!(!path.exists());
        fs::write(&path, "{").unwrap();
        assert!(!disable_global_plugin(home.path()).unwrap());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{");
    }
}

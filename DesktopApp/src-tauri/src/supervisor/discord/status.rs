use std::path::{Path, PathBuf};

use crate::domain::supervisor::{DiscordBotView, DiscordSetupStatus};

use super::client::{BotInfo, DiscordError};
use super::files::{global_plugin_enabled, DiscordFiles};
use super::DiscordLink;

pub fn setup_status(
    files: &DiscordFiles,
    claude_home: &Path,
    bun: Option<PathBuf>,
    bot: Option<Result<BotInfo, DiscordError>>,
    chat_linked: bool,
    link: &DiscordLink,
) -> DiscordSetupStatus {
    let access = files.access();
    let (bot, bot_error) = match bot {
        Some(Ok(info)) => (
            Some(DiscordBotView {
                name: info.name,
                message_content_intent: info.message_content_intent,
                guild_count: info.guild_count,
            }),
            None,
        ),
        Some(Err(error)) => (None, Some(error.to_string())),
        None => (None, None),
    };
    DiscordSetupStatus {
        bun_path: bun.map(|path| path.display().to_string()),
        token_stored: files.token().is_some(),
        bot,
        bot_error,
        paired_users: access.allow_from.len(),
        pending_pairings: access.pending_count,
        policy: access.dm_policy,
        chat_linked,
        global_plugin_enabled: global_plugin_enabled(claude_home),
        channel_active: link.channel_active,
        blocker: link.blocker.clone(),
        buttons_connected: link.buttons_connected,
        buttons_blocker: link.buttons_blocker.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    const TOKEN: &str = "MTU2.secret-token";

    struct Fixture {
        root: tempfile::TempDir,
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let dir = root.path().join("channels").join("discord");
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join(".env"), format!("DISCORD_BOT_TOKEN={TOKEN}\n")).unwrap();
            fs::write(
                dir.join("access.json"),
                json!({
                    "dmPolicy": "allowlist",
                    "allowFrom": ["844465727611863040"],
                    "pending": {"4f7541": {"senderId": "1", "chatId": "2"}}
                })
                .to_string(),
            )
            .unwrap();
            fs::write(
                root.path().join("settings.json"),
                json!({"enabledPlugins": {"discord@claude-plugins-official": true}}).to_string(),
            )
            .unwrap();
            Fixture { root }
        }

        fn files(&self) -> DiscordFiles {
            DiscordFiles::for_claude_home(self.root.path())
        }
    }

    fn bot_info() -> BotInfo {
        BotInfo {
            name: "AbeonCode".to_string(),
            message_content_intent: true,
            guild_count: Some(1),
        }
    }

    #[test]
    fn status_reports_each_setup_step() {
        let fixture = Fixture::new();
        let link = DiscordLink {
            channel_active: false,
            blocker: Some("Brak tokenu bota Discord".to_string()),
            buttons_connected: false,
            buttons_blocker: None,
        };
        let status = setup_status(
            &fixture.files(),
            fixture.root.path(),
            Some(PathBuf::from("/h/.bun/bin/bun")),
            Some(Ok(bot_info())),
            true,
            &link,
        );
        assert!(status.token_stored);
        assert_eq!(status.paired_users, 1);
        assert_eq!(status.pending_pairings, 1);
        assert_eq!(status.policy, "allowlist");
        assert!(status.global_plugin_enabled);
        assert!(status.chat_linked);
        assert!(!status.channel_active);
        assert_eq!(status.bot.as_ref().unwrap().name, "AbeonCode");
        assert_eq!(status.bot.as_ref().unwrap().guild_count, Some(1));
        assert_eq!(status.bot_error, None);
        assert_eq!(status.blocker.as_deref(), Some("Brak tokenu bota Discord"));
        assert_eq!(status.bun_path.as_deref(), Some("/h/.bun/bin/bun"));
    }

    #[test]
    fn status_reports_the_buttons_connection() {
        let fixture = Fixture::new();
        let link = DiscordLink {
            channel_active: true,
            blocker: None,
            buttons_connected: true,
            buttons_blocker: None,
        };
        let connected = setup_status(
            &fixture.files(),
            fixture.root.path(),
            None,
            None,
            true,
            &link,
        );
        assert!(connected.buttons_connected);
        assert_eq!(connected.buttons_blocker, None);

        let link = DiscordLink {
            buttons_connected: false,
            buttons_blocker: Some("łączenie z Discordem".to_string()),
            ..link
        };
        let waiting = setup_status(
            &fixture.files(),
            fixture.root.path(),
            None,
            None,
            true,
            &link,
        );
        assert!(!waiting.buttons_connected);
        assert_eq!(
            waiting.buttons_blocker.as_deref(),
            Some("łączenie z Discordem")
        );
    }

    #[test]
    fn status_reports_a_rejected_token() {
        let fixture = Fixture::new();
        let status = setup_status(
            &fixture.files(),
            fixture.root.path(),
            None,
            Some(Err(DiscordError::Unauthorized)),
            false,
            &DiscordLink::default(),
        );
        assert_eq!(status.bot, None);
        assert_eq!(
            status.bot_error.as_deref(),
            Some("Discord odrzucił token bota")
        );
        assert_eq!(status.bun_path, None);
    }

    #[test]
    fn status_without_a_token_skips_the_bot() {
        let root = tempfile::tempdir().unwrap();
        let files = DiscordFiles::for_claude_home(root.path());
        let status = setup_status(
            &files,
            root.path(),
            None,
            None,
            false,
            &DiscordLink::default(),
        );
        assert!(!status.token_stored);
        assert_eq!(status.bot, None);
        assert_eq!(status.bot_error, None);
        assert_eq!(status.policy, "pairing");
        assert!(!status.global_plugin_enabled);
    }

    #[test]
    fn status_never_contains_the_token() {
        let fixture = Fixture::new();
        let status = setup_status(
            &fixture.files(),
            fixture.root.path(),
            None,
            Some(Ok(bot_info())),
            true,
            &DiscordLink::default(),
        );
        let json = serde_json::to_string(&status).unwrap();
        assert!(!json.contains(TOKEN));
    }
}

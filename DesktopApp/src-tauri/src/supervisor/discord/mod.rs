pub mod client;
pub mod files;
pub mod poll;
pub mod preflight;
pub mod registry;
pub mod render;
pub mod replies;
pub mod status;

pub const PLUGIN_ID: &str = "discord@claude-plugins-official";
pub const CHANNEL_ARG: &str = "plugin:discord@claude-plugins-official";
pub const PLUGIN_TOOLS: &str = "mcp__plugin_discord_discord__*";

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DiscordLink {
    pub channel_active: bool,
    pub blocker: Option<String>,
}

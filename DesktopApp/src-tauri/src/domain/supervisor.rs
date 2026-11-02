use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum SupervisorLevel {
    #[default]
    Off,
    Relay,
    Assistant,
    Autonomous,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct MenuQuestion {
    pub question: String,
    pub header: Option<String>,
    pub options: Vec<String>,
    pub multi_select: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum CardPhase {
    Grace,
    Paused,
    WithSupervisor,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct QuestionCardView {
    pub question_id: String,
    pub session_id: String,
    pub questions: Vec<MenuQuestion>,
    pub phase: CardPhase,
    #[ts(type = "number | null")]
    pub deadline_ms: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum EscalationChannel {
    App,
    Discord,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct EscalationView {
    pub id: String,
    pub session_id: String,
    pub question_id: String,
    #[ts(type = "number | null")]
    pub project_id: Option<i64>,
    pub label: String,
    pub summary: String,
    pub channel: EscalationChannel,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct ApprovalView {
    pub id: String,
    pub session_id: String,
    #[ts(type = "number | null")]
    pub project_id: Option<i64>,
    pub label: String,
    pub action: String,
    pub detail: String,
    pub code: String,
    pub channel: EscalationChannel,
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct SupervisorSnapshot {
    pub level: SupervisorLevel,
    pub running: bool,
    pub ready: bool,
    pub pty_id: Option<String>,
    pub present: bool,
    pub away: bool,
    pub discord_active: bool,
    pub escalations: Vec<EscalationView>,
    pub approvals: Vec<ApprovalView>,
    pub cards: Vec<QuestionCardView>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct SessionRebound {
    pub pty_id: String,
    pub session_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DecisionEntry {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub created_at: i64,
    pub session_id: Option<String>,
    pub kind: String,
    pub question: String,
    pub decision: String,
    pub rationale: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DiscordBotView {
    pub name: String,
    pub message_content_intent: bool,
    #[ts(type = "number | null")]
    pub guild_count: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DiscordSetupStatus {
    pub bun_path: Option<String>,
    pub token_stored: bool,
    pub bot: Option<DiscordBotView>,
    pub bot_error: Option<String>,
    pub paired_users: usize,
    pub pending_pairings: usize,
    pub policy: String,
    pub chat_linked: bool,
    pub global_plugin_enabled: bool,
    pub channel_active: bool,
    pub blocker: Option<String>,
}

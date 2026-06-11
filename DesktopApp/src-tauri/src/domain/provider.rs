use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn id(&self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_camel_case() {
        assert_eq!(serde_json::to_string(&Provider::Claude).unwrap(), "\"claude\"");
        assert_eq!(serde_json::to_string(&Provider::Codex).unwrap(), "\"codex\"");
    }

    #[test]
    fn deserializes_camel_case() {
        assert_eq!(serde_json::from_str::<Provider>("\"codex\"").unwrap(), Provider::Codex);
        assert_eq!(serde_json::from_str::<Provider>("\"claude\"").unwrap(), Provider::Claude);
    }

    #[test]
    fn rejects_unknown_variant() {
        assert!(serde_json::from_str::<Provider>("\"openai\"").is_err());
    }
}

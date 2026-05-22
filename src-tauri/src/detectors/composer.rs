use std::path::Path;
use super::{DetectedScript, ScriptDetector};

pub struct ComposerDetector;

impl ScriptDetector for ComposerDetector {
    fn name(&self) -> &str { "composer" }
    fn detect(&self, path: &Path) -> Vec<DetectedScript> {
        let f = path.join("composer.json");
        let Ok(text) = std::fs::read_to_string(&f) else { return vec![]; };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![]; };
        let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) else { return vec![]; };
        scripts.keys().map(|name| DetectedScript {
            source: "composer".into(),
            label: format!("composer {name}"),
            command: format!("composer {name}"),
            description: None,
        }).collect()
    }
}

use std::path::Path;
use super::{DetectedScript, ScriptDetector};

pub struct DdevDetector;

impl ScriptDetector for DdevDetector {
    fn name(&self) -> &str { "ddev" }
    fn detect(&self, path: &Path) -> Vec<DetectedScript> {
        if !path.join(".ddev").join("config.yaml").exists()
            && !path.join(".ddev").join("config.yml").exists() {
            return vec![];
        }
        let presets = [
            ("start", "ddev start"),
            ("stop", "ddev stop"),
            ("restart", "ddev restart"),
            ("ssh", "ddev ssh"),
            ("logs", "ddev logs -f"),
            ("describe", "ddev describe"),
        ];
        presets.iter().map(|(name, cmd)| DetectedScript {
            source: "ddev".into(),
            label: format!("ddev {name}"),
            command: cmd.to_string(),
            description: None,
            subdir: None,
        }).collect()
    }
}

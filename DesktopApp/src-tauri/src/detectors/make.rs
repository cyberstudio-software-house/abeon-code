use std::path::Path;
use super::{DetectedScript, ScriptDetector};

pub struct MakeDetector;

impl ScriptDetector for MakeDetector {
    fn name(&self) -> &str { "make" }
    fn detect(&self, path: &Path) -> Vec<DetectedScript> {
        let mf = path.join("Makefile");
        let Ok(text) = std::fs::read_to_string(&mf) else { return vec![]; };
        let mut out = Vec::new();
        for line in text.lines() {
            let trimmed = line.trim_start();
            if trimmed.starts_with('#') || trimmed.starts_with('\t') { continue; }
            if let Some(idx) = trimmed.find(':') {
                let name = trimmed[..idx].trim();
                if name.is_empty() || name.contains(' ') || name.contains('=') { continue; }
                if name.starts_with('.') { continue; }
                out.push(DetectedScript {
                    source: "make".into(),
                    label: format!("make {name}"),
                    command: format!("make {name}"),
                    description: None,
                    subdir: None,
                });
            }
        }
        out
    }
}

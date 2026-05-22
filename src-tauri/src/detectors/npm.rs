use std::path::Path;
use super::{DetectedScript, ScriptDetector};

pub struct NpmDetector;

impl ScriptDetector for NpmDetector {
    fn name(&self) -> &str { "npm" }
    fn detect(&self, path: &Path) -> Vec<DetectedScript> {
        let pkg = path.join("package.json");
        let Ok(text) = std::fs::read_to_string(&pkg) else { return vec![]; };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![]; };
        let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) else { return vec![]; };
        scripts.iter().map(|(name, body)| DetectedScript {
            source: "npm".into(),
            label: format!("npm run {name}"),
            command: format!("npm run {name}"),
            description: body.as_str().map(String::from),
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn detects_scripts() {
        let td = TempDir::new().unwrap();
        std::fs::write(td.path().join("package.json"),
            r#"{"scripts":{"dev":"vite","build":"vite build"}}"#).unwrap();
        let r = NpmDetector.detect(td.path());
        assert_eq!(r.len(), 2);
        assert!(r.iter().any(|s| s.label == "npm run dev"));
    }

    #[test]
    fn empty_when_no_package_json() {
        let td = TempDir::new().unwrap();
        assert!(NpmDetector.detect(td.path()).is_empty());
    }
}

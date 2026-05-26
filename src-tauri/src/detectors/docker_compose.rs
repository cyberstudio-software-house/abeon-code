use std::path::Path;
use super::{DetectedScript, ScriptDetector};

pub struct DockerComposeDetector;

impl ScriptDetector for DockerComposeDetector {
    fn name(&self) -> &str { "docker" }
    fn detect(&self, path: &Path) -> Vec<DetectedScript> {
        let candidates = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
        if !candidates.iter().any(|f| path.join(f).exists()) {
            return vec![];
        }
        ["up -d", "down", "ps", "logs -f", "build"].iter().map(|sub| DetectedScript {
            source: "docker".into(),
            label: format!("docker compose {sub}"),
            command: format!("docker compose {sub}"),
            description: None,
            subdir: None,
        }).collect()
    }
}

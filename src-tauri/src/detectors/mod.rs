pub mod npm;
pub mod composer;
pub mod make;
pub mod ddev;
pub mod docker_compose;

use serde::Serialize;
use ts_rs::TS;
use std::path::Path;

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DetectedScript {
    pub source: String,
    pub label: String,
    pub command: String,
    pub description: Option<String>,
}

pub trait ScriptDetector: Send + Sync {
    fn name(&self) -> &str;
    fn detect(&self, path: &Path) -> Vec<DetectedScript>;
}

pub fn all_detectors() -> Vec<Box<dyn ScriptDetector>> {
    vec![
        Box::new(npm::NpmDetector),
        Box::new(composer::ComposerDetector),
        Box::new(make::MakeDetector),
        Box::new(ddev::DdevDetector),
        Box::new(docker_compose::DockerComposeDetector),
    ]
}

pub fn detect_all(path: &Path) -> Vec<DetectedScript> {
    all_detectors().iter().flat_map(|d| d.detect(path)).collect()
}

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
    pub subdir: Option<String>,
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
    let detectors = all_detectors();
    let mut out: Vec<DetectedScript> = detectors.iter().flat_map(|d| d.detect(path)).collect();

    let entries = match std::fs::read_dir(path) {
        Ok(it) => it,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let ft = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = match name.to_str() {
            Some(n) => n.to_string(),
            None => continue,
        };
        if name.starts_with('.') || name == "node_modules" || name == "vendor" || name == "target" {
            continue;
        }
        let child_path = entry.path();
        let child_scripts: Vec<DetectedScript> = detectors
            .iter()
            .flat_map(|d| d.detect(&child_path))
            .map(|mut s| {
                s.subdir = Some(name.clone());
                s
            })
            .collect();
        out.extend(child_scripts);
    }
    out
}

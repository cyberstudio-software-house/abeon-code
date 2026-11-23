use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum BuildProvider {
    Bitbucket,
    Github,
    None,
}

impl BuildProvider {
    pub fn as_str(&self) -> &'static str {
        match self {
            BuildProvider::Bitbucket => "bitbucket",
            BuildProvider::Github => "github",
            BuildProvider::None => "none",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "bitbucket" => Some(BuildProvider::Bitbucket),
            "github" => Some(BuildProvider::Github),
            "none" => Some(BuildProvider::None),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub enum Delivery {
    Image,
    Kubemeter,
    None,
}

impl Delivery {
    pub fn as_str(&self) -> &'static str {
        match self {
            Delivery::Image => "image",
            Delivery::Kubemeter => "kubemeter",
            Delivery::None => "none",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "image" => Some(Delivery::Image),
            "kubemeter" => Some(Delivery::Kubemeter),
            "none" => Some(Delivery::None),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DeployFlow {
    pub repo_path: String,
    pub enabled: bool,
    pub remote: String,
    pub build: BuildProvider,
    pub build_repo: String,
    pub production_branch: String,
    pub delivery: Delivery,
    pub namespace: String,
    pub workloads: Vec<String>,
    pub kube_context: Option<String>,
    #[ts(type = "number")]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct FlowProposal {
    pub id: String,
    pub repo_path: String,
    pub flow: DeployFlow,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct RepoFlow {
    pub repo_path: String,
    pub label: String,
    pub remotes: Vec<String>,
    pub flow: Option<DeployFlow>,
    pub proposal: Option<FlowProposal>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[ts(export, export_to = "../../src/types/")]
#[serde(rename_all = "camelCase")]
pub struct DeployChangedEvent {
    pub repo_path: Option<String>,
}

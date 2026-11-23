use crate::domain::deploy::{BuildProvider, DeployFlow, Delivery};
use regex::Regex;
use serde::Serialize;
use std::path::Path;
use std::sync::OnceLock;

const MAX_WORKLOADS: usize = 20;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FlowError {
    pub field: String,
    pub message: String,
}

fn pattern(cell: &'static OnceLock<Regex>, source: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(source).unwrap())
}

fn ref_name() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(&CELL, r"^[A-Za-z0-9][A-Za-z0-9._/-]*$")
}

fn build_repo_name() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(&CELL, r"^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$")
}

fn namespace_name() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(&CELL, r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")
}

fn workload_name() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(&CELL, r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$")
}

fn context_name() -> &'static Regex {
    static CELL: OnceLock<Regex> = OnceLock::new();
    pattern(&CELL, r"^[A-Za-z0-9][A-Za-z0-9._@:/-]*$")
}

fn error(field: &str, message: &str) -> FlowError {
    FlowError { field: field.to_string(), message: message.to_string() }
}

fn check_ref(errors: &mut Vec<FlowError>, field: &str, label: &str, value: &str) {
    if value.is_empty() {
        errors.push(error(field, &format!("Pole „{label}” jest wymagane")));
    } else if !ref_name().is_match(value) || value.contains("..") {
        errors.push(error(field, &format!("Pole „{label}” zawiera niedozwolone znaki")));
    }
}

pub fn validate_flow(flow: &DeployFlow) -> Result<(), Vec<FlowError>> {
    let mut errors = Vec::new();

    if !Path::new(&flow.repo_path).is_absolute() {
        errors.push(error("repoPath", "Ścieżka repozytorium musi być bezwzględna"));
    }

    check_ref(&mut errors, "remote", "Zdalne repozytorium", &flow.remote);
    check_ref(&mut errors, "productionBranch", "Gałąź produkcyjna", &flow.production_branch);

    if flow.build != BuildProvider::None {
        if flow.build_repo.is_empty() {
            errors.push(error("buildRepo", "Repozytorium builda jest wymagane"));
        } else if !build_repo_name().is_match(&flow.build_repo) {
            errors.push(error("buildRepo", "Repozytorium builda musi mieć postać właściciel/nazwa"));
        }
    }

    if flow.delivery != Delivery::None {
        if flow.namespace.is_empty() {
            errors.push(error("namespace", "Przestrzeń nazw jest wymagana"));
        } else if !namespace_name().is_match(&flow.namespace) {
            errors.push(error("namespace", "Przestrzeń nazw zawiera niedozwolone znaki"));
        }
    }

    if flow.workloads.len() > MAX_WORKLOADS {
        errors.push(error("workloads", "Zbyt wiele workloadów (maksymalnie 20)"));
    }
    if flow.workloads.iter().any(|workload| !workload_name().is_match(workload)) {
        errors.push(error("workloads", "Nazwa workloadu zawiera niedozwolone znaki"));
    }

    if let Some(context) = &flow.kube_context {
        if !context_name().is_match(context) {
            errors.push(error("kubeContext", "Kontekst klastra zawiera niedozwolone znaki"));
        }
    }

    if errors.is_empty() { Ok(()) } else { Err(errors) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::test_support::{flow, flow_with};

    #[test]
    fn accepts_a_complete_bitbucket_image_flow() {
        assert_eq!(validate_flow(&flow()), Ok(()));
    }

    #[test]
    fn rejects_values_that_could_change_a_command() {
        for (field, value) in [
            ("namespace", "x; rm -rf ~"),
            ("namespace", "--all-namespaces"),
            ("productionBranch", "-f"),
            ("productionBranch", "a..b"),
            ("buildRepo", "ws/repo/../x"),
            ("kubeContext", "$(id)"),
        ] {
            let errors = validate_flow(&flow_with(field, value)).unwrap_err();
            assert!(errors.iter().any(|e| e.field == field), "{field}={value}");
        }
    }

    #[test]
    fn namespace_and_build_repo_are_optional_when_the_stage_is_off() {
        let mut f = flow();
        f.build = BuildProvider::None;
        f.build_repo = String::new();
        f.delivery = Delivery::None;
        f.namespace = String::new();
        assert_eq!(validate_flow(&f), Ok(()));
    }

    #[test]
    fn rejects_empty_remote_and_relative_repo_path() {
        for (field, value) in [("remote", ""), ("productionBranch", ""), ("repoPath", "relative/dir")] {
            let errors = validate_flow(&flow_with(field, value)).unwrap_err();
            assert!(errors.iter().any(|e| e.field == field), "{field}={value}");
        }
    }

    #[test]
    fn rejects_bad_workloads_and_too_many_of_them() {
        let errors = validate_flow(&flow_with("workloads", "App Name")).unwrap_err();
        assert!(errors.iter().any(|e| e.field == "workloads"));

        let mut f = flow();
        f.workloads = (0..21).map(|index| format!("w{index}")).collect();
        let errors = validate_flow(&f).unwrap_err();
        assert!(errors.iter().any(|e| e.field == "workloads"));

        f.workloads = (0..20).map(|index| format!("w{index}")).collect();
        assert_eq!(validate_flow(&f), Ok(()));
    }

    #[test]
    fn accepts_a_cluster_context_with_separators() {
        let f = flow_with("kubeContext", "user@cluster:prod/eu");
        assert_eq!(validate_flow(&f), Ok(()));
    }

    #[test]
    fn requires_build_repo_and_namespace_when_the_stages_are_on() {
        let mut f = flow();
        f.build_repo = String::new();
        f.namespace = String::new();
        let errors = validate_flow(&f).unwrap_err();
        assert!(errors.iter().any(|e| e.field == "buildRepo"));
        assert!(errors.iter().any(|e| e.field == "namespace"));
    }
}

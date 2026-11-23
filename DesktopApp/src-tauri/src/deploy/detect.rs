use crate::domain::deploy::{BuildProvider, DeployFlow, Delivery};
use git2::Repository;
use std::path::Path;

const BITBUCKET_PIPELINE: &str = "bitbucket-pipelines.yml";
const GITHUB_WORKFLOWS: &str = ".github/workflows";
const DEFAULT_REMOTE: &str = "origin";
const DEFAULT_BRANCH: &str = "main";
const PRODUCTION_CANDIDATES: [&str; 2] = ["master", "main"];

pub fn parse_remote_url(url: &str) -> Option<(BuildProvider, String)> {
    let url = url.trim();
    let (host, path) = match url.split_once("://") {
        Some((_, rest)) => {
            let (authority, path) = rest.split_once('/')?;
            let host_port = authority.rsplit_once('@').map_or(authority, |(_, host)| host);
            (host_port.split(':').next()?, path)
        }
        None => {
            let (user_host, path) = url.split_once(':')?;
            (user_host.rsplit_once('@').map_or(user_host, |(_, host)| host), path)
        }
    };
    let provider = match host.to_ascii_lowercase().as_str() {
        "bitbucket.org" | "ssh.bitbucket.org" => BuildProvider::Bitbucket,
        "github.com" | "ssh.github.com" => BuildProvider::Github,
        _ => return None,
    };
    let trimmed = path.trim_matches('/');
    let trimmed = trimmed.strip_suffix(".git").unwrap_or(trimmed);
    let segments: Vec<&str> = trimmed.split('/').collect();
    if segments.len() != 2 || segments.iter().any(|segment| segment.is_empty()) {
        return None;
    }
    Some((provider, trimmed.to_string()))
}

fn pick_remote(repo: &Repository) -> String {
    let mut names: Vec<String> = repo
        .remotes()
        .map(|list| list.iter().flatten().map(String::from).collect())
        .unwrap_or_default();
    names.sort();
    if names.len() == 1 || names.is_empty() {
        return names.pop().unwrap_or_else(|| DEFAULT_REMOTE.to_string());
    }
    if names.iter().any(|name| name == DEFAULT_REMOTE) {
        return DEFAULT_REMOTE.to_string();
    }
    names.remove(0)
}

fn remote_url(repo: &Repository, remote: &str) -> Option<String> {
    let raw = repo
        .config()
        .ok()
        .and_then(|config| config.get_string(&format!("remote.{remote}.url")).ok());
    raw.or_else(|| repo.find_remote(remote).ok().and_then(|found| found.url().map(String::from)))
}

fn github_workflow_files(root: &Path) -> Vec<std::path::PathBuf> {
    let mut files: Vec<_> = std::fs::read_dir(root.join(GITHUB_WORKFLOWS))
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && matches!(path.extension().and_then(|ext| ext.to_str()), Some("yml") | Some("yaml"))
        })
        .collect();
    files.sort();
    files
}

fn pipeline_branches(text: &str) -> Vec<String> {
    let lines: Vec<&str> = text.lines().collect();
    let indent_of = |line: &str| line.len() - line.trim_start().len();
    let clean = |value: &str| value.trim().trim_matches(|c| c == '"' || c == '\'').to_string();
    let mut branches = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("branches:") else { continue };
        let rest = rest.trim();
        if !rest.is_empty() {
            let inline = rest.trim_start_matches('[').trim_end_matches(']');
            branches.extend(inline.split(',').map(clean).filter(|name| !name.is_empty()));
            continue;
        }
        let base = indent_of(line);
        for child in &lines[index + 1..] {
            if child.trim().is_empty() {
                continue;
            }
            if indent_of(child) <= base {
                break;
            }
            let child = child.trim();
            let name = match child.strip_prefix("- ") {
                Some(item) => clean(item),
                None => clean(child.split(':').next().unwrap_or("")),
            };
            if !name.is_empty() {
                branches.push(name);
            }
        }
    }
    branches
}

fn production_branch(repo: &Repository, remote: &str, pipeline_text: &str) -> String {
    let tracked: Vec<&str> = PRODUCTION_CANDIDATES
        .into_iter()
        .filter(|name| repo.find_reference(&format!("refs/remotes/{remote}/{name}")).is_ok())
        .collect();
    if tracked.len() == 1 {
        return tracked[0].to_string();
    }
    let named = pipeline_branches(pipeline_text);
    let in_pipeline: Vec<&str> = PRODUCTION_CANDIDATES
        .into_iter()
        .filter(|name| named.iter().any(|branch| branch == name))
        .collect();
    if in_pipeline.len() == 1 {
        return in_pipeline[0].to_string();
    }
    DEFAULT_BRANCH.to_string()
}

pub fn detect_flow(repo_path: &Path) -> DeployFlow {
    let mut flow = DeployFlow {
        repo_path: repo_path.to_string_lossy().to_string(),
        enabled: true,
        remote: DEFAULT_REMOTE.to_string(),
        build: BuildProvider::None,
        build_repo: String::new(),
        production_branch: DEFAULT_BRANCH.to_string(),
        delivery: Delivery::None,
        namespace: String::new(),
        workloads: Vec::new(),
        kube_context: None,
        updated_at: 0,
    };
    let Ok(repo) = Repository::open(repo_path) else { return flow };

    flow.remote = pick_remote(&repo);
    let remote_info = remote_url(&repo, &flow.remote).as_deref().and_then(parse_remote_url);

    let bitbucket_file = repo_path.join(BITBUCKET_PIPELINE);
    let has_bitbucket = bitbucket_file.is_file();
    let github_files = github_workflow_files(repo_path);
    let has_github = !github_files.is_empty();

    flow.build = match (has_bitbucket, has_github) {
        (true, true) => match remote_info.as_ref().map(|(provider, _)| *provider) {
            Some(BuildProvider::Github) => BuildProvider::Github,
            _ => BuildProvider::Bitbucket,
        },
        (true, false) => BuildProvider::Bitbucket,
        (false, true) => BuildProvider::Github,
        (false, false) => BuildProvider::None,
    };

    let pipeline_text = match flow.build {
        BuildProvider::Bitbucket => std::fs::read_to_string(&bitbucket_file).unwrap_or_default(),
        BuildProvider::Github => github_files
            .iter()
            .filter_map(|path| std::fs::read_to_string(path).ok())
            .collect::<Vec<_>>()
            .join("\n"),
        BuildProvider::None => String::new(),
    };

    if flow.build != BuildProvider::None {
        flow.delivery = Delivery::Image;
        if let Some((provider, name)) = remote_info {
            if provider == flow.build {
                flow.build_repo = name;
            }
        }
    }
    flow.production_branch = production_branch(&repo, &flow.remote, &pipeline_text);
    flow
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::test_support::{remote_ref, repo_with_remote, write};

    #[test]
    fn parses_ssh_and_https_remote_urls() {
        assert_eq!(
            parse_remote_url("git@bitbucket.org:cybercode/hr-management.git"),
            Some((BuildProvider::Bitbucket, "cybercode/hr-management".into()))
        );
        assert_eq!(
            parse_remote_url("https://user@bitbucket.org/cybercode/hr-management"),
            Some((BuildProvider::Bitbucket, "cybercode/hr-management".into()))
        );
        assert_eq!(
            parse_remote_url("https://github.com/cyberstudio-software-house/abeon-code.git"),
            Some((BuildProvider::Github, "cyberstudio-software-house/abeon-code".into()))
        );
        assert_eq!(parse_remote_url("ssh://git@example.com/a/b.git"), None);
    }

    #[test]
    fn accepts_the_ssh_alias_hosts_of_both_providers() {
        assert_eq!(
            parse_remote_url("git@ssh.bitbucket.org:cybercode/hr-management.git"),
            Some((BuildProvider::Bitbucket, "cybercode/hr-management".into()))
        );
        assert_eq!(
            parse_remote_url("ssh://git@ssh.github.com:443/acme/site.git"),
            Some((BuildProvider::Github, "acme/site".into()))
        );
    }

    #[test]
    fn rejects_urls_that_are_not_owner_and_name() {
        assert_eq!(parse_remote_url("https://github.com/only-owner"), None);
        assert_eq!(parse_remote_url("https://github.com/a/b/c"), None);
        assert_eq!(parse_remote_url(""), None);
        assert_eq!(
            parse_remote_url("ssh://git@github.com:22/owner/repo.git"),
            Some((BuildProvider::Github, "owner/repo".into()))
        );
    }

    #[test]
    fn detects_a_bitbucket_repository_and_ignores_dev_branches() {
        let repo = repo_with_remote("origin", "git@bitbucket.org:cybercode/hr-management.git");
        write(
            &repo,
            "bitbucket-pipelines.yml",
            "pipelines:\n  branches:\n    development:\n      - step: {}\n    master:\n      - step: {}\n",
        );
        remote_ref(&repo, "origin", "master");
        remote_ref(&repo, "origin", "development");
        let flow = detect_flow(repo.path());
        assert_eq!(flow.build, BuildProvider::Bitbucket);
        assert_eq!(flow.build_repo, "cybercode/hr-management");
        assert_eq!(flow.production_branch, "master");
        assert_eq!(flow.delivery, Delivery::Image);
        assert_eq!(flow.remote, "origin");
        assert!(flow.enabled);
        assert!(flow.namespace.is_empty() && flow.workloads.is_empty());
    }

    #[test]
    fn a_repository_without_ci_gets_no_build_and_no_delivery() {
        let flow = detect_flow(repo_with_remote("origin", "git@example.com:a/b.git").path());
        assert_eq!((flow.build, flow.delivery), (BuildProvider::None, Delivery::None));
        assert!(flow.build_repo.is_empty());
    }

    #[test]
    fn detects_a_github_workflow_and_main_branch() {
        let repo = repo_with_remote("origin", "https://github.com/acme/site.git");
        write(&repo, ".github/workflows/ci.yaml", "on:\n  push:\n    branches: [main]\n");
        remote_ref(&repo, "origin", "main");
        let flow = detect_flow(repo.path());
        assert_eq!(flow.build, BuildProvider::Github);
        assert_eq!(flow.build_repo, "acme/site");
        assert_eq!(flow.production_branch, "main");
        assert_eq!(flow.delivery, Delivery::Image);
    }

    #[test]
    fn a_workflows_directory_without_yaml_files_is_not_ci() {
        let repo = repo_with_remote("origin", "https://github.com/acme/site.git");
        write(&repo, ".github/workflows/readme.md", "x");
        assert_eq!(detect_flow(repo.path()).build, BuildProvider::None);
    }

    #[test]
    fn when_both_pipelines_exist_the_remote_host_decides() {
        let repo = repo_with_remote("origin", "https://github.com/acme/site.git");
        write(&repo, "bitbucket-pipelines.yml", "pipelines: {}\n");
        write(&repo, ".github/workflows/ci.yml", "on: push\n");
        let flow = detect_flow(repo.path());
        assert_eq!(flow.build, BuildProvider::Github);
        assert_eq!(flow.build_repo, "acme/site");

        let other = repo_with_remote("origin", "git@bitbucket.org:acme/site.git");
        write(&other, "bitbucket-pipelines.yml", "pipelines: {}\n");
        write(&other, ".github/workflows/ci.yml", "on: push\n");
        assert_eq!(detect_flow(other.path()).build, BuildProvider::Bitbucket);
    }

    #[test]
    fn a_pipeline_without_a_matching_remote_host_has_no_build_repo() {
        let repo = repo_with_remote("origin", "git@example.com:a/b.git");
        write(&repo, "bitbucket-pipelines.yml", "pipelines: {}\n");
        let flow = detect_flow(repo.path());
        assert_eq!(flow.build, BuildProvider::Bitbucket);
        assert!(flow.build_repo.is_empty());
        assert_eq!(flow.delivery, Delivery::Image);
    }

    #[test]
    fn remote_selection_prefers_the_only_one_then_origin_then_alphabetical() {
        let only = repo_with_remote("upstream", "git@example.com:a/b.git");
        assert_eq!(detect_flow(only.path()).remote, "upstream");

        let with_origin = repo_with_remote("zeta", "git@example.com:a/b.git");
        git2::Repository::open(with_origin.path()).unwrap().remote("origin", "git@example.com:a/c.git").unwrap();
        assert_eq!(detect_flow(with_origin.path()).remote, "origin");

        let neither = repo_with_remote("zeta", "git@example.com:a/b.git");
        git2::Repository::open(neither.path()).unwrap().remote("alpha", "git@example.com:a/c.git").unwrap();
        assert_eq!(detect_flow(neither.path()).remote, "alpha");
    }

    #[test]
    fn production_branch_falls_back_to_the_pipeline_then_to_main() {
        let both = repo_with_remote("origin", "git@bitbucket.org:a/b.git");
        write(&both, "bitbucket-pipelines.yml", "pipelines:\n  branches:\n    master:\n      - step: {}\n");
        remote_ref(&both, "origin", "master");
        remote_ref(&both, "origin", "main");
        assert_eq!(detect_flow(both.path()).production_branch, "master");

        let neither = repo_with_remote("origin", "git@bitbucket.org:a/b.git");
        write(&neither, "bitbucket-pipelines.yml", "pipelines:\n  branches:\n    master:\n      - step: {}\n");
        assert_eq!(detect_flow(neither.path()).production_branch, "master");

        let nothing = repo_with_remote("origin", "git@example.com:a/b.git");
        assert_eq!(detect_flow(nothing.path()).production_branch, "main");
    }

    #[test]
    fn only_the_tracked_remote_decides_the_production_branch() {
        let repo = repo_with_remote("origin", "git@example.com:a/b.git");
        remote_ref(&repo, "backup", "master");
        assert_eq!(detect_flow(repo.path()).production_branch, "main");
        remote_ref(&repo, "origin", "master");
        assert_eq!(detect_flow(repo.path()).production_branch, "master");
    }

    #[test]
    fn a_repository_without_remotes_still_yields_a_flow() {
        let dir = tempfile::tempdir().unwrap();
        git2::Repository::init(dir.path()).unwrap();
        let flow = detect_flow(dir.path());
        assert_eq!(flow.remote, "origin");
        assert_eq!(flow.build, BuildProvider::None);
        assert_eq!(flow.production_branch, "main");
    }
}

use std::path::Path;
use git2::{Repository, StatusOptions, Status};
use crate::domain::{GitFile, GitRepo, GitStatus};
use crate::error::AppResult;

pub fn status(path: &Path) -> AppResult<GitStatus> {
    let repos = discover_repos(path)?;
    let is_repo = !repos.is_empty();
    Ok(GitStatus { repos, is_repo })
}

fn discover_repos(path: &Path) -> AppResult<Vec<GitRepo>> {
    if let Ok(repo) = Repository::open(path) {
        return Ok(vec![repo_status(repo, ".")?]);
    }
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(path) {
        Ok(it) => it,
        Err(_) => return Ok(out),
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
            Some(n) => n,
            None => continue,
        };
        if name.starts_with('.') {
            continue;
        }
        let child_path = entry.path();
        if let Ok(repo) = Repository::open(&child_path) {
            out.push(repo_status(repo, name)?);
        }
    }
    out.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(out)
}

fn repo_status(repo: Repository, label: &str) -> AppResult<GitRepo> {
    let head = repo.head().ok();
    let branch = head.as_ref().and_then(|h| h.shorthand().map(String::from));

    let (ahead, behind) = match (head.as_ref().and_then(|h| h.target()), branch.as_deref()) {
        (Some(local_oid), Some(b)) => {
            let upstream_name = format!("refs/remotes/origin/{b}");
            match repo.refname_to_id(&upstream_name) {
                Ok(remote_oid) => repo.graph_ahead_behind(local_oid, remote_oid).unwrap_or((0, 0)),
                Err(_) => (0, 0),
            }
        }
        _ => (0, 0),
    };

    let mut opts = StatusOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repo.statuses(Some(&mut opts))?;

    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.include_untracked(true);

    let diff_wt = repo.diff_index_to_workdir(None, Some(&mut diff_opts))?;
    let head_tree = head.as_ref().and_then(|h| h.peel_to_tree().ok());
    let diff_idx = repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut diff_opts))?;

    let mut stats_map: std::collections::HashMap<String, (usize, usize)> = std::collections::HashMap::new();
    for diff in [&diff_wt, &diff_idx] {
        diff.foreach(
            &mut |_delta, _| true,
            None,
            None,
            Some(&mut |delta, _hunk, line| {
                if let Some(path) = delta.new_file().path().and_then(|p| p.to_str()) {
                    let entry = stats_map.entry(path.to_string()).or_insert((0, 0));
                    match line.origin() {
                        '+' => entry.0 += 1,
                        '-' => entry.1 += 1,
                        _ => {}
                    }
                }
                true
            }),
        )?;
    }

    let files: Vec<GitFile> = statuses.iter().filter_map(|s| {
        let p = s.path()?.to_string();
        let st = s.status();
        let (status, staged) = status_to_char(st);
        let (additions, deletions) = stats_map.get(&p).copied().unwrap_or((0, 0));
        Some(GitFile { path: p, status, staged, additions, deletions })
    }).collect();

    Ok(GitRepo { label: label.to_string(), branch, ahead, behind, files })
}

fn status_to_char(s: Status) -> (String, bool) {
    if s.contains(Status::INDEX_NEW) { return ("A".into(), true); }
    if s.contains(Status::INDEX_MODIFIED) { return ("M".into(), true); }
    if s.contains(Status::INDEX_DELETED) { return ("D".into(), true); }
    if s.contains(Status::INDEX_RENAMED) { return ("R".into(), true); }
    if s.contains(Status::WT_NEW) { return ("?".into(), false); }
    if s.contains(Status::WT_MODIFIED) { return ("M".into(), false); }
    if s.contains(Status::WT_DELETED) { return ("D".into(), false); }
    ("?".into(), false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn init_repo(path: &Path) {
        git2::Repository::init(path).expect("init repo");
    }

    #[test]
    fn empty_dir_has_no_repos() {
        let tmp = TempDir::new().unwrap();
        let st = status(tmp.path()).unwrap();
        assert!(st.repos.is_empty());
        assert!(!st.is_repo);
    }

    #[test]
    fn root_repo_returns_single_repo_with_dot_label() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        let st = status(tmp.path()).unwrap();
        assert_eq!(st.repos.len(), 1);
        assert_eq!(st.repos[0].label, ".");
        assert!(st.is_repo);
    }

    #[test]
    fn two_subrepos_returned_sorted_by_label() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("zeta")).unwrap();
        fs::create_dir(tmp.path().join("alpha")).unwrap();
        init_repo(&tmp.path().join("zeta"));
        init_repo(&tmp.path().join("alpha"));
        let st = status(tmp.path()).unwrap();
        assert_eq!(st.repos.len(), 2);
        assert_eq!(st.repos[0].label, "alpha");
        assert_eq!(st.repos[1].label, "zeta");
        assert!(st.is_repo);
    }

    #[test]
    fn root_repo_wins_over_subrepos() {
        let tmp = TempDir::new().unwrap();
        init_repo(tmp.path());
        fs::create_dir(tmp.path().join("child")).unwrap();
        init_repo(&tmp.path().join("child"));
        let st = status(tmp.path()).unwrap();
        assert_eq!(st.repos.len(), 1);
        assert_eq!(st.repos[0].label, ".");
    }

    #[test]
    fn hidden_dirs_are_skipped() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join(".cache")).unwrap();
        init_repo(&tmp.path().join(".cache"));
        let st = status(tmp.path()).unwrap();
        assert!(st.repos.is_empty());
    }

    #[test]
    fn non_repo_subdirs_are_skipped() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir(tmp.path().join("frontend")).unwrap();
        init_repo(&tmp.path().join("frontend"));
        fs::create_dir(tmp.path().join("docs")).unwrap(); // not a repo
        let st = status(tmp.path()).unwrap();
        assert_eq!(st.repos.len(), 1);
        assert_eq!(st.repos[0].label, "frontend");
    }
}

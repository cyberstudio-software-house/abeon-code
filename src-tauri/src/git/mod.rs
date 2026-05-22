use std::path::Path;
use git2::{Repository, StatusOptions, Status};
use crate::domain::{GitFile, GitStatus};
use crate::error::AppResult;

pub fn status(path: &Path) -> AppResult<GitStatus> {
    let repo = match Repository::discover(path) {
        Ok(r) => r,
        Err(_) => return Ok(GitStatus { branch: None, ahead: 0, behind: 0, files: vec![], is_repo: false }),
    };

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

    // Compute per-file diff stats (additions/deletions)
    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.include_untracked(true);

    // Index vs workdir diff (unstaged changes)
    let diff_wt = repo.diff_index_to_workdir(None, Some(&mut diff_opts))?;
    // HEAD vs index diff (staged changes)
    let head_tree = head.as_ref()
        .and_then(|h| h.peel_to_tree().ok());
    let diff_idx = repo.diff_tree_to_index(head_tree.as_ref(), None, Some(&mut diff_opts))?;

    // Build a map of path -> (additions, deletions)
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

    Ok(GitStatus { branch, ahead, behind, files, is_repo: true })
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

use std::path::Path;
use git2::{Repository, StatusOptions, Status};
use crate::domain::{DiffHunk, DiffLine, DiffResult, GitFile, GitRepo, GitStatus};
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

const DIFF_SIZE_LIMIT: u64 = 2 * 1024 * 1024;

pub fn diff_file(repo_path: &Path, file_path: &str) -> AppResult<DiffResult> {
    let repo = Repository::open(repo_path)?;

    let workdir_file = repo_path.join(file_path);
    if let Ok(meta) = std::fs::metadata(&workdir_file) {
        if meta.is_file() && meta.len() > DIFF_SIZE_LIMIT {
            return Ok(DiffResult::TooLarge { size: meta.len() as usize });
        }
    }

    let is_untracked = match repo.status_file(Path::new(file_path)) {
        Ok(s) => s.contains(Status::WT_NEW) && !s.contains(Status::INDEX_NEW),
        Err(_) => false,
    };
    if is_untracked {
        let content = std::fs::read_to_string(&workdir_file).unwrap_or_default();
        let lines: Vec<DiffLine> = content.lines().enumerate().map(|(i, line)| DiffLine {
            kind: "add".into(),
            old_lineno: None,
            new_lineno: Some(i + 1),
            content: format!("{line}\n"),
        }).collect();
        let count = lines.len();
        let hunk = DiffHunk {
            header: format!("@@ -0,0 +1,{count} @@"),
            old_start: 0,
            new_start: 1,
            lines,
        };
        return Ok(DiffResult::Text { hunks: vec![hunk] });
    }

    let head_tree = repo.head().ok().and_then(|h| h.peel_to_tree().ok());
    let mut opts = git2::DiffOptions::new();
    opts.pathspec(file_path).include_untracked(true);
    let diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?;

    let is_binary = std::cell::Cell::new(false);
    let hunks: std::cell::RefCell<Vec<DiffHunk>> = std::cell::RefCell::new(Vec::new());
    diff.foreach(
        &mut |_, _| true,
        Some(&mut |_delta, _binary| {
            is_binary.set(true);
            true
        }),
        Some(&mut |_delta, hunk| {
            hunks.borrow_mut().push(DiffHunk {
                header: String::from_utf8_lossy(hunk.header()).trim_end().to_string(),
                old_start: hunk.old_start() as usize,
                new_start: hunk.new_start() as usize,
                lines: Vec::new(),
            });
            true
        }),
        Some(&mut |_delta, _hunk, line| {
            if let Some(last) = hunks.borrow_mut().last_mut() {
                let kind = match line.origin() {
                    '+' => "add",
                    '-' => "del",
                    _ => "context",
                };
                last.lines.push(DiffLine {
                    kind: kind.into(),
                    old_lineno: line.old_lineno().map(|n| n as usize),
                    new_lineno: line.new_lineno().map(|n| n as usize),
                    content: String::from_utf8_lossy(line.content()).to_string(),
                });
            }
            true
        }),
    )?;

    if is_binary.get() {
        return Ok(DiffResult::Binary);
    }

    Ok(DiffResult::Text { hunks: hunks.into_inner() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::DiffResult;
    use std::fs;
    use std::path::Path;
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

    use std::process::Command;

    fn run_git(dir: &Path, args: &[&str]) {
        let out = Command::new("git").current_dir(dir).args(args).output().expect("git");
        if !out.status.success() {
            panic!("git {:?} failed: {}", args, String::from_utf8_lossy(&out.stderr));
        }
    }

    fn init_repo_with_commit(dir: &Path) {
        run_git(dir, &["init", "-q", "-b", "main"]);
        run_git(dir, &["config", "user.email", "t@t"]);
        run_git(dir, &["config", "user.name", "t"]);
        fs::write(dir.join("seed.txt"), "x\n").unwrap();
        run_git(dir, &["add", "."]);
        run_git(dir, &["commit", "-q", "-m", "seed"]);
    }

    #[test]
    fn diff_file_modified_returns_add_and_del_lines() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        fs::write(tmp.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        run_git(tmp.path(), &["add", "."]);
        run_git(tmp.path(), &["commit", "-q", "-m", "add a"]);
        fs::write(tmp.path().join("a.txt"), "one\nTWO\nthree\n").unwrap();

        let res = diff_file(tmp.path(), "a.txt").unwrap();
        let hunks = match res {
            DiffResult::Text { hunks } => hunks,
            other => panic!("expected Text, got {:?}", other),
        };
        assert!(!hunks.is_empty());
        let has_add = hunks.iter().any(|h| h.lines.iter().any(|l| l.kind == "add"));
        let has_del = hunks.iter().any(|h| h.lines.iter().any(|l| l.kind == "del"));
        assert!(has_add, "expected at least one add line");
        assert!(has_del, "expected at least one del line");
    }

    #[test]
    fn diff_file_untracked_returns_synthetic_add_hunk() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        fs::write(tmp.path().join("new.txt"), "line1\nline2\n").unwrap();

        let res = diff_file(tmp.path(), "new.txt").unwrap();
        let hunks = match res {
            DiffResult::Text { hunks } => hunks,
            other => panic!("expected Text, got {:?}", other),
        };
        assert_eq!(hunks.len(), 1);
        let h = &hunks[0];
        assert_eq!(h.old_start, 0);
        assert_eq!(h.new_start, 1);
        assert_eq!(h.lines.len(), 2);
        assert!(h.lines.iter().all(|l| l.kind == "add"));
    }

    #[test]
    fn diff_file_too_large_returns_too_large_variant() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        let big: Vec<u8> = vec![b'x'; 3 * 1024 * 1024];
        fs::write(tmp.path().join("big.bin"), &big).unwrap();
        let res = diff_file(tmp.path(), "big.bin").unwrap();
        match res {
            DiffResult::TooLarge { size } => assert!(size >= 2 * 1024 * 1024),
            other => panic!("expected TooLarge, got {:?}", other),
        }
    }

    #[test]
    fn diff_file_binary_returns_binary_variant() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        // 512 NUL bytes — large enough that libgit2's heuristic marks the delta as binary
        let bin: Vec<u8> = vec![0u8; 512];
        fs::write(tmp.path().join("img.bin"), &bin).unwrap();
        run_git(tmp.path(), &["add", "."]);
        run_git(tmp.path(), &["commit", "-q", "-m", "add bin"]);
        let mut bin2: Vec<u8> = vec![0u8; 512];
        bin2[0] = 1;
        fs::write(tmp.path().join("img.bin"), &bin2).unwrap();

        let res = diff_file(tmp.path(), "img.bin").unwrap();
        match res {
            DiffResult::Binary => {}
            other => panic!("expected Binary, got {:?}", other),
        }
    }
}

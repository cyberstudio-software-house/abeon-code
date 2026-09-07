use std::collections::HashMap;
use std::path::Path;
use git2::{BranchType, Delta, DiffOptions, Oid, Repository, Sort};
use crate::domain::{DiffResult, GitBranch, GitCommit, GitCommitDetail, GitFile};
use crate::error::{AppError, AppResult};
use super::{collect_hunks, DIFF_SIZE_LIMIT};

pub fn list_branches(repo_path: &Path) -> AppResult<Vec<GitBranch>> {
    let repo = Repository::open(repo_path)?;
    let mut out = Vec::new();
    for entry in repo.branches(None)? {
        let (branch, kind) = entry?;
        let name = match branch.name()? {
            Some(n) => n.to_string(),
            None => continue,
        };
        let is_remote = kind == BranchType::Remote;
        if is_remote && name.ends_with("/HEAD") {
            continue;
        }
        out.push(GitBranch { name, is_remote, is_head: branch.is_head() });
    }
    out.sort_by(|a, b| a.is_remote.cmp(&b.is_remote).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

pub fn log(repo_path: &Path, branch: &str, skip: usize, limit: usize) -> AppResult<Vec<GitCommit>> {
    let repo = Repository::open(repo_path)?;
    let tip = resolve_branch_tip(&repo, branch)?;
    let mut walk = repo.revwalk()?;
    walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
    walk.push(tip)?;
    let mut out = Vec::with_capacity(limit);
    for oid in walk.skip(skip).take(limit) {
        let commit = repo.find_commit(oid?)?;
        out.push(commit_summary(&commit));
    }
    Ok(out)
}

pub fn commit_detail(repo_path: &Path, hash: &str) -> AppResult<GitCommitDetail> {
    let repo = Repository::open(repo_path)?;
    let commit = find_commit(&repo, hash)?;
    let diff = commit_diff(&repo, &commit, None)?;

    let mut stats: HashMap<String, (usize, usize)> = HashMap::new();
    diff.foreach(
        &mut |_, _| true,
        None,
        None,
        Some(&mut |delta, _hunk, line| {
            let entry = stats.entry(delta_path(&delta)).or_insert((0, 0));
            match line.origin() {
                '+' => entry.0 += 1,
                '-' => entry.1 += 1,
                _ => {}
            }
            true
        }),
    )?;

    let files = diff.deltas().map(|delta| {
        let path = delta_path(&delta);
        let (additions, deletions) = stats.get(&path).copied().unwrap_or((0, 0));
        GitFile { path, status: delta_status_char(delta.status()), staged: true, additions, deletions }
    }).collect();

    Ok(GitCommitDetail {
        commit: commit_summary(&commit),
        body: commit.message().unwrap_or("").trim_end().to_string(),
        files,
    })
}

pub fn diff_commit_file(repo_path: &Path, hash: &str, file_path: &str) -> AppResult<DiffResult> {
    let repo = Repository::open(repo_path)?;
    let commit = find_commit(&repo, hash)?;
    if let Some(size) = blob_size_in_commit(&repo, &commit, file_path)? {
        if size > DIFF_SIZE_LIMIT {
            return Ok(DiffResult::TooLarge { size: size as usize });
        }
    }
    let diff = commit_diff(&repo, &commit, Some(file_path))?;
    collect_hunks(&diff)
}

fn blob_size_in_commit(repo: &Repository, commit: &git2::Commit, file_path: &str) -> AppResult<Option<u64>> {
    let entry = match commit.tree()?.get_path(Path::new(file_path)) {
        Ok(entry) => entry,
        Err(_) => return Ok(None),
    };
    match repo.find_blob(entry.id()) {
        Ok(blob) => Ok(Some(blob.size() as u64)),
        Err(_) => Ok(None),
    }
}

fn resolve_branch_tip(repo: &Repository, branch: &str) -> AppResult<Oid> {
    let found = repo
        .find_branch(branch, BranchType::Local)
        .or_else(|_| repo.find_branch(branch, BranchType::Remote))?;
    found
        .get()
        .target()
        .ok_or_else(|| AppError::NotFound(format!("branch {branch} has no target")))
}

fn find_commit<'r>(repo: &'r Repository, hash: &str) -> AppResult<git2::Commit<'r>> {
    let oid = Oid::from_str(hash)
        .map_err(|_| AppError::InvalidInput(format!("invalid commit hash: {hash}")))?;
    Ok(repo.find_commit(oid)?)
}

fn commit_diff<'r>(
    repo: &'r Repository,
    commit: &git2::Commit,
    pathspec: Option<&str>,
) -> AppResult<git2::Diff<'r>> {
    let new_tree = commit.tree()?;
    let old_tree = match commit.parent(0) {
        Ok(parent) => Some(parent.tree()?),
        Err(_) => None,
    };
    let mut opts = DiffOptions::new();
    if let Some(p) = pathspec {
        opts.pathspec(p);
    }
    let mut diff = repo.diff_tree_to_tree(old_tree.as_ref(), Some(&new_tree), Some(&mut opts))?;
    diff.find_similar(None)?;
    Ok(diff)
}

fn commit_summary(commit: &git2::Commit) -> GitCommit {
    let hash = commit.id().to_string();
    GitCommit {
        short_hash: hash[..7].to_string(),
        hash,
        subject: commit.summary().unwrap_or("").to_string(),
        author: commit.author().name().unwrap_or("").to_string(),
        timestamp: commit.time().seconds(),
    }
}

fn delta_path(delta: &git2::DiffDelta) -> String {
    delta
        .new_file()
        .path()
        .or_else(|| delta.old_file().path())
        .and_then(|p| p.to_str())
        .unwrap_or("")
        .to_string()
}

fn delta_status_char(status: Delta) -> String {
    match status {
        Delta::Added | Delta::Copied => "A",
        Delta::Deleted => "D",
        Delta::Renamed => "R",
        _ => "M",
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::test_support::{commit_all, init_repo_with_commit, run_git};
    use crate::domain::DiffResult;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn list_branches_marks_head_and_includes_remote() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        run_git(tmp.path(), &["branch", "feature"]);
        run_git(tmp.path(), &["update-ref", "refs/remotes/origin/main", "HEAD"]);

        let branches = list_branches(tmp.path()).unwrap();
        let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["feature", "main", "origin/main"]);

        let main = branches.iter().find(|b| b.name == "main").unwrap();
        assert!(main.is_head);
        assert!(!main.is_remote);

        let feature = branches.iter().find(|b| b.name == "feature").unwrap();
        assert!(!feature.is_head);

        let remote = branches.iter().find(|b| b.name == "origin/main").unwrap();
        assert!(remote.is_remote);
        assert!(!remote.is_head);
    }

    #[test]
    fn list_branches_skips_remote_head_alias() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        run_git(tmp.path(), &["update-ref", "refs/remotes/origin/main", "HEAD"]);
        run_git(tmp.path(), &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

        let branches = list_branches(tmp.path()).unwrap();
        assert!(branches.iter().all(|b| b.name != "origin/HEAD"));
    }

    #[test]
    fn log_returns_newest_first_with_skip_and_limit() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        fs::write(tmp.path().join("seed.txt"), "y\n").unwrap();
        commit_all(tmp.path(), "second");
        fs::write(tmp.path().join("seed.txt"), "z\n").unwrap();
        let third = commit_all(tmp.path(), "third");

        let page = log(tmp.path(), "main", 0, 2).unwrap();
        let subjects: Vec<&str> = page.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, vec!["third", "second"]);
        assert_eq!(page[0].hash, third);
        assert_eq!(page[0].short_hash, third[..7]);
        assert_eq!(page[0].author, "t");
        assert!(page[0].timestamp > 0);

        let rest = log(tmp.path(), "main", 2, 2).unwrap();
        let subjects: Vec<&str> = rest.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, vec!["seed"]);
    }

    #[test]
    fn log_of_other_branch_stops_at_branch_point() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        run_git(tmp.path(), &["branch", "feature"]);
        fs::write(tmp.path().join("seed.txt"), "y\n").unwrap();
        commit_all(tmp.path(), "only on main");

        let feature = log(tmp.path(), "feature", 0, 10).unwrap();
        let subjects: Vec<&str> = feature.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, vec!["seed"]);
    }

    #[test]
    fn log_accepts_remote_branch_name() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        run_git(tmp.path(), &["update-ref", "refs/remotes/origin/main", "HEAD"]);

        let page = log(tmp.path(), "origin/main", 0, 10).unwrap();
        assert_eq!(page.len(), 1);
        assert_eq!(page[0].subject, "seed");
    }

    #[test]
    fn log_subject_is_first_line_only() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        fs::write(tmp.path().join("seed.txt"), "y\n").unwrap();
        commit_all(tmp.path(), "title line\n\nlonger body\nsecond body line");

        let page = log(tmp.path(), "main", 0, 1).unwrap();
        assert_eq!(page[0].subject, "title line");
    }

    #[test]
    fn commit_detail_lists_added_and_modified_files_with_stats() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        fs::write(tmp.path().join("seed.txt"), "changed\n").unwrap();
        fs::write(tmp.path().join("new.txt"), "a\nb\n").unwrap();
        let hash = commit_all(tmp.path(), "add and modify\n\nbody text");

        let detail = commit_detail(tmp.path(), &hash).unwrap();
        assert_eq!(detail.commit.hash, hash);
        assert_eq!(detail.commit.subject, "add and modify");
        assert_eq!(detail.body, "add and modify\n\nbody text");

        let paths: Vec<&str> = detail.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, vec!["new.txt", "seed.txt"]);

        let new = &detail.files[0];
        assert_eq!(new.status, "A");
        assert_eq!(new.additions, 2);
        assert_eq!(new.deletions, 0);

        let seed = &detail.files[1];
        assert_eq!(seed.status, "M");
        assert_eq!(seed.additions, 1);
        assert_eq!(seed.deletions, 1);
    }

    #[test]
    fn commit_detail_marks_deleted_files() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        fs::remove_file(tmp.path().join("seed.txt")).unwrap();
        let hash = commit_all(tmp.path(), "remove seed");

        let detail = commit_detail(tmp.path(), &hash).unwrap();
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.files[0].path, "seed.txt");
        assert_eq!(detail.files[0].status, "D");
        assert_eq!(detail.files[0].deletions, 1);
    }

    #[test]
    fn commit_detail_of_root_commit_lists_all_files_as_added() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        let root = log(tmp.path(), "main", 0, 1).unwrap().remove(0);

        let detail = commit_detail(tmp.path(), &root.hash).unwrap();
        assert_eq!(detail.files.len(), 1);
        assert_eq!(detail.files[0].path, "seed.txt");
        assert_eq!(detail.files[0].status, "A");
        assert_eq!(detail.files[0].additions, 1);
    }

    #[test]
    fn commit_detail_rejects_unknown_hash() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        assert!(commit_detail(tmp.path(), "not-a-hash").is_err());
    }

    #[test]
    fn diff_commit_file_returns_add_and_del_lines() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        fs::write(tmp.path().join("seed.txt"), "one\ntwo\n").unwrap();
        commit_all(tmp.path(), "expand");
        fs::write(tmp.path().join("seed.txt"), "one\nTWO\n").unwrap();
        let hash = commit_all(tmp.path(), "edit");

        let res = diff_commit_file(tmp.path(), &hash, "seed.txt").unwrap();
        let hunks = match res {
            DiffResult::Text { hunks } => hunks,
            other => panic!("expected Text, got {:?}", other),
        };
        assert_eq!(hunks.len(), 1);
        let kinds: Vec<&str> = hunks[0].lines.iter().map(|l| l.kind.as_str()).collect();
        assert_eq!(kinds, vec!["context", "del", "add"]);
        assert_eq!(hunks[0].lines[1].content, "two\n");
        assert_eq!(hunks[0].lines[2].content, "TWO\n");
    }

    #[test]
    fn diff_commit_file_of_root_commit_shows_whole_file_as_added() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        let root = log(tmp.path(), "main", 0, 1).unwrap().remove(0);

        let res = diff_commit_file(tmp.path(), &root.hash, "seed.txt").unwrap();
        let hunks = match res {
            DiffResult::Text { hunks } => hunks,
            other => panic!("expected Text, got {:?}", other),
        };
        assert_eq!(hunks.len(), 1);
        assert!(hunks[0].lines.iter().all(|l| l.kind == "add"));
    }

    #[test]
    fn diff_commit_file_too_large_returns_too_large_variant() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        let big = "x\n".repeat(1_100_000);
        fs::write(tmp.path().join("big.txt"), &big).unwrap();
        let hash = commit_all(tmp.path(), "add big");

        let res = diff_commit_file(tmp.path(), &hash, "big.txt").unwrap();
        match res {
            DiffResult::TooLarge { size } => assert!(size >= 2 * 1024 * 1024),
            other => panic!("expected TooLarge, got {:?}", other),
        }
    }

    #[test]
    fn diff_commit_file_binary_returns_binary_variant() {
        let tmp = TempDir::new().unwrap();
        init_repo_with_commit(tmp.path());
        fs::write(tmp.path().join("img.bin"), vec![0u8; 512]).unwrap();
        let hash = commit_all(tmp.path(), "add bin");

        let res = diff_commit_file(tmp.path(), &hash, "img.bin").unwrap();
        match res {
            DiffResult::Binary => {}
            other => panic!("expected Binary, got {:?}", other),
        }
    }
}

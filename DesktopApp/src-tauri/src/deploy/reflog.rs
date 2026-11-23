use crate::domain::deploy::DeployFlow;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

const TAIL_BYTES: u64 = 8192;
const PUSH_MESSAGE: &str = "update by push";
const SHA_LENGTH: usize = 40;

#[derive(Clone, Debug, PartialEq)]
pub struct PushEntry {
    pub commit: String,
    pub at: i64,
}

fn is_plain_relative(value: &str) -> bool {
    !value.is_empty()
        && Path::new(value)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

pub fn reflog_path(repo: &Path, remote: &str, branch: &str) -> Option<PathBuf> {
    if !is_plain_relative(remote) || !is_plain_relative(branch) {
        return None;
    }
    let repository = git2::Repository::open(repo).ok()?;
    Some(
        repository
            .commondir()
            .join("logs")
            .join("refs")
            .join("remotes")
            .join(remote)
            .join(branch),
    )
}

fn read_tail(path: &Path) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let start = length.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::with_capacity((length - start) as usize);
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn is_sha(value: &str) -> bool {
    value.len() == SHA_LENGTH && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn parse_push(line: &str) -> Option<PushEntry> {
    let (header, message) = line.split_once('\t')?;
    if !message.starts_with(PUSH_MESSAGE) {
        return None;
    }
    let (old, rest) = header.split_once(' ')?;
    let (new, _) = rest.split_once(' ')?;
    if !is_sha(old) || !is_sha(new) || new.bytes().all(|byte| byte == b'0') {
        return None;
    }
    let after_email = &header[header.rfind('>')? + 1..];
    let seconds: i64 = after_email.split_whitespace().next()?.parse().ok()?;
    Some(PushEntry {
        commit: new.to_ascii_lowercase(),
        at: seconds.checked_mul(1000)?,
    })
}

pub fn latest_push(reflog: &Path) -> Option<PushEntry> {
    let tail = read_tail(reflog)?;
    let line = tail
        .lines()
        .rev()
        .map(|line| line.trim_end_matches('\r'))
        .find(|line| !line.trim().is_empty())?;
    parse_push(line)
}

struct Seen {
    reflog: PathBuf,
    last: Option<PushEntry>,
}

#[derive(Default)]
pub struct PushDetector {
    seen: HashMap<String, Seen>,
}

impl PushDetector {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn poll(&mut self, flows: &[DeployFlow]) -> Vec<(DeployFlow, PushEntry)> {
        let mut enabled: Vec<&DeployFlow> = flows.iter().filter(|flow| flow.enabled).collect();
        enabled.sort_by(|left, right| left.repo_path.cmp(&right.repo_path));
        self.seen
            .retain(|path, _| enabled.iter().any(|flow| &flow.repo_path == path));

        let mut found = Vec::new();
        let mut reported: HashSet<PathBuf> = HashSet::new();
        for flow in enabled {
            let Some(reflog) =
                reflog_path(Path::new(&flow.repo_path), &flow.remote, &flow.production_branch)
            else {
                continue;
            };
            let current = latest_push(&reflog);
            match self.seen.get_mut(&flow.repo_path) {
                Some(seen) if seen.reflog == reflog => {
                    let Some(entry) = current else { continue };
                    if seen.last.as_ref() == Some(&entry) {
                        continue;
                    }
                    seen.last = Some(entry.clone());
                    if reported.insert(file_identity(&reflog)) {
                        found.push((flow.clone(), entry));
                    }
                }
                _ => {
                    self.seen
                        .insert(flow.repo_path.clone(), Seen { reflog, last: current });
                }
            }
        }
        found
    }
}

fn file_identity(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::test_support::{append, flow_at, init_repo, push, reflog, repo_with_push};

    const ZEROS: &str = "0000000000000000000000000000000000000000";

    fn line(old: &str, new: &str, identity: &str, at: i64, message: &str) -> String {
        format!("{old} {new} {identity} {at} +0100\t{message}")
    }

    #[test]
    fn reads_the_newest_push_and_ignores_a_fetch() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let file = reflog(&[
            &line(ZEROS, &a, "P S <p@x>", 1795006808, "update by push"),
            &line(&a, &b, "P S <p@x>", 1795009011, "update by push"),
        ]);
        assert_eq!(
            latest_push(&file),
            Some(PushEntry { commit: b.clone(), at: 1795009011000 })
        );
        append(
            &file,
            &line(&b, &"c".repeat(40), "P S <p@x>", 1795009999, "fetch origin: fast-forward"),
        );
        assert_eq!(latest_push(&file), None);
    }

    #[test]
    fn parses_a_real_reflog_line() {
        let b = "b".repeat(40);
        let file = reflog(&[&format!(
            "{} {} Piotr Szweda <p@example.com> 1795009011 +0100\tupdate by push",
            "a".repeat(40),
            b
        )]);
        assert_eq!(latest_push(&file), Some(PushEntry { commit: b, at: 1795009011000 }));
    }

    #[test]
    fn a_name_with_spaces_and_a_deleted_branch_do_not_confuse_the_parser() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let file = reflog(&[&line(&a, &b, "Jan Maria Kowalski <jan.maria@example.com>", 1795009011, "update by push")]);
        assert_eq!(
            latest_push(&file),
            Some(PushEntry { commit: b.clone(), at: 1795009011000 })
        );
        append(&file, &line(&b, ZEROS, "Jan Maria Kowalski <jan.maria@example.com>", 1795009100, "update by push"));
        assert_eq!(latest_push(&file), None);
    }

    #[test]
    fn a_name_containing_an_angle_bracket_still_yields_the_timestamp() {
        let b = "b".repeat(40);
        let file = reflog(&[&line(ZEROS, &b, "Jan > Kowalski <jan@example.com>", 1795009011, "update by push")]);
        assert_eq!(latest_push(&file), Some(PushEntry { commit: b, at: 1795009011000 }));
    }

    #[test]
    fn a_missing_empty_or_malformed_reflog_yields_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(latest_push(&dir.path().join("missing")), None);
        assert_eq!(latest_push(&reflog(&[])), None);
        assert_eq!(latest_push(&reflog(&["garbage"])), None);
        assert_eq!(latest_push(&reflog(&["a b c\tupdate by push"])), None);
        let b = "b".repeat(40);
        assert_eq!(
            latest_push(&reflog(&[&format!("{ZEROS} {b} P <p@x> notanumber +0100\tupdate by push")])),
            None
        );
    }

    #[test]
    fn a_large_reflog_is_read_from_its_tail() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let filler = line(ZEROS, &a, "P S <p@x>", 1795000000, "update by push");
        let mut lines: Vec<String> = (0..2000).map(|_| filler.clone()).collect();
        lines.push(line(&a, &b, "P S <p@x>", 1795009011, "update by push"));
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        let file = reflog(&refs);
        assert!(std::fs::metadata(&*file).unwrap().len() > TAIL_BYTES * 4);
        assert_eq!(latest_push(&file), Some(PushEntry { commit: b, at: 1795009011000 }));
    }

    #[test]
    fn the_reflog_path_is_resolved_through_the_common_git_dir() {
        let (repo, _) = repo_with_push("a");
        let path = reflog_path(repo.path(), "origin", "master").unwrap();
        assert!(path.ends_with("logs/refs/remotes/origin/master"));
        assert!(path.exists());
        assert_eq!(reflog_path(&repo.path().join("missing"), "origin", "master"), None);
        assert_eq!(reflog_path(repo.path(), "origin", "../../x"), None);
        assert_eq!(reflog_path(repo.path(), "origin", ""), None);
    }

    fn linked_worktree(repo: &Path) -> (tempfile::TempDir, PathBuf) {
        let main = git2::Repository::open(repo).unwrap();
        let signature = git2::Signature::now("test", "test@example.com").unwrap();
        let tree_id = main.treebuilder(None).unwrap().write().unwrap();
        let tree = main.find_tree(tree_id).unwrap();
        main.commit(Some("HEAD"), &signature, &signature, "seed", &tree, &[]).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let worktree_path = outside.path().join("wt");
        main.worktree("wt", &worktree_path, None).unwrap();
        (outside, worktree_path)
    }

    fn origin_master(repo: &Path) -> PathBuf {
        repo.join(".git/logs/refs/remotes/origin/master")
    }

    #[test]
    fn a_linked_worktree_resolves_to_the_main_reflog() {
        let (repo, _) = repo_with_push("a");
        let (_outside, worktree_path) = linked_worktree(repo.path());
        let from_worktree = reflog_path(&worktree_path, "origin", "master").unwrap();
        let from_main = reflog_path(repo.path(), "origin", "master").unwrap();
        assert_eq!(
            std::fs::canonicalize(from_worktree).unwrap(),
            std::fs::canonicalize(from_main).unwrap()
        );
    }

    #[test]
    fn pushes_from_before_the_first_poll_start_nothing() {
        let (repo, flow) = repo_with_push("a");
        let mut detector = PushDetector::new();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        assert!(detector.poll(&[flow.clone()]).is_empty());
        push(&repo, "b");
        let found = detector.poll(&[flow.clone()]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1.commit, "b".repeat(40));
        assert_eq!(found[0].0, flow);
        assert!(detector.poll(&[flow]).is_empty());
    }

    #[test]
    fn a_repository_that_was_never_pushed_reports_its_first_push() {
        let dir = tempfile::tempdir().unwrap();
        init_repo(dir.path());
        let flow = flow_at(dir.path().to_str().unwrap());
        let mut detector = PushDetector::new();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        push(dir.path(), "a");
        let found = detector.poll(&[flow.clone()]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1.commit, "a".repeat(40));
        assert!(detector.poll(&[flow]).is_empty());
    }

    #[test]
    fn a_repository_path_with_spaces_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("my repo");
        init_repo(&repo);
        push(&repo, "a");
        let flow = flow_at(repo.to_str().unwrap());
        let mut detector = PushDetector::new();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        push(&repo, "b");
        let found = detector.poll(&[flow]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1.commit, "b".repeat(40));
    }

    #[test]
    fn a_disabled_flow_is_ignored_and_reported_after_it_is_enabled_only_when_new() {
        let (repo, mut flow) = repo_with_push("a");
        flow.enabled = false;
        let mut detector = PushDetector::new();
        push(&repo, "b");
        assert!(detector.poll(&[flow.clone()]).is_empty());
        flow.enabled = true;
        assert!(detector.poll(&[flow.clone()]).is_empty());
        push(&repo, "c");
        assert_eq!(detector.poll(&[flow]).len(), 1);
    }

    #[test]
    fn a_flow_that_disappears_is_forgotten() {
        let (repo, flow) = repo_with_push("a");
        let mut detector = PushDetector::new();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        push(&repo, "b");
        assert!(detector.poll(&[]).is_empty());
        assert!(detector.poll(&[flow]).is_empty());
    }

    #[test]
    fn changing_the_production_branch_does_not_report_the_other_branch() {
        let (repo, mut flow) = repo_with_push("a");
        let mut detector = PushDetector::new();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        flow.production_branch = "main".to_string();
        crate::deploy::test_support::push_to(&repo, "origin", "main", "d");
        assert!(detector.poll(&[flow.clone()]).is_empty());
        push(&repo, "e");
        assert!(detector.poll(&[flow]).is_empty());
    }

    #[test]
    fn a_push_to_the_new_branch_is_reported_after_the_production_branch_changes() {
        let (repo, mut flow) = repo_with_push("a");
        let mut detector = PushDetector::new();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        flow.production_branch = "main".to_string();
        crate::deploy::test_support::push_to(&repo, "origin", "main", "d");
        assert!(detector.poll(&[flow.clone()]).is_empty());
        crate::deploy::test_support::push_to(&repo, "origin", "main", "e");
        let found = detector.poll(&[flow.clone()]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0.production_branch, "main");
        assert_eq!(found[0].1.commit, "e".repeat(40));
        assert!(detector.poll(&[flow]).is_empty());
    }

    #[test]
    fn a_push_after_a_fetch_line_is_reported() {
        let (repo, flow) = repo_with_push("a");
        let mut detector = PushDetector::new();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        push(&repo, "b");
        assert_eq!(detector.poll(&[flow.clone()])[0].1.commit, "b".repeat(40));
        append(
            &origin_master(repo.path()),
            &line(&"b".repeat(40), &"c".repeat(40), "P S <p@x>", 1795009999, "fetch origin: fast-forward"),
        );
        assert!(detector.poll(&[flow.clone()]).is_empty());
        push(&repo, "d");
        let found = detector.poll(&[flow.clone()]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1.commit, "d".repeat(40));
        assert!(detector.poll(&[flow]).is_empty());
    }

    #[test]
    fn a_reflog_that_cannot_be_read_for_a_while_does_not_repeat_the_last_push() {
        let (repo, flow) = repo_with_push("a");
        let mut detector = PushDetector::new();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        push(&repo, "b");
        assert_eq!(detector.poll(&[flow.clone()]).len(), 1);
        let file = origin_master(repo.path());
        let aside = repo.path().join("reflog-aside");
        std::fs::rename(&file, &aside).unwrap();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        std::fs::rename(&aside, &file).unwrap();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        push(&repo, "c");
        assert_eq!(detector.poll(&[flow])[0].1.commit, "c".repeat(40));
    }

    #[test]
    fn a_repository_that_cannot_be_opened_for_a_while_is_not_forgotten() {
        let (repo, flow) = repo_with_push("a");
        let mut detector = PushDetector::new();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        let git_dir = repo.path().join(".git");
        let aside = repo.path().join("git-aside");
        std::fs::rename(&git_dir, &aside).unwrap();
        assert!(detector.poll(&[flow.clone()]).is_empty());
        std::fs::rename(&aside, &git_dir).unwrap();
        push(&repo, "b");
        let found = detector.poll(&[flow.clone()]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1.commit, "b".repeat(40));
    }

    #[test]
    fn a_reflog_shared_by_a_worktree_is_reported_once_by_the_first_flow() {
        let (repo, main_flow) = repo_with_push("a");
        let (_outside, worktree_path) = linked_worktree(repo.path());
        let worktree_flow = flow_at(worktree_path.to_str().unwrap());
        let first = [&main_flow, &worktree_flow]
            .into_iter()
            .min_by(|left, right| left.repo_path.cmp(&right.repo_path))
            .unwrap()
            .clone();
        for flows in [
            vec![main_flow.clone(), worktree_flow.clone()],
            vec![worktree_flow.clone(), main_flow.clone()],
        ] {
            let mut detector = PushDetector::new();
            assert!(detector.poll(&flows).is_empty());
            push(&repo, "b");
            let found = detector.poll(&flows);
            assert_eq!(found.len(), 1);
            assert_eq!(found[0].0, first);
            assert!(detector.poll(&flows).is_empty());
        }
    }

    #[test]
    fn two_repositories_are_tracked_independently() {
        let (repo_one, flow_one) = repo_with_push("a");
        let (repo_two, flow_two) = repo_with_push("a");
        let flows = [flow_one.clone(), flow_two.clone()];
        let mut detector = PushDetector::new();
        assert!(detector.poll(&flows).is_empty());
        push(&repo_two, "b");
        let found = detector.poll(&flows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0.repo_path, flow_two.repo_path);
        push(&repo_one, "c");
        let found = detector.poll(&flows);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0.repo_path, flow_one.repo_path);
    }
}

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;

use crate::domain::FileSearchResponse;
use crate::error::AppResult;
use crate::files::listing::IgnoreChecker;
use crate::files::paths::{resolve_existing, GIT_DIR};
use crate::files::FALLBACK_SKIP_DIRS;

#[derive(Default)]
pub struct SearchGenerations {
    counters: Mutex<HashMap<String, Arc<AtomicU64>>>,
}

impl SearchGenerations {
    pub fn begin(&self, window_label: &str, sequence: u64) -> Option<SearchTicket> {
        let newest = self
            .counters
            .lock()
            .entry(window_label.to_string())
            .or_default()
            .clone();
        if newest.fetch_max(sequence, Ordering::SeqCst) > sequence {
            return None;
        }
        Some(SearchTicket { newest, sequence })
    }
}

pub struct SearchTicket {
    newest: Arc<AtomicU64>,
    sequence: u64,
}

impl SearchTicket {
    pub fn is_superseded(&self) -> bool {
        self.newest.load(Ordering::SeqCst) > self.sequence
    }
}

struct PendingDir {
    path: PathBuf,
    relative: String,
    checker: Rc<IgnoreChecker>,
}

struct Match {
    rank: u8,
    relative: String,
}

fn rank_of(name: &str, relative: &str, needle: &str, match_path: bool) -> Option<u8> {
    if match_path {
        return relative.to_lowercase().contains(needle).then_some(2);
    }
    let name = name.to_lowercase();
    if name == needle {
        Some(0)
    } else if name.starts_with(needle) {
        Some(1)
    } else if name.contains(needle) {
        Some(2)
    } else {
        None
    }
}

fn points_to_directory(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

pub fn search_files(
    root: &Path,
    query: &str,
    limit: usize,
    visit_cap: usize,
    cancelled: &dyn Fn() -> bool,
) -> AppResult<FileSearchResponse> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(FileSearchResponse {
            results: Vec::new(),
            truncated: false,
        });
    }
    let match_path = needle.contains('/');
    let canonical_root = resolve_existing(root, "")?;
    let mut queue = VecDeque::from([PendingDir {
        checker: Rc::new(IgnoreChecker::for_dir(&canonical_root, &canonical_root)),
        path: canonical_root.clone(),
        relative: String::new(),
    }]);
    let mut matches: Vec<Match> = Vec::new();
    let mut visited = 0usize;
    let mut stopped = false;

    'walk: while let Some(dir) = queue.pop_front() {
        if cancelled() {
            stopped = true;
            break;
        }
        let checker = if !dir.relative.is_empty()
            && std::fs::symlink_metadata(dir.path.join(GIT_DIR)).is_ok()
        {
            Rc::new(IgnoreChecker::for_dir(&canonical_root, &dir.path))
        } else {
            Rc::clone(&dir.checker)
        };
        let entries = match std::fs::read_dir(&dir.path) {
            Ok(entries) => entries,
            Err(error) if dir.relative.is_empty() => return Err(error.into()),
            Err(_) => continue,
        };
        for item in entries {
            if visited >= visit_cap {
                stopped = true;
                break 'walk;
            }
            visited += 1;
            let Ok(item) = item else {
                continue;
            };
            let Ok(name) = item.file_name().into_string() else {
                continue;
            };
            if name.eq_ignore_ascii_case(GIT_DIR) {
                continue;
            }
            let Ok(file_type) = item.file_type() else {
                continue;
            };
            let path = item.path();
            let relative = if dir.relative.is_empty() {
                name.clone()
            } else {
                format!("{}/{}", dir.relative, name)
            };
            if file_type.is_dir() {
                let skipped = checker.is_ignored(&path, true)
                    || (!checker.has_repository() && FALLBACK_SKIP_DIRS.contains(&name.as_str()));
                if !skipped {
                    queue.push_back(PendingDir {
                        path,
                        relative,
                        checker: Rc::clone(&checker),
                    });
                }
                continue;
            }
            if file_type.is_symlink() && points_to_directory(&path) {
                continue;
            }
            if let Some(rank) = rank_of(&name, &relative, &needle, match_path) {
                matches.push(Match { rank, relative });
            }
        }
    }

    matches.sort_by_cached_key(|found| {
        (
            found.rank,
            found.relative.len(),
            found.relative.to_lowercase(),
            found.relative.clone(),
        )
    });
    let truncated = stopped || matches.len() > limit;
    matches.truncate(limit);
    Ok(FileSearchResponse {
        results: matches.into_iter().map(|found| found.relative).collect(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use std::fs;

    const LIMIT: usize = 200;
    const CAP: usize = 200_000;

    fn touch(root: &Path, rel: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }

    fn never() -> bool {
        false
    }

    fn search(root: &Path, query: &str) -> Vec<String> {
        search_files(root, query, LIMIT, CAP, &never)
            .unwrap()
            .results
    }

    fn init_repo(root: &Path, gitignore: &str) {
        git2::Repository::init(root).unwrap();
        fs::write(root.join(".gitignore"), gitignore).unwrap();
    }

    #[test]
    fn finds_ignored_env_file() {
        let root = tempfile::tempdir().unwrap();
        init_repo(root.path(), ".env\n");
        touch(root.path(), ".env");
        touch(root.path(), ".env.example");
        assert_eq!(search(root.path(), "env"), [".env", ".env.example"]);
    }

    #[test]
    fn skips_ignored_directories() {
        let root = tempfile::tempdir().unwrap();
        init_repo(root.path(), "node_modules/\n");
        touch(root.path(), "node_modules/pkg/env.js");
        touch(root.path(), "src/env.js");
        assert_eq!(search(root.path(), "env"), ["src/env.js"]);
    }

    #[test]
    fn never_enters_git_dir() {
        let root = tempfile::tempdir().unwrap();
        init_repo(root.path(), "");
        assert!(search(root.path(), "head").is_empty());
    }

    #[test]
    fn ranks_exact_then_prefix_then_substring() {
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "src/myenv.ts");
        touch(root.path(), "env.d.ts");
        touch(root.path(), "env");
        assert_eq!(
            search(root.path(), "env"),
            ["env", "env.d.ts", "src/myenv.ts"]
        );
    }

    #[test]
    fn shorter_path_wins_ties() {
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "a/b/c/x.ts");
        touch(root.path(), "a/x.ts");
        assert_eq!(search(root.path(), "x.ts"), ["a/x.ts", "a/b/c/x.ts"]);
    }

    #[test]
    fn slash_query_matches_path() {
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "src/config/app.ts");
        touch(root.path(), "src/app.ts");
        assert_eq!(search(root.path(), "config/app"), ["src/config/app.ts"]);
    }

    #[test]
    fn case_insensitive() {
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "readme.md");
        assert_eq!(search(root.path(), "README"), ["readme.md"]);
    }

    #[test]
    fn fallback_skip_list_without_repo() {
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "vendor/x.php");
        touch(root.path(), "src/x.php");
        assert_eq!(search(root.path(), "x.php"), ["src/x.php"]);
    }

    #[test]
    fn fallback_skip_list_not_used_inside_repo() {
        let root = tempfile::tempdir().unwrap();
        init_repo(root.path(), "");
        touch(root.path(), "vendor/x.php");
        assert_eq!(search(root.path(), "x.php"), ["vendor/x.php"]);
    }

    #[test]
    fn nested_repo_replaces_the_outer_rules() {
        let root = tempfile::tempdir().unwrap();
        init_repo(root.path(), "secret/\n");
        touch(root.path(), "secret/env.txt");
        let service = root.path().join("svc");
        fs::create_dir(&service).unwrap();
        init_repo(&service, "");
        touch(&service, "secret/env.txt");
        assert_eq!(search(root.path(), "env"), ["svc/secret/env.txt"]);
    }

    #[test]
    fn skips_git_dir_in_any_case() {
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), ".GIT/env.txt");
        touch(root.path(), ".Git/env.txt");
        touch(root.path(), "env.txt");
        assert_eq!(search(root.path(), "env"), ["env.txt"]);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn skips_names_that_are_not_utf8() {
        use std::os::unix::ffi::OsStrExt;
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "env.txt");
        fs::write(
            root.path()
                .join(std::ffi::OsStr::from_bytes(b"env\xff.txt")),
            "x",
        )
        .unwrap();
        assert_eq!(search(root.path(), "env"), ["env.txt"]);
    }

    #[cfg(unix)]
    fn is_root() -> bool {
        unsafe { libc::geteuid() == 0 }
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn skips_unreadable_subdirectories() {
        if is_root() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "env.txt");
        touch(root.path(), "locked/env.txt");
        let locked = root.path().join("locked");
        set_mode(&locked, 0o000);
        let result = search_files(root.path(), "env", LIMIT, CAP, &never);
        set_mode(&locked, 0o755);
        assert_eq!(result.unwrap().results, ["env.txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_root_is_an_error() {
        if is_root() {
            return;
        }
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("project");
        touch(&root, "env.txt");
        set_mode(&root, 0o000);
        let result = search_files(&root, "env", LIMIT, CAP, &never);
        set_mode(&root, 0o755);
        assert!(result.is_err(), "{result:?}");
    }

    #[test]
    fn missing_root_is_an_error() {
        let base = tempfile::tempdir().unwrap();
        let result = search_files(&base.path().join("gone"), "env", LIMIT, CAP, &never);
        assert!(matches!(result, Err(AppError::NotFound(_))), "{result:?}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_file_is_a_result() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "config/real.env");
        symlink("config/real.env", root.path().join("link.env")).unwrap();
        assert_eq!(search(root.path(), ".env"), ["link.env", "config/real.env"]);
    }

    #[test]
    fn ties_sort_case_insensitively_then_exactly() {
        let root = tempfile::tempdir().unwrap();
        for name in ["b-x.txt", "B-x.txt", "a-x.txt", "C-x.txt"] {
            touch(root.path(), name);
        }
        assert_eq!(
            search(root.path(), "x.txt"),
            ["a-x.txt", "B-x.txt", "b-x.txt", "C-x.txt"]
        );
    }

    #[test]
    fn exact_visit_cap_boundary() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..3 {
            touch(root.path(), &format!("f{index}.txt"));
        }
        let at_cap = search_files(root.path(), "f", LIMIT, 3, &never).unwrap();
        assert_eq!(at_cap.results.len(), 3);
        assert!(!at_cap.truncated);
        let below_cap = search_files(root.path(), "f", LIMIT, 2, &never).unwrap();
        assert_eq!(below_cap.results.len(), 2);
        assert!(below_cap.truncated);
    }

    #[test]
    fn git_dir_counts_toward_the_visit_cap() {
        let root = tempfile::tempdir().unwrap();
        init_repo(root.path(), "");
        touch(root.path(), "f.txt");
        let response = search_files(root.path(), "f", LIMIT, 2, &never).unwrap();
        assert!(response.truncated);
    }

    #[test]
    fn a_capped_walk_keeps_shallow_paths() {
        let root = tempfile::tempdir().unwrap();
        for side in ["a", "b"] {
            touch(root.path(), &format!("{side}/keep.txt"));
            for index in 0..5 {
                touch(root.path(), &format!("{side}/sub/x{index}.txt"));
            }
        }
        let response = search_files(root.path(), "keep", LIMIT, 6, &never).unwrap();
        assert_eq!(response.results, ["a/keep.txt", "b/keep.txt"]);
        assert!(response.truncated);
    }

    #[test]
    fn a_cancelled_walk_stops_and_is_truncated() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..5 {
            touch(root.path(), &format!("d{index}/hit.txt"));
        }
        let complete = search_files(root.path(), "hit", LIMIT, CAP, &never).unwrap();
        assert_eq!(complete.results.len(), 5);
        assert!(!complete.truncated);

        let reads = std::cell::Cell::new(0);
        let cancelled = || {
            reads.set(reads.get() + 1);
            reads.get() > 2
        };
        let response = search_files(root.path(), "hit", LIMIT, CAP, &cancelled).unwrap();
        assert_eq!(response.results.len(), 1);
        assert!(response.truncated);
        assert_eq!(reads.get(), 3);
    }

    #[test]
    fn only_a_search_with_a_higher_sequence_supersedes_a_walk() {
        let generations = SearchGenerations::default();
        let first = generations.begin("main", 5).unwrap();
        assert!(!first.is_superseded());
        let other_window = generations.begin("project-1", 1).unwrap();
        assert!(!first.is_superseded());
        assert!(generations.begin("main", 4).is_none());
        assert!(!first.is_superseded());
        let second = generations.begin("main", 6).unwrap();
        assert!(first.is_superseded());
        assert!(!second.is_superseded());
        assert!(!other_window.is_superseded());
        assert!(generations.begin("main", 5).is_none());
        assert!(!second.is_superseded());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_directory_symlinks() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "a.txt");
        touch(root.path(), "sub/b.txt");
        symlink(".", root.path().join("loop")).unwrap();
        assert_eq!(search(root.path(), "txt"), ["a.txt", "sub/b.txt"]);
    }

    #[test]
    fn truncates_at_limit() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..5 {
            touch(root.path(), &format!("f{index}.txt"));
        }
        let response = search_files(root.path(), "f", 3, CAP, &never).unwrap();
        assert_eq!(response.results.len(), 3);
        assert!(response.truncated);
    }

    #[test]
    fn not_truncated_at_exact_limit() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..3 {
            touch(root.path(), &format!("f{index}.txt"));
        }
        let response = search_files(root.path(), "f", 3, CAP, &never).unwrap();
        assert_eq!(response.results.len(), 3);
        assert!(!response.truncated);
    }

    #[test]
    fn truncates_at_visit_cap() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..6 {
            touch(root.path(), &format!("dir/f{index}.txt"));
        }
        touch(root.path(), "top.txt");
        let response = search_files(root.path(), "f", LIMIT, 2, &never).unwrap();
        assert!(response.truncated);
    }

    #[test]
    fn blank_query_returns_nothing() {
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "a.txt");
        let response = search_files(root.path(), "   ", LIMIT, CAP, &never).unwrap();
        assert!(response.results.is_empty());
        assert!(!response.truncated);
    }
}

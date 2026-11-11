use std::path::{Path, PathBuf};
use std::rc::Rc;

use crate::domain::FileSearchResponse;
use crate::error::AppResult;
use crate::files::listing::IgnoreChecker;
use crate::files::paths::{resolve_existing, GIT_DIR};
use crate::files::FALLBACK_SKIP_DIRS;

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

fn is_directory_symlink(path: &Path) -> bool {
    std::fs::metadata(path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

pub fn search_files(
    root: &Path,
    query: &str,
    limit: usize,
    visit_cap: usize,
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
    let mut stack = vec![PendingDir {
        checker: Rc::new(IgnoreChecker::for_dir(&canonical_root, &canonical_root)),
        path: canonical_root.clone(),
        relative: String::new(),
    }];
    let mut matches: Vec<Match> = Vec::new();
    let mut visited = 0usize;
    let mut capped = false;

    'walk: while let Some(dir) = stack.pop() {
        let checker = if !dir.relative.is_empty()
            && std::fs::symlink_metadata(dir.path.join(GIT_DIR)).is_ok()
        {
            Rc::new(IgnoreChecker::for_dir(&canonical_root, &dir.path))
        } else {
            Rc::clone(&dir.checker)
        };
        let Ok(entries) = std::fs::read_dir(&dir.path) else {
            continue;
        };
        for item in entries {
            let Ok(item) = item else {
                continue;
            };
            let Ok(name) = item.file_name().into_string() else {
                continue;
            };
            if name.eq_ignore_ascii_case(GIT_DIR) {
                continue;
            }
            if visited >= visit_cap {
                capped = true;
                break 'walk;
            }
            visited += 1;
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
                    stack.push(PendingDir {
                        path,
                        relative,
                        checker: Rc::clone(&checker),
                    });
                }
                continue;
            }
            if file_type.is_symlink() && is_directory_symlink(&path) {
                continue;
            }
            if let Some(rank) = rank_of(&name, &relative, &needle, match_path) {
                matches.push(Match { rank, relative });
            }
        }
    }

    matches.sort_by(|left, right| {
        left.rank
            .cmp(&right.rank)
            .then_with(|| left.relative.len().cmp(&right.relative.len()))
            .then_with(|| left.relative.cmp(&right.relative))
    });
    let truncated = capped || matches.len() > limit;
    matches.truncate(limit);
    Ok(FileSearchResponse {
        results: matches.into_iter().map(|found| found.relative).collect(),
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    const LIMIT: usize = 200;
    const CAP: usize = 200_000;

    fn touch(root: &Path, rel: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "x").unwrap();
    }

    fn search(root: &Path, query: &str) -> Vec<String> {
        search_files(root, query, LIMIT, CAP).unwrap().results
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
    fn nested_repo_uses_its_own_rules() {
        let root = tempfile::tempdir().unwrap();
        init_repo(root.path(), "");
        let service = root.path().join("svc");
        fs::create_dir(&service).unwrap();
        init_repo(&service, "secret/\n");
        touch(&service, "secret/env.txt");
        touch(&service, "public/env.txt");
        assert_eq!(search(root.path(), "env"), ["svc/public/env.txt"]);
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
        let response = search_files(root.path(), "f", 3, CAP).unwrap();
        assert_eq!(response.results.len(), 3);
        assert!(response.truncated);
    }

    #[test]
    fn not_truncated_at_exact_limit() {
        let root = tempfile::tempdir().unwrap();
        for index in 0..3 {
            touch(root.path(), &format!("f{index}.txt"));
        }
        let response = search_files(root.path(), "f", 3, CAP).unwrap();
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
        let response = search_files(root.path(), "f", LIMIT, 2).unwrap();
        assert!(response.truncated);
    }

    #[test]
    fn blank_query_returns_nothing() {
        let root = tempfile::tempdir().unwrap();
        touch(root.path(), "a.txt");
        let response = search_files(root.path(), "   ", LIMIT, CAP).unwrap();
        assert!(response.results.is_empty());
        assert!(!response.truncated);
    }
}

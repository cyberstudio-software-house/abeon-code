use std::cell::Cell;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use parking_lot::Mutex;

use git2::{ErrorCode, Repository, RepositoryOpenFlags};

use crate::domain::{FileEntry, FileEntryKind};
use crate::error::{AppError, AppResult};
use crate::files::paths::{resolve_existing, GIT_DIR};

pub struct IgnoreChecker {
    repository: Option<Repository>,
    workdir: PathBuf,
    ignore_error_reported: Cell<bool>,
}

impl IgnoreChecker {
    pub fn for_dir(root: &Path, dir: &Path) -> IgnoreChecker {
        let repository = open_repository(root, dir).unwrap_or_else(|failure| {
            if first_report_of(&failure.repository) {
                eprintln!(
                    "files: cannot open the repository {}: {:?}/{:?}",
                    failure.repository.display(),
                    failure.error.class(),
                    failure.error.code()
                );
            }
            None
        });
        let workdir = repository
            .as_ref()
            .and_then(Repository::workdir)
            .map(|workdir| std::fs::canonicalize(workdir).unwrap_or_else(|_| workdir.to_path_buf()))
            .unwrap_or_default();
        IgnoreChecker {
            repository,
            workdir,
            ignore_error_reported: Cell::new(false),
        }
    }

    pub fn has_repository(&self) -> bool {
        self.repository.is_some()
    }

    pub fn is_ignored(&self, path: &Path, is_dir: bool) -> bool {
        let Some(repository) = &self.repository else {
            return false;
        };
        let Ok(relative) = path.strip_prefix(&self.workdir) else {
            return false;
        };
        if relative.as_os_str().is_empty() {
            return false;
        }
        let mut candidate = relative.as_os_str().to_os_string();
        if is_dir {
            candidate.push("/");
        }
        match repository.is_path_ignored(Path::new(&candidate)) {
            Ok(ignored) => ignored,
            Err(_) => {
                if !self.ignore_error_reported.replace(true) {
                    eprintln!("files: cannot check ignore rules for {}", path.display());
                }
                false
            }
        }
    }
}

struct OpenFailure {
    repository: PathBuf,
    error: git2::Error,
}

fn open_repository(root: &Path, dir: &Path) -> Result<Option<Repository>, OpenFailure> {
    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let ceilings: Vec<&Path> = canonical_root.parent().into_iter().collect();
    match Repository::open_ext(dir, RepositoryOpenFlags::empty(), &ceilings) {
        Ok(repository) => Ok(Some(repository)),
        Err(error) if error.code() == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(OpenFailure {
            repository: Repository::discover_path(dir, &ceilings)
                .unwrap_or_else(|_| dir.to_path_buf()),
            error,
        }),
    }
}

fn first_report_of(repository: &Path) -> bool {
    static REPORTED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    REPORTED
        .get_or_init(|| Mutex::new(HashSet::new()))
        .lock()
        .insert(repository.to_path_buf())
}

pub fn list_dir(root: &Path, rel: &str) -> AppResult<Vec<FileEntry>> {
    let dir = resolve_existing(root, rel)?;
    if !std::fs::metadata(&dir)?.is_dir() {
        return Err(AppError::InvalidPath {
            path: rel.to_string(),
            reason: "to nie jest katalog".to_string(),
        });
    }
    let checker = IgnoreChecker::for_dir(root, &dir);
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&dir)? {
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
        let is_dir = file_type.is_dir()
            || (file_type.is_symlink()
                && std::fs::metadata(&path).is_ok_and(|metadata| metadata.is_dir()));
        entries.push(FileEntry {
            ignored: checker.is_ignored(&path, file_type.is_dir()),
            kind: if is_dir {
                FileEntryKind::Dir
            } else {
                FileEntryKind::File
            },
            name,
        });
    }
    entries.sort_by_cached_key(|entry| {
        (
            entry.kind == FileEntryKind::File,
            entry.name.to_lowercase(),
            entry.name.clone(),
        )
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn names(entries: &[FileEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.name.as_str()).collect()
    }

    fn init_ignoring(root: &Path, gitignore: &str) {
        git2::Repository::init(root).unwrap();
        fs::write(root.join(".gitignore"), gitignore).unwrap();
    }

    fn find<'a>(entries: &'a [FileEntry], name: &str) -> &'a FileEntry {
        entries
            .iter()
            .find(|entry| entry.name == name)
            .unwrap_or_else(|| panic!("missing entry {name}"))
    }

    #[test]
    fn sorts_dirs_first_case_insensitive() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("b.txt"), "x").unwrap();
        fs::write(root.path().join("A.txt"), "x").unwrap();
        fs::create_dir(root.path().join("zdir")).unwrap();
        fs::create_dir(root.path().join("Adir")).unwrap();
        let entries = list_dir(root.path(), "").unwrap();
        assert_eq!(names(&entries), ["Adir", "zdir", "A.txt", "b.txt"]);
        assert_eq!(entries[0].kind, FileEntryKind::Dir);
        assert_eq!(entries[2].kind, FileEntryKind::File);
    }

    #[test]
    fn omits_git_dir() {
        let root = tempfile::tempdir().unwrap();
        git2::Repository::init(root.path()).unwrap();
        fs::write(root.path().join("a.txt"), "x").unwrap();
        let entries = list_dir(root.path(), "").unwrap();
        assert_eq!(names(&entries), ["a.txt"]);
    }

    #[test]
    fn flags_ignored_entries() {
        let root = tempfile::tempdir().unwrap();
        git2::Repository::init(root.path()).unwrap();
        fs::write(root.path().join(".gitignore"), ".env\nnode_modules/\n").unwrap();
        fs::write(root.path().join(".env"), "x").unwrap();
        fs::write(root.path().join(".env.example"), "x").unwrap();
        fs::create_dir(root.path().join("node_modules")).unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        let entries = list_dir(root.path(), "").unwrap();
        assert!(find(&entries, ".env").ignored);
        assert!(find(&entries, "node_modules").ignored);
        assert!(!find(&entries, ".env.example").ignored);
        assert!(!find(&entries, "src").ignored);
        assert!(!find(&entries, ".gitignore").ignored);
    }

    #[test]
    fn no_repo_means_nothing_ignored() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(".gitignore"), ".env\n").unwrap();
        fs::write(root.path().join(".env"), "x").unwrap();
        let entries = list_dir(root.path(), "").unwrap();
        assert!(entries.iter().all(|entry| !entry.ignored));
    }

    #[test]
    fn nested_repo_uses_its_own_rules() {
        let root = tempfile::tempdir().unwrap();
        let service = root.path().join("svc");
        fs::create_dir(&service).unwrap();
        git2::Repository::init(&service).unwrap();
        fs::write(service.join(".gitignore"), "secret.txt\n").unwrap();
        fs::write(service.join("secret.txt"), "x").unwrap();
        fs::write(service.join("public.txt"), "x").unwrap();
        let entries = list_dir(root.path(), "svc").unwrap();
        assert!(find(&entries, "secret.txt").ignored);
        assert!(!find(&entries, "public.txt").ignored);
        let top = list_dir(root.path(), "").unwrap();
        assert!(!find(&top, "svc").ignored);
    }

    #[test]
    fn parent_repo_is_not_used() {
        let outer = tempfile::tempdir().unwrap();
        git2::Repository::init(outer.path()).unwrap();
        fs::write(outer.path().join(".gitignore"), "*.log\n").unwrap();
        let project = outer.path().join("project");
        fs::create_dir(&project).unwrap();
        fs::write(project.join("a.log"), "x").unwrap();
        let entries = list_dir(&project, "").unwrap();
        assert!(!find(&entries, "a.log").ignored);
    }

    #[test]
    fn handles_special_names() {
        let root = tempfile::tempdir().unwrap();
        for name in ["with space.txt", "zażółć.md", "a#b%.txt"] {
            fs::write(root.path().join(name), "x").unwrap();
        }
        let entries = list_dir(root.path(), "").unwrap();
        for name in ["with space.txt", "zażółć.md", "a#b%.txt"] {
            assert_eq!(find(&entries, name).kind, FileEntryKind::File);
        }
        assert_eq!(entries.len(), 3);
    }

    #[test]
    fn listing_a_file_is_invalid_path() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "x").unwrap();
        let error = list_dir(root.path(), "a.txt").unwrap_err();
        assert!(matches!(error, AppError::InvalidPath { .. }), "{error:?}");
    }

    #[test]
    fn names_differing_only_in_case_sort_exactly() {
        let root = tempfile::tempdir().unwrap();
        for name in ["b.txt", "a.txt", "B.txt", "A.txt"] {
            fs::write(root.path().join(name), "x").unwrap();
        }
        let entries = list_dir(root.path(), "").unwrap();
        assert_eq!(names(&entries), ["A.txt", "a.txt", "B.txt", "b.txt"]);
    }

    #[test]
    fn missing_repository_is_not_a_failure_but_a_broken_one_is() {
        let plain = tempfile::tempdir().unwrap();
        assert!(matches!(
            open_repository(plain.path(), plain.path()),
            Ok(None)
        ));

        let healthy = tempfile::tempdir().unwrap();
        git2::Repository::init(healthy.path()).unwrap();
        assert!(matches!(
            open_repository(healthy.path(), healthy.path()),
            Ok(Some(_))
        ));

        let broken = tempfile::tempdir().unwrap();
        git2::Repository::init(broken.path()).unwrap();
        fs::write(broken.path().join(".git/config"), "[core\n").unwrap();
        assert!(open_repository(broken.path(), broken.path()).is_err());
    }

    #[test]
    fn broken_repository_lists_without_ignore_data() {
        let root = tempfile::tempdir().unwrap();
        init_ignoring(root.path(), ".env\n");
        fs::write(root.path().join(".git/config"), "[core\n").unwrap();
        fs::write(root.path().join(".env"), "x").unwrap();
        let checker = IgnoreChecker::for_dir(root.path(), root.path());
        assert!(!checker.has_repository());
        let entries = list_dir(root.path(), "").unwrap();
        assert!(!find(&entries, ".env").ignored);
    }

    #[test]
    fn ignore_check_errors_count_as_not_ignored_and_are_reported_once() {
        let root = tempfile::tempdir().unwrap();
        init_ignoring(root.path(), "*\n");
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        let checker = IgnoreChecker::for_dir(&canonical_root, &canonical_root);
        assert!(checker.has_repository());
        assert!(checker.is_ignored(&canonical_root.join("a.txt"), false));
        assert!(!checker.ignore_error_reported.get());
        let unrepresentable = canonical_root.join("a\0b");
        assert!(!checker.is_ignored(&unrepresentable, false));
        assert!(checker.ignore_error_reported.get());
        assert!(!checker.is_ignored(&unrepresentable, false));
        assert!(checker.is_ignored(&canonical_root.join("a.txt"), false));
    }

    #[test]
    fn a_broken_repository_is_reported_once_for_every_directory_below_it() {
        let root = tempfile::tempdir().unwrap();
        init_ignoring(root.path(), "");
        fs::write(root.path().join(".git/config"), "[core\n").unwrap();
        fs::create_dir(root.path().join("a")).unwrap();
        fs::create_dir(root.path().join("b")).unwrap();
        let canonical_root = fs::canonicalize(root.path()).unwrap();

        let checker = IgnoreChecker::for_dir(&canonical_root, &canonical_root.join("a"));
        assert!(!checker.has_repository());
        let Err(failure) = open_repository(&canonical_root, &canonical_root.join("b")) else {
            panic!("the broken repository opened");
        };
        assert!(failure.repository.starts_with(&canonical_root));
        assert!(!first_report_of(&failure.repository));
        assert!(list_dir(&canonical_root, "b").is_ok());
        assert!(!first_report_of(&failure.repository));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_directory_is_checked_against_ignore_rules_as_a_link() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        init_ignoring(root.path(), "real-dir/\n");
        let canonical_root = fs::canonicalize(root.path()).unwrap();
        fs::create_dir(canonical_root.join("real-dir")).unwrap();
        fs::create_dir(canonical_root.join("target")).unwrap();
        symlink("real-dir", canonical_root.join("linked")).unwrap();
        let checker = IgnoreChecker::for_dir(&canonical_root, &canonical_root);
        let entries = list_dir(&canonical_root, "").unwrap();
        assert_eq!(find(&entries, "linked").kind, FileEntryKind::Dir);
        assert_eq!(
            find(&entries, "linked").ignored,
            checker.is_ignored(&canonical_root.join("linked"), false)
        );
        assert!(find(&entries, "real-dir").ignored);
        assert!(!find(&entries, "target").ignored);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_reports_target_kind() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("real")).unwrap();
        fs::write(root.path().join("file.txt"), "x").unwrap();
        symlink("real", root.path().join("dir-link")).unwrap();
        symlink("file.txt", root.path().join("file-link")).unwrap();
        symlink("missing", root.path().join("broken-link")).unwrap();
        let entries = list_dir(root.path(), "").unwrap();
        assert_eq!(find(&entries, "dir-link").kind, FileEntryKind::Dir);
        assert_eq!(find(&entries, "file-link").kind, FileEntryKind::File);
        assert_eq!(find(&entries, "broken-link").kind, FileEntryKind::File);
    }
}

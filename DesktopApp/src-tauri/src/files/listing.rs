use std::path::{Path, PathBuf};

use git2::{Repository, RepositoryOpenFlags};

use crate::domain::{FileEntry, FileEntryKind};
use crate::error::AppResult;
use crate::files::paths::{resolve_existing, GIT_DIR};

pub struct IgnoreChecker {
    repository: Option<Repository>,
    workdir: PathBuf,
}

impl IgnoreChecker {
    pub fn for_dir(root: &Path, dir: &Path) -> IgnoreChecker {
        let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let ceilings: Vec<PathBuf> = canonical_root
            .parent()
            .map(|parent| vec![parent.to_path_buf()])
            .unwrap_or_default();
        let repository = Repository::open_ext(dir, RepositoryOpenFlags::empty(), &ceilings).ok();
        let workdir = repository
            .as_ref()
            .and_then(Repository::workdir)
            .map(|workdir| std::fs::canonicalize(workdir).unwrap_or_else(|_| workdir.to_path_buf()))
            .unwrap_or_default();
        IgnoreChecker {
            repository,
            workdir,
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
        repository
            .is_path_ignored(Path::new(&candidate))
            .unwrap_or(false)
    }
}

pub fn list_dir(root: &Path, rel: &str) -> AppResult<Vec<FileEntry>> {
    let dir = resolve_existing(root, rel)?;
    let checker = IgnoreChecker::for_dir(root, &dir);
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&dir)? {
        let item = item?;
        let Ok(name) = item.file_name().into_string() else {
            continue;
        };
        if name.eq_ignore_ascii_case(GIT_DIR) {
            continue;
        }
        let path = item.path();
        let is_dir = std::fs::metadata(&path)
            .map(|metadata| metadata.is_dir())
            .unwrap_or(false);
        let is_real_dir = item
            .file_type()
            .map(|file_type| file_type.is_dir())
            .unwrap_or(false);
        entries.push(FileEntry {
            ignored: checker.is_ignored(&path, is_real_dir),
            kind: if is_dir {
                FileEntryKind::Dir
            } else {
                FileEntryKind::File
            },
            name,
        });
    }
    entries.sort_by(|left, right| {
        let left_rank = left.kind == FileEntryKind::File;
        let right_rank = right.kind == FileEntryKind::File;
        left_rank
            .cmp(&right_rank)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
            .then_with(|| left.name.cmp(&right.name))
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::FileEntryKind;
    use std::fs;

    fn names(entries: &[FileEntry]) -> Vec<&str> {
        entries.iter().map(|entry| entry.name.as_str()).collect()
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

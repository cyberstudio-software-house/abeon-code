use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

pub const GIT_DIR: &str = ".git";

pub fn resolve_existing(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let relative = relative_path(rel)?;
    let canonical_root = canonicalize(root, &root.to_string_lossy())?;
    let resolved = canonicalize(&canonical_root.join(relative), rel)?;
    ensure_inside(&canonical_root, resolved, rel)
}

pub fn resolve_for_write(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let relative = relative_path(rel)?;
    let canonical_root = canonicalize(root, &root.to_string_lossy())?;
    let target = canonical_root.join(&relative);
    match std::fs::canonicalize(&target) {
        Ok(resolved) => ensure_inside(&canonical_root, resolved, rel),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            if std::fs::symlink_metadata(&target).is_ok() {
                return Err(invalid(
                    rel,
                    "dowiązanie symboliczne wskazuje nieistniejący plik",
                ));
            }
            let (Some(parent), Some(name)) = (target.parent(), relative.file_name()) else {
                return Err(AppError::NotFound(rel.to_string()));
            };
            let parent = ensure_inside(&canonical_root, canonicalize(parent, rel)?, rel)?;
            Ok(parent.join(name))
        }
        Err(error) => Err(map_io_error(error, rel)),
    }
}

fn relative_path(rel: &str) -> AppResult<PathBuf> {
    let mut relative = PathBuf::new();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(name) if name.eq_ignore_ascii_case(GIT_DIR) => {
                return Err(invalid(rel, "katalog .git jest niedostępny"));
            }
            Component::Normal(name) => relative.push(name),
            Component::CurDir => {}
            Component::ParentDir => return Err(invalid(rel, "ścieżka nie może zawierać ..")),
            Component::RootDir | Component::Prefix(_) => {
                return Err(invalid(rel, "ścieżka musi być względna"));
            }
        }
    }
    Ok(relative)
}

fn ensure_inside(canonical_root: &Path, resolved: PathBuf, rel: &str) -> AppResult<PathBuf> {
    let inner = resolved
        .strip_prefix(canonical_root)
        .map_err(|_| invalid(rel, "ścieżka wychodzi poza projekt"))?;
    if inner
        .components()
        .any(|component| component.as_os_str().eq_ignore_ascii_case(GIT_DIR))
    {
        return Err(invalid(rel, "katalog .git jest niedostępny"));
    }
    Ok(resolved)
}

fn canonicalize(path: &Path, label: &str) -> AppResult<PathBuf> {
    std::fs::canonicalize(path).map_err(|error| map_io_error(error, label))
}

fn map_io_error(error: std::io::Error, label: &str) -> AppError {
    match error.kind() {
        ErrorKind::NotFound | ErrorKind::NotADirectory => AppError::NotFound(label.to_string()),
        _ => AppError::Io(error),
    }
}

fn invalid(rel: &str, reason: &str) -> AppError {
    AppError::InvalidPath {
        path: rel.to_string(),
        reason: reason.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn canonical(path: &Path) -> PathBuf {
        fs::canonicalize(path).unwrap()
    }

    fn assert_invalid(result: AppResult<PathBuf>) {
        assert!(
            matches!(result, Err(AppError::InvalidPath { .. })),
            "{result:?}"
        );
    }

    fn assert_not_found(result: AppResult<PathBuf>) {
        assert!(matches!(result, Err(AppError::NotFound(_))), "{result:?}");
    }

    #[cfg(unix)]
    fn symlink(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[test]
    fn resolves_nested_file() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("a")).unwrap();
        fs::write(root.path().join("a/b.txt"), "x").unwrap();
        let resolved = resolve_existing(root.path(), "a/b.txt").unwrap();
        assert_eq!(resolved, canonical(root.path()).join("a").join("b.txt"));
        assert_eq!(resolve_for_write(root.path(), "a/b.txt").unwrap(), resolved);
    }

    #[test]
    fn empty_rel_is_root() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_existing(root.path(), "").unwrap(),
            canonical(root.path())
        );
    }

    #[test]
    fn rejects_parent_traversal() {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("root");
        fs::create_dir_all(root.join("a")).unwrap();
        fs::write(base.path().join("x"), "outside").unwrap();
        for rel in ["../x", "a/../../x", "a/.."] {
            assert_invalid(resolve_existing(&root, rel));
            assert_invalid(resolve_for_write(&root, rel));
        }
    }

    #[test]
    fn rejects_absolute_path() {
        let root = tempfile::tempdir().unwrap();
        let inside = root.path().join("f.txt");
        fs::write(&inside, "x").unwrap();
        for rel in ["/etc/passwd", inside.to_str().unwrap()] {
            assert_invalid(resolve_existing(root.path(), rel));
            assert_invalid(resolve_for_write(root.path(), rel));
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_leaving_root() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        fs::write(other.path().join("secret"), "s").unwrap();
        symlink(other.path(), &root.path().join("out"));
        symlink(
            &other.path().join("secret"),
            &root.path().join("secret-link"),
        );
        for rel in ["out", "out/secret", "secret-link"] {
            assert_invalid(resolve_existing(root.path(), rel));
            assert_invalid(resolve_for_write(root.path(), rel));
        }
        assert_invalid(resolve_for_write(root.path(), "out/new.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn write_rejects_dangling_symlink() {
        let root = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        symlink(
            &other.path().join("missing.txt"),
            &root.path().join("link.txt"),
        );
        assert_invalid(resolve_for_write(root.path(), "link.txt"));
        assert_not_found(resolve_existing(root.path(), "link.txt"));
    }

    #[cfg(unix)]
    #[test]
    fn allows_symlink_inside_root() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("real")).unwrap();
        fs::write(root.path().join("real/f.txt"), "x").unwrap();
        symlink(Path::new("real"), &root.path().join("alias"));
        symlink(
            &root.path().join("real/f.txt"),
            &root.path().join("f-link.txt"),
        );
        let real_dir = canonical(root.path()).join("real");
        let expected = real_dir.join("f.txt");
        assert_eq!(
            resolve_existing(root.path(), "alias/f.txt").unwrap(),
            expected
        );
        assert_eq!(
            resolve_existing(root.path(), "f-link.txt").unwrap(),
            expected
        );
        assert_eq!(
            resolve_for_write(root.path(), "f-link.txt").unwrap(),
            expected
        );
        assert_eq!(
            resolve_for_write(root.path(), "alias/new.txt").unwrap(),
            real_dir.join("new.txt")
        );
    }

    #[test]
    fn write_target_may_be_missing() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("a")).unwrap();
        let canonical_root = canonical(root.path());
        assert_eq!(
            resolve_for_write(root.path(), "a/new.txt").unwrap(),
            canonical_root.join("a").join("new.txt")
        );
        assert_eq!(
            resolve_for_write(root.path(), "new.txt").unwrap(),
            canonical_root.join("new.txt")
        );
        assert_not_found(resolve_for_write(root.path(), "missing/new.txt"));
        assert_not_found(resolve_existing(root.path(), "a/new.txt"));
    }

    #[test]
    fn path_through_file_is_not_found() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("b.txt"), "x").unwrap();
        assert_not_found(resolve_existing(root.path(), "b.txt/c"));
        assert_not_found(resolve_for_write(root.path(), "b.txt/c"));
    }

    #[test]
    fn write_rejects_git_dir() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".git/hooks")).unwrap();
        fs::write(root.path().join(".git/config"), "x").unwrap();
        for rel in [
            ".git",
            ".git/config",
            ".git/hooks/pre-commit",
            "sub/.git/config",
            "./.git/config",
        ] {
            assert_invalid(resolve_for_write(root.path(), rel));
        }
    }

    #[test]
    fn existing_rejects_git_dir() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".git/config"), "x").unwrap();
        fs::create_dir(root.path().join("sub")).unwrap();
        fs::write(root.path().join("sub/.git"), "gitdir: ../.git").unwrap();
        for rel in [".git", ".git/config", "sub/.git"] {
            assert_invalid(resolve_existing(root.path(), rel));
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_into_git_dir() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git")).unwrap();
        fs::write(root.path().join(".git/config"), "x").unwrap();
        symlink(Path::new(".git"), &root.path().join("git-link"));
        symlink(Path::new(".git/config"), &root.path().join("config-link"));
        for rel in ["git-link", "git-link/config", "config-link"] {
            assert_invalid(resolve_existing(root.path(), rel));
            assert_invalid(resolve_for_write(root.path(), rel));
        }
        assert_invalid(resolve_for_write(root.path(), "git-link/new"));
    }

    #[test]
    fn rejects_git_dir_in_any_case() {
        let root = tempfile::tempdir().unwrap();
        for rel in [
            ".GIT",
            ".Git",
            ".GIT/config",
            ".GIT/hooks/pre-commit",
            "sub/.gIt/config",
        ] {
            assert_invalid(resolve_existing(root.path(), rel));
            assert_invalid(resolve_for_write(root.path(), rel));
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_into_git_dir_in_any_case() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".GIT")).unwrap();
        fs::write(root.path().join(".GIT/config"), "x").unwrap();
        symlink(Path::new(".GIT"), &root.path().join("upper-link"));
        for rel in ["upper-link", "upper-link/config"] {
            assert_invalid(resolve_existing(root.path(), rel));
            assert_invalid(resolve_for_write(root.path(), rel));
        }
        assert_invalid(resolve_for_write(root.path(), "upper-link/new"));
    }

    #[test]
    fn allows_git_like_names() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".github")).unwrap();
        fs::write(root.path().join(".github/ci.yml"), "x").unwrap();
        fs::write(root.path().join(".gitignore"), "x").unwrap();
        let canonical_root = canonical(root.path());
        assert_eq!(
            resolve_existing(root.path(), ".github/ci.yml").unwrap(),
            canonical_root.join(".github").join("ci.yml")
        );
        assert_eq!(
            resolve_existing(root.path(), ".gitignore").unwrap(),
            canonical_root.join(".gitignore")
        );
    }
}

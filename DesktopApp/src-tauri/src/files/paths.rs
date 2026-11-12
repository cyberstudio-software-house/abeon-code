use std::ffi::OsStr;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

pub const GIT_DIR: &str = ".git";
const IGNORABLE_CODE_POINTS: &[char] = &['\u{200b}', '\u{200c}', '\u{200d}', '\u{feff}'];

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

pub fn watch_dir_of(root: &Path, rel: &str, resolved: &Path) -> String {
    std::fs::canonicalize(root)
        .ok()
        .and_then(|canonical_root| {
            let dir = resolved.parent()?.strip_prefix(canonical_root).ok()?;
            slash_joined(dir)
        })
        .unwrap_or_else(|| requested_dir(rel))
}

fn slash_joined(path: &Path) -> Option<String> {
    let parts: Option<Vec<&str>> = path
        .components()
        .map(|component| component.as_os_str().to_str())
        .collect();
    parts.map(|parts| parts.join("/"))
}

fn requested_dir(rel: &str) -> String {
    let parts: Vec<&str> = rel
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    parts[..parts.len().saturating_sub(1)].join("/")
}

fn relative_path(rel: &str) -> AppResult<PathBuf> {
    let mut relative = PathBuf::new();
    for component in Path::new(rel).components() {
        match component {
            Component::Normal(name) if is_git_dir(name) => {
                return Err(invalid(rel, "katalog .git jest niedostępny"));
            }
            Component::Normal(name) => {
                #[cfg(windows)]
                ensure_windows_name(rel, name)?;
                relative.push(name);
            }
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
        .any(|component| is_git_dir(component.as_os_str()))
    {
        return Err(invalid(rel, "katalog .git jest niedostępny"));
    }
    Ok(resolved)
}

fn is_git_dir(name: &OsStr) -> bool {
    let visible: String = name
        .to_string_lossy()
        .chars()
        .filter(|character| !IGNORABLE_CODE_POINTS.contains(character))
        .collect();
    visible.eq_ignore_ascii_case(GIT_DIR)
}

#[cfg(windows)]
fn ensure_windows_name(rel: &str, name: &OsStr) -> AppResult<()> {
    let name = name.to_string_lossy();
    if name.contains(':') {
        return Err(invalid(rel, "ścieżka nie może zawierać :"));
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err(invalid(rel, "nazwa nie może kończyć się kropką ani spacją"));
    }
    Ok(())
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

    fn watch_dir(root: &Path, rel: &str) -> String {
        watch_dir_of(root, rel, &resolve_existing(root, rel).unwrap())
    }

    #[test]
    fn watch_dir_is_the_directory_of_the_resolved_file() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("src/deep")).unwrap();
        fs::write(root.path().join("a.txt"), "x").unwrap();
        fs::write(root.path().join("src/a.ts"), "x").unwrap();
        fs::write(root.path().join("src/deep/x"), "x").unwrap();
        assert_eq!(watch_dir(root.path(), "a.txt"), "");
        assert_eq!(watch_dir(root.path(), "src/a.ts"), "src");
        assert_eq!(watch_dir(root.path(), "./src/deep/x"), "src/deep");
    }

    #[cfg(unix)]
    #[test]
    fn watch_dir_follows_symlinks_to_where_the_bytes_live() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("config")).unwrap();
        fs::create_dir_all(root.path().join("real")).unwrap();
        fs::create_dir_all(root.path().join("sub")).unwrap();
        fs::write(root.path().join("config/real.env"), "x").unwrap();
        fs::write(root.path().join("real/f.txt"), "x").unwrap();
        fs::write(root.path().join("top.txt"), "x").unwrap();
        symlink(Path::new("config/real.env"), &root.path().join("link.env"));
        symlink(Path::new("real"), &root.path().join("alias"));
        symlink(Path::new("../top.txt"), &root.path().join("sub/top-link"));
        assert_eq!(watch_dir(root.path(), "link.env"), "config");
        assert_eq!(watch_dir(root.path(), "alias/f.txt"), "real");
        assert_eq!(watch_dir(root.path(), "sub/top-link"), "");
    }

    #[test]
    fn watch_dir_falls_back_to_the_requested_directory() {
        let root = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        let outside = elsewhere.path().join("x.txt");
        assert_eq!(watch_dir_of(root.path(), "a/b.txt", &outside), "a");
        assert_eq!(watch_dir_of(root.path(), "./b.txt", &outside), "");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn watch_dir_with_a_non_utf8_target_directory_falls_back() {
        use std::os::unix::ffi::OsStrExt;

        let root = tempfile::tempdir().unwrap();
        let odd = root.path().join(std::ffi::OsStr::from_bytes(&[b'd', 0xff]));
        fs::create_dir(&odd).unwrap();
        fs::write(odd.join("f.txt"), "x").unwrap();
        fs::create_dir(root.path().join("links")).unwrap();
        symlink(&odd.join("f.txt"), &root.path().join("links/f.txt"));
        assert_eq!(watch_dir(root.path(), "links/f.txt"), "links");
    }

    #[test]
    fn rejects_git_dir_hidden_by_ignorable_code_points() {
        let root = tempfile::tempdir().unwrap();
        for rel in [
            ".git\u{200b}",
            "\u{feff}.git/config",
            ".g\u{200c}it/config",
            "sub/.GIT\u{200d}/hooks/pre-commit",
        ] {
            assert_invalid(resolve_existing(root.path(), rel));
            assert_invalid(resolve_for_write(root.path(), rel));
        }
        assert!(resolve_for_write(root.path(), "\u{200b}notes.txt").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_into_git_dir_hidden_by_ignorable_code_points() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join(".git\u{200b}")).unwrap();
        fs::write(root.path().join(".git\u{200b}/config"), "x").unwrap();
        symlink(Path::new(".git\u{200b}"), &root.path().join("hidden"));
        for rel in ["hidden", "hidden/config"] {
            assert_invalid(resolve_existing(root.path(), rel));
            assert_invalid(resolve_for_write(root.path(), rel));
        }
    }

    #[cfg(windows)]
    #[test]
    fn rejects_windows_prefixes_streams_and_trailing_dots() {
        let root = tempfile::tempdir().unwrap();
        for rel in [
            "C:x",
            "C:\\x",
            "\\\\srv\\share\\x",
            "a\\..\\..\\x",
            "f.txt:s",
            "dir\\f.txt::$DATA",
            ".git.",
            ".git ",
            "a\\.GIT.\\config",
            "notes.",
        ] {
            assert_invalid(resolve_existing(root.path(), rel));
            assert_invalid(resolve_for_write(root.path(), rel));
        }
        assert!(resolve_for_write(root.path(), "notes.txt").is_ok());
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

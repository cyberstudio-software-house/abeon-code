use std::fs::{File, Metadata, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::Path;

use tempfile::{NamedTempFile, PersistError};

use crate::error::{AppError, AppResult};
use crate::files::content::version_of;
use crate::files::NOT_REGULAR_FILE;

pub fn write_file(
    path: &Path,
    content: &str,
    expected_version: Option<&str>,
    force: bool,
) -> AppResult<String> {
    let target = Target {
        path,
        expected_version,
        force,
    };
    let bytes = content.as_bytes();
    match regular_file(path)? {
        None => {
            target.verify(None)?;
            create(&target, bytes)
        }
        Some(metadata) => {
            target.verify(Some(&version_of(&metadata)?))?;
            replace(&target, bytes, &metadata)
        }
    }
}

struct Target<'a> {
    path: &'a Path,
    expected_version: Option<&'a str>,
    force: bool,
}

impl Target<'_> {
    fn verify(&self, version: Option<&str>) -> AppResult<()> {
        if self.force || version == self.expected_version {
            return Ok(());
        }
        Err(AppError::Conflict(display(self.path)))
    }

    fn verify_on_disk(&self) -> AppResult<()> {
        if self.force {
            return Ok(());
        }
        let version = regular_file(self.path)?
            .as_ref()
            .map(version_of)
            .transpose()?;
        self.verify(version.as_deref())
    }
}

fn create(target: &Target, bytes: &[u8]) -> AppResult<String> {
    let mut temp = new_file_temp(parent_dir(target.path)?)?;
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    let version = version_of(&temp.as_file().metadata()?)?;
    if target.force {
        temp.persist(target.path).map_err(|error| error.error)?;
        return Ok(version);
    }
    if let Err(error) = temp.persist_noclobber(target.path) {
        let temp = retry_without_noclobber(target.path, error)?;
        target.verify_on_disk()?;
        temp.persist(target.path).map_err(|error| error.error)?;
    }
    Ok(version)
}

fn retry_without_noclobber(path: &Path, error: PersistError) -> AppResult<NamedTempFile> {
    if error.error.kind() == ErrorKind::AlreadyExists {
        return Err(AppError::Conflict(display(path)));
    }
    Ok(error.file)
}

fn replace(target: &Target, bytes: &[u8], original: &Metadata) -> AppResult<String> {
    if !needs_in_place(target.path, original) {
        if let Some(version) = replace_atomically(target, bytes, original)? {
            return Ok(version);
        }
    }
    write_in_place(target, bytes)
}

fn replace_atomically(
    target: &Target,
    bytes: &[u8],
    original: &Metadata,
) -> AppResult<Option<String>> {
    let mut temp = match NamedTempFile::new_in(parent_dir(target.path)?) {
        Ok(temp) => temp,
        Err(error) => return in_place_unless_out_of_space(error),
    };
    temp.write_all(bytes)?;
    temp.as_file().sync_all()?;
    if let Err(error) = copy_permissions(temp.as_file(), original) {
        return in_place_unless_out_of_space(error);
    }
    temp.as_file().sync_all()?;
    let version = version_of(&temp.as_file().metadata()?)?;
    target.verify_on_disk()?;
    match temp.persist(target.path) {
        Ok(_) => Ok(Some(version)),
        Err(error) => in_place_unless_out_of_space(error.error),
    }
}

fn in_place_unless_out_of_space(error: std::io::Error) -> AppResult<Option<String>> {
    if is_out_of_space(&error) {
        return Err(error.into());
    }
    Ok(None)
}

fn is_out_of_space(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::StorageFull | ErrorKind::QuotaExceeded
    )
}

fn write_in_place(target: &Target, bytes: &[u8]) -> AppResult<String> {
    let mut file = open_for_rewrite(target.path)?;
    target.verify(Some(&version_of(&file.metadata()?)?))?;
    file.write_all(bytes)?;
    file.set_len(bytes.len() as u64)?;
    file.sync_all()?;
    version_of(&file.metadata()?)
}

fn regular_file(path: &Path) -> AppResult<Option<Metadata>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(Some(metadata)),
        Ok(_) => Err(AppError::InvalidPath {
            path: display(path),
            reason: NOT_REGULAR_FILE.to_string(),
        }),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn parent_dir(path: &Path) -> AppResult<&Path> {
    path.parent()
        .ok_or_else(|| AppError::NotFound(display(path)))
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn open_for_rewrite(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.custom_flags(libc::O_NOFOLLOW);
    }
    options.open(path)
}

#[cfg(unix)]
fn needs_in_place(path: &Path, original: &Metadata) -> bool {
    use std::os::unix::fs::MetadataExt;

    original.nlink() > 1
        || original.uid() != unsafe { libc::geteuid() }
        || !writable(path)
        || path.parent().is_none_or(|dir| !writable(dir))
}

#[cfg(not(unix))]
fn needs_in_place(_path: &Path, _original: &Metadata) -> bool {
    false
}

#[cfg(unix)]
fn writable(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;

    std::ffi::CString::new(path.as_os_str().as_bytes())
        .is_ok_and(|path| unsafe { libc::access(path.as_ptr(), libc::W_OK) } == 0)
}

#[cfg(unix)]
fn copy_permissions(temp: &File, original: &Metadata) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;

    if temp.metadata()?.gid() != original.gid() {
        std::os::unix::fs::fchown(temp, None, Some(original.gid()))?;
    }
    temp.set_permissions(original.permissions())
}

#[cfg(not(unix))]
fn copy_permissions(_temp: &File, _original: &Metadata) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn new_file_temp(dir: &Path) -> std::io::Result<NamedTempFile> {
    use std::os::unix::fs::PermissionsExt;

    tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o666))
        .tempfile_in(dir)
}

#[cfg(not(unix))]
fn new_file_temp(dir: &Path) -> std::io::Result<NamedTempFile> {
    NamedTempFile::new_in(dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use crate::files::content::file_version;
    use filetime::{set_file_mtime, FileTime};
    use std::fs;
    use std::path::PathBuf;
    use tempfile::tempdir;

    fn file_with(dir: &Path, name: &str, content: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, content).unwrap();
        path
    }

    fn version(path: &Path) -> String {
        file_version(path).unwrap().unwrap()
    }

    fn assert_conflict(result: AppResult<String>) {
        assert!(matches!(result, Err(AppError::Conflict(_))), "{result:?}");
    }

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[cfg(unix)]
    fn is_root() -> bool {
        unsafe { libc::geteuid() == 0 }
    }

    #[cfg(unix)]
    fn mode(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;

        fs::metadata(path).unwrap().permissions().mode() & 0o7777
    }

    #[cfg(unix)]
    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;

        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[cfg(unix)]
    fn inode(path: &Path) -> u64 {
        use std::os::unix::fs::MetadataExt;

        fs::metadata(path).unwrap().ino()
    }

    #[cfg(unix)]
    fn secondary_group() -> Option<u32> {
        let count = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
        if count <= 0 {
            return None;
        }
        let mut groups = vec![0; count as usize];
        let count = unsafe { libc::getgroups(count, groups.as_mut_ptr()) };
        groups.truncate(count.max(0) as usize);
        let primary = unsafe { libc::getegid() };
        groups.into_iter().find(|&group| group != primary)
    }

    #[test]
    fn writes_and_returns_new_version() {
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "a.txt", "old");
        set_file_mtime(&path, FileTime::from_unix_time(1_700_000_000, 0)).unwrap();
        let old = version(&path);
        let new = write_file(&path, "new", Some(&old), false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new");
        assert_eq!(new, version(&path));
        assert_ne!(new, old);
    }

    #[test]
    fn conflict_when_version_differs() {
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "a.txt", "one");
        let stale = version(&path);
        fs::write(&path, "agent wrote this").unwrap();
        assert_conflict(write_file(&path, "mine", Some(&stale), false));
        assert_eq!(fs::read_to_string(&path).unwrap(), "agent wrote this");
    }

    #[test]
    fn conflict_when_file_deleted() {
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "a.txt", "one");
        let stale = version(&path);
        fs::remove_file(&path).unwrap();
        assert_conflict(write_file(&path, "mine", Some(&stale), false));
        assert!(entries(dir.path()).is_empty());
    }

    #[test]
    fn force_overwrites_on_conflict() {
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "a.txt", "one");
        let stale = version(&path);
        fs::write(&path, "agent wrote this").unwrap();
        let new = write_file(&path, "mine", Some(&stale), true).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "mine");
        assert_eq!(new, version(&path));
    }

    #[test]
    fn creates_missing_file_when_expected_none() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("new.env");
        let new = write_file(&path, "KEY=value\n", None, false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "KEY=value\n");
        assert_eq!(new, version(&path));
    }

    #[test]
    fn conflict_when_file_appeared() {
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "a.txt", "theirs");
        assert_conflict(write_file(&path, "mine", None, false));
        assert_eq!(fs::read_to_string(&path).unwrap(), "theirs");
    }

    #[test]
    fn does_not_create_parent_directories() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("missing").join("new.env");
        assert!(write_file(&path, "A=1", None, true).is_err());
        assert!(entries(dir.path()).is_empty());
    }

    #[test]
    fn rejects_directory_target() {
        let dir = tempdir().unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let error = write_file(&sub, "x", None, true).unwrap_err();
        assert!(matches!(error, AppError::InvalidPath { .. }), "{error:?}");
        assert!(sub.is_dir());
    }

    #[test]
    fn leaves_no_temp_files() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.txt");
        let created = write_file(&path, "one", None, false).unwrap();
        write_file(&path, "two!", Some(&created), false).unwrap();
        assert_eq!(entries(dir.path()), vec!["a.txt"]);
    }

    #[test]
    fn recognises_out_of_space_errors() {
        assert!(is_out_of_space(&std::io::Error::from(
            std::io::ErrorKind::StorageFull
        )));
        assert!(is_out_of_space(&std::io::Error::from(
            std::io::ErrorKind::QuotaExceeded
        )));
        for kind in [
            std::io::ErrorKind::PermissionDenied,
            std::io::ErrorKind::CrossesDevices,
            std::io::ErrorKind::ResourceBusy,
            std::io::ErrorKind::Unsupported,
        ] {
            assert!(!is_out_of_space(&std::io::Error::from(kind)), "{kind:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn recognises_out_of_space_os_errors() {
        assert!(is_out_of_space(&std::io::Error::from_raw_os_error(
            libc::ENOSPC
        )));
        assert!(is_out_of_space(&std::io::Error::from_raw_os_error(
            libc::EDQUOT
        )));
        assert!(!is_out_of_space(&std::io::Error::from_raw_os_error(
            libc::EXDEV
        )));
    }

    #[test]
    fn content_is_byte_exact() {
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "a.txt", "x");
        let raw = "a\r\nb\n";
        write_file(&path, raw, Some(&version(&path)), false).unwrap();
        assert_eq!(fs::read(&path).unwrap(), raw.as_bytes());
    }

    #[cfg(unix)]
    #[test]
    fn keeps_permissions() {
        for expected in [0o600, 0o640, 0o755] {
            let dir = tempdir().unwrap();
            let path = file_with(dir.path(), "script", "one");
            set_mode(&path, expected);
            let before = inode(&path);
            write_file(&path, "two", Some(&version(&path)), false).unwrap();
            assert_eq!(mode(&path), expected);
            assert_ne!(inode(&path), before);
            assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        }
    }

    #[cfg(unix)]
    #[test]
    fn keeps_group() {
        use std::os::unix::fs::MetadataExt;

        let Some(group) = secondary_group() else {
            return;
        };
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), ".env", "A=1");
        std::os::unix::fs::chown(&path, None, Some(group)).unwrap();
        set_mode(&path, 0o640);
        let before = inode(&path);
        write_file(&path, "A=2", Some(&version(&path)), false).unwrap();
        assert_eq!(fs::metadata(&path).unwrap().gid(), group);
        assert_eq!(mode(&path), 0o640);
        assert_ne!(inode(&path), before);
    }

    #[cfg(unix)]
    #[test]
    fn new_file_gets_default_permissions() {
        let dir = tempdir().unwrap();
        let reference = file_with(dir.path(), "reference", "");
        let path = dir.path().join("new.env");
        write_file(&path, "A=1", None, false).unwrap();
        assert_eq!(mode(&path), mode(&reference));
    }

    #[cfg(unix)]
    #[test]
    fn keeps_inode_for_hard_linked_file() {
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "a.env", "A=1");
        let link = dir.path().join("b.env");
        fs::hard_link(&path, &link).unwrap();
        let before = inode(&path);
        let new = write_file(&path, "A=2", Some(&version(&path)), false).unwrap();
        assert_eq!(inode(&path), before);
        assert_eq!(fs::read_to_string(&link).unwrap(), "A=2");
        assert_eq!(new, version(&path));
        assert_eq!(entries(dir.path()), vec!["a.env", "b.env"]);
    }

    #[cfg(unix)]
    #[test]
    fn in_place_rewrite_is_exact_when_size_changes() {
        for (old, new) in [
            ("A=1234567890\nB=2\n", "A=1\n"),
            ("A=1\n", "A=1234567890\nB=2\n"),
        ] {
            let dir = tempdir().unwrap();
            let path = file_with(dir.path(), "a.env", old);
            let link = dir.path().join("b.env");
            fs::hard_link(&path, &link).unwrap();
            let before = inode(&path);
            let version_after = write_file(&path, new, Some(&version(&path)), false).unwrap();
            assert_eq!(inode(&path), before);
            assert_eq!(fs::read(&path).unwrap(), new.as_bytes());
            assert_eq!(fs::read(&link).unwrap(), new.as_bytes());
            assert_eq!(version_after, version(&path));
        }
    }

    #[cfg(unix)]
    #[test]
    fn writes_in_place_when_directory_read_only() {
        if is_root() {
            return;
        }
        let dir = tempdir().unwrap();
        let sub = dir.path().join("config");
        fs::create_dir(&sub).unwrap();
        let path = file_with(&sub, "a.env", "A=1");
        set_mode(&path, 0o644);
        let before = inode(&path);
        let expected = version(&path);
        set_mode(&sub, 0o555);
        let result = write_file(&path, "A=2", Some(&expected), false);
        set_mode(&sub, 0o755);
        let new = result.unwrap();
        assert_eq!(inode(&path), before);
        assert_eq!(fs::read_to_string(&path).unwrap(), "A=2");
        assert_eq!(new, version(&path));
        assert_eq!(mode(&path), 0o644);
        assert_eq!(entries(&sub), vec!["a.env"]);
    }

    #[cfg(unix)]
    #[test]
    fn read_only_file_is_not_replaced() {
        if is_root() {
            return;
        }
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "locked.env", "A=1");
        set_mode(&path, 0o444);
        let error = write_file(&path, "A=2", Some(&version(&path)), false).unwrap_err();
        assert!(
            matches!(&error, AppError::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied),
            "{error:?}"
        );
        assert_eq!(fs::read_to_string(&path).unwrap(), "A=1");
        assert_eq!(mode(&path), 0o444);
        assert_eq!(entries(dir.path()), vec!["locked.env"]);
    }

    #[test]
    fn returned_version_is_the_version_of_the_written_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("a.env");
        let created = write_file(&path, "A=1", None, false).unwrap();
        assert_eq!(created, version(&path));
        let replaced = write_file(&path, "A=22", Some(&created), false).unwrap();
        assert_eq!(replaced, version(&path));
        let forced = write_file(&path, "A=333", Some("stale"), true).unwrap();
        assert_eq!(forced, version(&path));
    }

    #[cfg(unix)]
    #[test]
    fn in_place_returned_version_is_the_version_of_the_written_file() {
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "a.env", "A=1");
        fs::hard_link(&path, dir.path().join("b.env")).unwrap();
        let written = write_file(&path, "A=2\nB=3\n", Some(&version(&path)), false).unwrap();
        assert_eq!(written, version(&path));
    }

    #[test]
    fn existing_target_on_noclobber_is_a_conflict_and_drops_the_temp_file() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("a.env");
        let temp = NamedTempFile::new_in(dir.path()).unwrap();
        let temp_path = temp.path().to_path_buf();
        let error = PersistError {
            error: std::io::Error::from(ErrorKind::AlreadyExists),
            file: temp,
        };
        assert_conflict(retry_without_noclobber(&target, error).map(|_| String::new()));
        assert!(!temp_path.exists());
    }

    #[test]
    fn create_never_replaces_a_file_that_appeared_after_the_check() {
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "a.env", "theirs");
        let target = Target {
            path: &path,
            expected_version: None,
            force: false,
        };
        assert_conflict(create(&target, b"mine"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "theirs");
        assert_eq!(entries(dir.path()), vec!["a.env"]);
    }

    #[test]
    fn unsupported_noclobber_hands_the_temp_file_back() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("a.env");
        for error in [
            std::io::Error::from(ErrorKind::Unsupported),
            std::io::Error::from(ErrorKind::PermissionDenied),
        ] {
            let temp = NamedTempFile::new_in(dir.path()).unwrap();
            let temp_path = temp.path().to_path_buf();
            let error = PersistError { error, file: temp };
            let reclaimed = retry_without_noclobber(&target, error).unwrap();
            assert_eq!(reclaimed.path(), temp_path);
            assert!(temp_path.exists());
        }
    }

    #[test]
    fn leaves_no_temp_files_on_conflict() {
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "a.txt", "theirs");
        let stale = version(&path);
        assert_conflict(write_file(&path, "mine", None, false));
        fs::write(&path, "agent wrote this").unwrap();
        assert_conflict(write_file(&path, "mine", Some(&stale), false));
        assert_eq!(entries(dir.path()), vec!["a.txt"]);
    }

    #[test]
    fn write_contract_relied_on_by_the_frontend() {
        let dir = tempdir().unwrap();
        let path = file_with(dir.path(), "a.txt", "one");
        assert_conflict(write_file(&path, "two", None, false));
        let returned = write_file(&path, "two", Some(&version(&path)), false).unwrap();
        assert_eq!(returned, version(&path));
        let (nanos, size) = returned.rsplit_once('-').unwrap();
        assert!(nanos.parse::<i128>().is_ok(), "{returned}");
        assert_eq!(size, "3");
    }

    #[cfg(unix)]
    #[test]
    fn keeps_setuid_and_setgid_bits() {
        for expected in [0o4755, 0o2755, 0o6755] {
            let dir = tempdir().unwrap();
            let path = file_with(dir.path(), "tool", "one");
            set_mode(&path, expected);
            write_file(&path, "two", Some(&version(&path)), false).unwrap();
            assert_eq!(mode(&path), expected, "{expected:o}");
            assert_eq!(fs::read_to_string(&path).unwrap(), "two");
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_fifo_without_blocking() {
        use std::os::unix::ffi::OsStrExt;

        let dir = tempdir().unwrap();
        let path = dir.path().join("pipe");
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) }, 0);
        let error = write_file(&path, "x", None, true).unwrap_err();
        assert!(matches!(error, AppError::InvalidPath { .. }), "{error:?}");
    }
}

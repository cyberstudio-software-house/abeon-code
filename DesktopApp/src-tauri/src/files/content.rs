use std::fs::{File, Metadata};
use std::io::{ErrorKind, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

use base64::Engine;

use crate::domain::files::FileContent;
use crate::error::{AppError, AppResult};
use crate::files::{IMAGE_TYPES, MAX_IMAGE_BYTES, MAX_TEXT_BYTES, NOT_REGULAR_FILE};

pub fn file_version(path: &Path) -> AppResult<Option<String>> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(Some(version_of(&metadata)?)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn read_file(path: &Path) -> AppResult<FileContent> {
    let metadata = std::fs::metadata(path).map_err(|error| open_error(path, error))?;
    ensure_regular(path, &metadata)?;
    let file = File::open(path).map_err(|error| open_error(path, error))?;
    read_opened(path, file)
}

fn read_opened(path: &Path, mut file: File) -> AppResult<FileContent> {
    let metadata = file.metadata()?;
    ensure_regular(path, &metadata)?;
    let size = metadata.len();
    let version = version_of(&metadata)?;

    if let Some(mime) = image_mime(path) {
        if size > MAX_IMAGE_BYTES {
            return Ok(FileContent::TooLarge { version, size });
        }
        let bytes = read_limited(&mut file, MAX_IMAGE_BYTES)?;
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Ok(FileContent::TooLarge {
                version,
                size: bytes.len() as u64,
            });
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(FileContent::Image {
            data_url: format!("data:{mime};base64,{encoded}"),
            version,
            size,
        });
    }

    if size > MAX_TEXT_BYTES {
        return Ok(FileContent::TooLarge { version, size });
    }
    let bytes = read_limited(&mut file, MAX_TEXT_BYTES)?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Ok(FileContent::TooLarge {
            version,
            size: bytes.len() as u64,
        });
    }
    if bytes.contains(&0) {
        return Ok(FileContent::Binary { version, size });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileContent::Text {
            content,
            version,
            size,
        }),
        Err(_) => Ok(FileContent::Binary { version, size }),
    }
}

fn ensure_regular(path: &Path, metadata: &Metadata) -> AppResult<()> {
    if metadata.is_file() {
        return Ok(());
    }
    Err(AppError::InvalidPath {
        path: path.to_string_lossy().into_owned(),
        reason: NOT_REGULAR_FILE.to_string(),
    })
}

fn open_error(path: &Path, error: std::io::Error) -> AppError {
    match error.kind() {
        ErrorKind::NotFound => AppError::NotFound(path.to_string_lossy().into_owned()),
        _ => AppError::from(error),
    }
}

pub(crate) fn version_of(metadata: &Metadata) -> AppResult<String> {
    let nanos = match metadata.modified()?.duration_since(UNIX_EPOCH) {
        Ok(after) => after.as_nanos() as i128,
        Err(before) => -(before.duration().as_nanos() as i128),
    };
    Ok(format!("{nanos}-{}", metadata.len()))
}

fn read_limited(file: &mut File, limit: u64) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    IMAGE_TYPES
        .iter()
        .find(|(known, _)| *known == extension)
        .map(|(_, mime)| *mime)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use crate::files::MAX_TEXT_BYTES;
    use filetime::{set_file_mtime, FileTime};
    use tempfile::tempdir;

    fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn reads_text_exactly() {
        let dir = tempdir().unwrap();
        let raw = "\u{feff}a\r\nb";
        let path = write(dir.path(), "a.txt", raw.as_bytes());
        match read_file(&path).unwrap() {
            FileContent::Text {
                content,
                version,
                size,
            } => {
                assert_eq!(content, raw);
                assert_eq!(size, raw.len() as u64);
                assert_eq!(version, file_version(&path).unwrap().unwrap());
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    #[test]
    fn empty_file_is_text() {
        let dir = tempdir().unwrap();
        let path = write(dir.path(), "empty.txt", b"");
        match read_file(&path).unwrap() {
            FileContent::Text { content, size, .. } => {
                assert_eq!(content, "");
                assert_eq!(size, 0);
            }
            other => panic!("expected text, got {other:?}"),
        }
    }

    fn version(path: &Path) -> String {
        file_version(path).unwrap().unwrap()
    }

    #[test]
    fn nul_byte_is_binary() {
        let dir = tempdir().unwrap();
        let path = write(dir.path(), "a.bin", b"ab\0cd");
        assert_eq!(
            read_file(&path).unwrap(),
            FileContent::Binary {
                version: version(&path),
                size: 5
            }
        );
    }

    #[test]
    fn invalid_utf8_is_binary() {
        let dir = tempdir().unwrap();
        let path = write(dir.path(), "a.dat", &[0xff, 0xfe, 0xfd]);
        assert_eq!(
            read_file(&path).unwrap(),
            FileContent::Binary {
                version: version(&path),
                size: 3
            }
        );
    }

    #[test]
    fn over_limit_is_too_large() {
        let dir = tempdir().unwrap();
        let bytes = vec![b'a'; MAX_TEXT_BYTES as usize + 1];
        let path = write(dir.path(), "big.txt", &bytes);
        assert_eq!(
            read_file(&path).unwrap(),
            FileContent::TooLarge {
                version: version(&path),
                size: MAX_TEXT_BYTES + 1
            }
        );
    }

    #[test]
    fn exactly_at_limit_is_text() {
        let dir = tempdir().unwrap();
        let bytes = vec![b'a'; MAX_TEXT_BYTES as usize];
        let path = write(dir.path(), "edge.txt", &bytes);
        assert!(matches!(
            read_file(&path).unwrap(),
            FileContent::Text { .. }
        ));
    }

    #[test]
    fn png_is_image_data_url() {
        let dir = tempdir().unwrap();
        let path = write(dir.path(), "PHOTO.PNG", &[0x89, b'P', b'N', b'G']);
        match read_file(&path).unwrap() {
            FileContent::Image {
                data_url,
                version,
                size,
            } => {
                assert!(data_url.starts_with("data:image/png;base64,"));
                assert_eq!(size, 4);
                assert_eq!(version, file_version(&path).unwrap().unwrap());
            }
            other => panic!("expected image, got {other:?}"),
        }
    }

    #[test]
    fn svg_mime() {
        let dir = tempdir().unwrap();
        let path = write(dir.path(), "logo.svg", b"<svg/>");
        match read_file(&path).unwrap() {
            FileContent::Image { data_url, .. } => {
                assert!(data_url.starts_with("data:image/svg+xml;base64,"));
            }
            other => panic!("expected image, got {other:?}"),
        }
    }

    #[test]
    fn oversized_image_is_too_large() {
        let dir = tempdir().unwrap();
        let bytes = vec![0u8; crate::files::MAX_IMAGE_BYTES as usize + 1];
        let path = write(dir.path(), "huge.png", &bytes);
        assert_eq!(
            read_file(&path).unwrap(),
            FileContent::TooLarge {
                version: version(&path),
                size: crate::files::MAX_IMAGE_BYTES + 1
            }
        );
    }

    fn mime_of(name: &str) -> String {
        let dir = tempdir().unwrap();
        let path = write(dir.path(), name, &[1, 2, 3]);
        match read_file(&path).unwrap() {
            FileContent::Image { data_url, .. } => data_url
                .strip_prefix("data:")
                .and_then(|rest| rest.split_once(';'))
                .map(|(mime, _)| mime.to_string())
                .unwrap(),
            other => panic!("expected image for {name}, got {other:?}"),
        }
    }

    #[test]
    fn image_mime_types() {
        assert_eq!(mime_of("a.jpg"), "image/jpeg");
        assert_eq!(mime_of("a.JPEG"), "image/jpeg");
        assert_eq!(mime_of("a.gif"), "image/gif");
        assert_eq!(mime_of("a.webp"), "image/webp");
        assert_eq!(mime_of("a.png"), "image/png");
        assert_eq!(mime_of("a.svg"), "image/svg+xml");
    }

    #[test]
    fn every_listed_image_type_reads_as_its_mime() {
        for (extension, mime) in IMAGE_TYPES {
            assert_eq!(mime_of(&format!("a.{extension}")), *mime);
        }
    }

    #[test]
    fn pre_epoch_mtime_keeps_its_sign() {
        let dir = tempdir().unwrap();
        let path = write(dir.path(), "old.txt", b"one");
        set_file_mtime(&path, FileTime::from_unix_time(-1, 0)).unwrap();
        assert_eq!(version(&path), "-1000000000-3");
        set_file_mtime(&path, FileTime::from_unix_time(-2, 500_000_000)).unwrap();
        assert_eq!(version(&path), "-1500000000-3");
        set_file_mtime(&path, FileTime::from_unix_time(-3, 0)).unwrap();
        assert_ne!(version(&path), "-1500000000-3");
    }

    #[cfg(unix)]
    #[test]
    fn opened_handle_that_is_not_a_file_is_invalid_path() {
        let dir = tempdir().unwrap();
        let handle = File::open(dir.path()).unwrap();
        let error = read_opened(dir.path(), handle).unwrap_err();
        assert!(
            matches!(&error, AppError::InvalidPath { reason, .. } if reason == NOT_REGULAR_FILE),
            "{error:?}"
        );
    }

    #[test]
    fn version_changes_after_write() {
        let dir = tempdir().unwrap();
        let path = write(dir.path(), "a.txt", b"one");
        set_file_mtime(&path, FileTime::from_unix_time(1_700_000_000, 0)).unwrap();
        let before = file_version(&path).unwrap().unwrap();
        std::fs::write(&path, b"one!").unwrap();
        set_file_mtime(&path, FileTime::from_unix_time(1_700_000_100, 0)).unwrap();
        let after = file_version(&path).unwrap().unwrap();
        assert_ne!(before, after);
        assert_eq!(before, "1700000000000000000-3");
        assert_eq!(after, "1700000100000000000-4");
    }

    #[test]
    fn version_none_for_missing() {
        let dir = tempdir().unwrap();
        assert_eq!(file_version(&dir.path().join("nope.txt")).unwrap(), None);
    }

    #[test]
    fn directory_is_invalid_path() {
        let dir = tempdir().unwrap();
        let error = read_file(dir.path()).unwrap_err();
        assert!(matches!(error, AppError::InvalidPath { .. }), "{error:?}");
    }

    #[test]
    fn missing_file_is_not_found() {
        let dir = tempdir().unwrap();
        let error = read_file(&dir.path().join("nope.txt")).unwrap_err();
        assert!(matches!(error, AppError::NotFound(_)), "{error:?}");
    }

    #[cfg(unix)]
    #[test]
    fn fifo_is_invalid_path_without_blocking() {
        use std::os::unix::ffi::OsStrExt;

        let dir = tempdir().unwrap();
        let path = dir.path().join("pipe");
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o644) }, 0);
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(read_file(&path));
        });
        let error = receiver
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("reading a FIFO must not block")
            .unwrap_err();
        assert!(matches!(error, AppError::InvalidPath { .. }), "{error:?}");
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_file_is_io_error() {
        use std::os::unix::fs::PermissionsExt;

        if unsafe { libc::geteuid() } == 0 {
            return;
        }
        let dir = tempdir().unwrap();
        let path = write(dir.path(), "secret.txt", b"x");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
        let error = read_file(&path).unwrap_err();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(matches!(error, AppError::Io(_)), "{error:?}");
    }
}

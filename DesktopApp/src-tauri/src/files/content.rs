use std::fs::{File, Metadata};
use std::io::{ErrorKind, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

use base64::Engine;

use crate::domain::files::FileContent;
use crate::error::{AppError, AppResult};
use crate::files::{IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, MAX_TEXT_BYTES};

pub fn file_version(path: &Path) -> AppResult<Option<String>> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(Some(version_of(&metadata)?)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn read_file(path: &Path) -> AppResult<FileContent> {
    let display = path.to_string_lossy().into_owned();
    let not_found = |error: std::io::Error| match error.kind() {
        ErrorKind::NotFound => AppError::NotFound(display.clone()),
        _ => AppError::from(error),
    };
    if !std::fs::metadata(path).map_err(not_found)?.is_file() {
        return Err(AppError::InvalidPath {
            path: display,
            reason: "to nie jest zwykły plik".to_string(),
        });
    }
    let mut file = File::open(path).map_err(|error| match error.kind() {
        ErrorKind::NotFound => AppError::NotFound(display.clone()),
        _ => AppError::from(error),
    })?;
    let metadata = file.metadata()?;
    let size = metadata.len();
    let version = version_of(&metadata)?;

    if let Some(mime) = image_mime(path) {
        if size > MAX_IMAGE_BYTES {
            return Ok(FileContent::TooLarge { size });
        }
        let bytes = read_limited(&mut file, MAX_IMAGE_BYTES)?;
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Ok(FileContent::TooLarge {
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
        return Ok(FileContent::TooLarge { size });
    }
    let bytes = read_limited(&mut file, MAX_TEXT_BYTES)?;
    if bytes.len() as u64 > MAX_TEXT_BYTES {
        return Ok(FileContent::TooLarge {
            size: bytes.len() as u64,
        });
    }
    if bytes.contains(&0) {
        return Ok(FileContent::Binary { size });
    }
    match String::from_utf8(bytes) {
        Ok(content) => Ok(FileContent::Text {
            content,
            version,
            size,
        }),
        Err(_) => Ok(FileContent::Binary { size }),
    }
}

fn version_of(metadata: &Metadata) -> AppResult<String> {
    let nanos = metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    Ok(format!("{nanos}-{}", metadata.len()))
}

fn read_limited(file: &mut File, limit: u64) -> AppResult<Vec<u8>> {
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    Ok(bytes)
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_string_lossy().to_ascii_lowercase();
    if !IMAGE_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    Some(match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
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

    #[test]
    fn nul_byte_is_binary() {
        let dir = tempdir().unwrap();
        let path = write(dir.path(), "a.bin", b"ab\0cd");
        assert_eq!(read_file(&path).unwrap(), FileContent::Binary { size: 5 });
    }

    #[test]
    fn invalid_utf8_is_binary() {
        let dir = tempdir().unwrap();
        let path = write(dir.path(), "a.dat", &[0xff, 0xfe, 0xfd]);
        assert_eq!(read_file(&path).unwrap(), FileContent::Binary { size: 3 });
    }

    #[test]
    fn over_limit_is_too_large() {
        let dir = tempdir().unwrap();
        let bytes = vec![b'a'; MAX_TEXT_BYTES as usize + 1];
        let path = write(dir.path(), "big.txt", &bytes);
        assert_eq!(
            read_file(&path).unwrap(),
            FileContent::TooLarge {
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
                size: crate::files::MAX_IMAGE_BYTES + 1
            }
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
        let error = read_file(&path).unwrap_err();
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

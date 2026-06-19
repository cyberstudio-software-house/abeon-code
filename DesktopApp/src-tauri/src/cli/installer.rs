use std::path::{Path, PathBuf};
use crate::error::{AppError, AppResult};

pub fn wrapper_script(exe_path: &str) -> String {
    format!(
        r#"#!/usr/bin/env bash
set -euo pipefail
target="${{1:-.}}"
if [ -d "$target" ]; then
  abs="$(cd "$target" && pwd)"
else
  abs="$(cd "$(dirname -- "$target")" 2>/dev/null && pwd)/$(basename -- "$target")"
fi
exec "{exe_path}" "$abs"
"#
    )
}

pub fn install(exe_path: &str, target_dir: &Path) -> AppResult<PathBuf> {
    std::fs::create_dir_all(target_dir).map_err(|e| AppError::Other(e.to_string()))?;
    let dest = target_dir.join("abeon-code");
    std::fs::write(&dest, wrapper_script(exe_path)).map_err(|e| AppError::Other(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn script_contains_shebang_and_exe() {
        let s = wrapper_script("/opt/AbeonCode/abeoncode");
        assert!(s.starts_with("#!/usr/bin/env bash"));
        assert!(s.contains("/opt/AbeonCode/abeoncode"));
    }

    #[test]
    fn install_writes_executable_file() {
        let dir = tempdir().unwrap();
        let dest = install("/opt/AbeonCode/abeoncode", dir.path()).unwrap();
        assert_eq!(dest.file_name().unwrap().to_string_lossy(), "abeon-code");
        assert!(dest.exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&dest).unwrap().permissions().mode();
            assert_eq!(mode & 0o111, 0o111);
        }
    }
}

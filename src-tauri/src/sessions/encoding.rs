use std::path::Path;

/// Claude Code encodes project paths by replacing `/` with `-` in the directory name under `~/.claude/projects/`.
pub fn encode_project_path(path: &Path) -> String {
    let s = path.to_string_lossy();
    s.replace('/', "-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn encodes_absolute_path() {
        let p = PathBuf::from("/home/pszweda/projects/cyberstudio/AbeonCode");
        assert_eq!(encode_project_path(&p), "-home-pszweda-projects-cyberstudio-AbeonCode");
    }

    #[test]
    fn handles_root_path() {
        let p = PathBuf::from("/");
        assert_eq!(encode_project_path(&p), "-");
    }
}

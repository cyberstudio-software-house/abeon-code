use std::path::Path;

/// Claude Code encodes project paths into the directory name under `~/.claude/projects/`
/// by replacing every non-alphanumeric character with `-` (so `/`, `_`, `.`, spaces, etc.
/// all become `-`). The mapping is per-character — consecutive separators are NOT collapsed.
pub fn encode_project_path(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
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

    #[test]
    fn replaces_underscore_with_dash() {
        let p = PathBuf::from("/home/pszweda/projects/cyberstudio/geoglobe_matrix");
        assert_eq!(
            encode_project_path(&p),
            "-home-pszweda-projects-cyberstudio-geoglobe-matrix"
        );
    }

    #[test]
    fn replaces_dot_with_dash() {
        let p = PathBuf::from("/home/pszweda/projects/hafen.v2");
        assert_eq!(encode_project_path(&p), "-home-pszweda-projects-hafen-v2");
    }

    #[test]
    fn replaces_space_with_dash() {
        let p = PathBuf::from("/home/pszweda/my project");
        assert_eq!(encode_project_path(&p), "-home-pszweda-my-project");
    }
}

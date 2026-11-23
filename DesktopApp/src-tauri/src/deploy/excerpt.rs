use once_cell::sync::Lazy;
use regex::Regex;

const MAX_LINE_CHARS: usize = 400;
const SENSITIVE_WORDS: &str = "token|secret|password|passwd|key|auth|credential";
const MASK: &str = "***";

static ANSI: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]").unwrap()
});
static URL_USER_INFO: Lazy<Regex> = Lazy::new(|| Regex::new(r"(://)[^/\s@]+@").unwrap());
static BEARER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(bearer\s+)\S+").unwrap());
static ASSIGNMENT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r#"(?i)([A-Za-z0-9_.\-]*(?:{SENSITIVE_WORDS})[A-Za-z0-9_.\-]*["']?\s*=\s*)("[^"]*"|'[^']*'|\S+)"#
    ))
    .unwrap()
});
static COLON_ENTRY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r#"(?i)([A-Za-z0-9_.\-]*(?:{SENSITIVE_WORDS})[A-Za-z0-9_.\-]*["']?\s*:\s*)\S.*"#
    ))
    .unwrap()
});

fn redact_line(line: &str) -> String {
    let clean = ANSI.replace_all(line, "");
    let clean = URL_USER_INFO.replace_all(&clean, format!("${{1}}{MASK}@"));
    let clean = BEARER.replace_all(&clean, format!("${{1}}{MASK}"));
    let clean = ASSIGNMENT.replace_all(&clean, format!("${{1}}{MASK}"));
    let clean = COLON_ENTRY.replace_all(&clean, format!("${{1}}{MASK}"));
    clean.chars().take(MAX_LINE_CHARS).collect()
}

pub fn tail_redacted(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..]
        .iter()
        .map(|line| redact_line(line))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_log_tail_hides_secrets() {
        let out = tail_redacted(
            "a\nDOCKER_PASSWORD=hunter2\nAuthorization: Bearer abc.def\nhttps://u:p@host/x\nlast",
            4,
        );
        assert!(!out.contains("hunter2") && !out.contains("abc.def") && !out.contains("u:p@"));
        assert!(out.ends_with("last") && !out.starts_with("a\n"));
        assert!(out.contains("DOCKER_PASSWORD=***"));
        assert!(out.contains("https://***@host/x"));
    }

    #[test]
    fn keeps_only_the_requested_number_of_trailing_lines() {
        assert_eq!(tail_redacted("1\n2\n3\n4", 2), "3\n4");
        assert_eq!(tail_redacted("1\n2", 10), "1\n2");
        assert_eq!(tail_redacted("", 3), "");
    }

    #[test]
    fn strips_ansi_escapes() {
        assert_eq!(tail_redacted("\u{1b}[31mFAILED\u{1b}[0m step", 1), "FAILED step");
        assert_eq!(tail_redacted("\u{1b}]0;title\u{7}plain", 1), "plain");
    }

    #[test]
    fn masks_keys_case_insensitively_in_both_forms() {
        let out = tail_redacted(
            "api_Key: abc123\nGITHUB_TOKEN=\"quoted value\"\nclient-secret = s3cr3t\n\"password\": \"pw\"\nPasswd=x",
            5,
        );
        for leaked in ["abc123", "quoted value", "s3cr3t", "\"pw\"", "=x"] {
            assert!(!out.contains(leaked), "{leaked} leaked in {out}");
        }
        assert!(out.contains("api_Key: ***"));
        assert!(out.contains("GITHUB_TOKEN=***"));
    }

    #[test]
    fn leaves_ordinary_lines_untouched() {
        let line = "Step 3/7 : RUN npm ci --prefer-offline";
        assert_eq!(tail_redacted(line, 1), line);
    }

    #[test]
    fn masks_user_without_password_in_urls() {
        let out = tail_redacted("clone https://ghp_abcdef@github.com/o/r.git", 1);
        assert_eq!(out, "clone https://***@github.com/o/r.git");
    }

    #[test]
    fn caps_every_line_at_400_characters() {
        let long = "x".repeat(1000);
        let out = tail_redacted(&format!("{long}\nshort"), 2);
        let first = out.lines().next().unwrap();
        assert_eq!(first.chars().count(), 400);
        assert!(out.ends_with("short"));
    }

    #[test]
    fn counts_characters_not_bytes_when_capping() {
        let long = "ż".repeat(500);
        let out = tail_redacted(&long, 1);
        assert_eq!(out.chars().count(), 400);
    }
}

use once_cell::sync::Lazy;
use regex::{Captures, Regex};

const MAX_LINE_CHARS: usize = 400;
const SENSITIVE_WORDS: &str = "token|secret|password|passwd|key|auth|credential";
const MASK: &str = "***";
const PRIVATE_KEY_PLACEHOLDER: &str = "*** private key ***";

const KEY: &str = r"(?:[A-Za-z0-9_.\-]*(?:token|secret|password|passwd|key|auth|credential)[A-Za-z0-9_.\-]*|\b(?:[A-Za-z0-9]+[_.\-])*pat(?:[_.\-][A-Za-z0-9]+)*)";
const AFTER_KEY: &str = r#"(?:\\?["'\]])*\s*"#;
const QUOTED: &str = r#"\\?"[^"]*"|\\?'[^']*'"#;

static ANSI: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"\x1b\[[0-?]*[ -/]*[@-~]|\x{9b}[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()*+].|\x1b[@-Z\\-_]",
    )
    .unwrap()
});
static CONTROL: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\x00-\x08\x0b-\x1f\x7f\x{80}-\x{9f}]").unwrap());
static BARE_TOKEN: Lazy<Regex> = Lazy::new(|| {
    Regex::new(concat!(
        r"gh[pousr]_[A-Za-z0-9]{20,}",
        r"|github_pat_[A-Za-z0-9_]{20,}",
        r"|glpat-[A-Za-z0-9_\-]{16,}",
        r"|xox[abprs]-[A-Za-z0-9\-]{10,}",
        r"|AKIA[0-9A-Z]{16}",
        r"|eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+",
    ))
    .unwrap()
});
static URL_USER_INFO: Lazy<Regex> = Lazy::new(|| Regex::new(r"(://)[^/\s?#]*@").unwrap());
static BEARER: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\b(bearer\s+)\S+").unwrap());
static COOKIE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)\b((?:set-)?cookie\s*:\s*)\S.*").unwrap());
static LONG_FLAG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r#"(?i)(--[A-Za-z0-9\-]*(?:{SENSITIVE_WORDS})[A-Za-z0-9\-]*\s+)({QUOTED}|\S+)"#
    ))
    .unwrap()
});
static LOGIN_PASSWORD_FLAG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(r#"((?i:\blogin\b).*?\s-p\s+)({QUOTED}|\S+)"#)).unwrap()
});
static USER_FLAG: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r#"(\s(?:-u|--user|--proxy-user)(?:\s+|=))({QUOTED}|[^\s:]+:\S+)"#
    ))
    .unwrap()
});
static ASSIGNMENT: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(
        r#"(?i)({KEY}{AFTER_KEY}(?:=>|=)\s*)({QUOTED}|\S+)"#
    ))
    .unwrap()
});
static COLON_ENTRY: Lazy<Regex> = Lazy::new(|| {
    Regex::new(&format!(r#"(?i)({KEY}{AFTER_KEY}:\s*)({QUOTED}|\S.*)"#)).unwrap()
});

fn mask_value(captures: &Captures) -> String {
    format!("{}{MASK}", &captures[1])
}

fn sanitize(line: &str) -> String {
    let without_escapes = ANSI.replace_all(line, "");
    CONTROL.replace_all(&without_escapes, "").into_owned()
}

fn redact(line: &str) -> String {
    let mut text = BARE_TOKEN.replace_all(line, MASK).into_owned();
    text = URL_USER_INFO.replace_all(&text, format!("${{1}}{MASK}@")).into_owned();
    text = BEARER.replace_all(&text, mask_value).into_owned();
    text = COOKIE.replace_all(&text, mask_value).into_owned();
    text = LONG_FLAG
        .replace_all(&text, |captures: &Captures| {
            if captures[2].starts_with('-') {
                captures[0].to_string()
            } else {
                mask_value(captures)
            }
        })
        .into_owned();
    text = LOGIN_PASSWORD_FLAG.replace_all(&text, mask_value).into_owned();
    text = USER_FLAG.replace_all(&text, mask_value).into_owned();
    text = ASSIGNMENT.replace_all(&text, mask_value).into_owned();
    COLON_ENTRY.replace_all(&text, mask_value).into_owned()
}

pub(crate) fn redact_line(line: &str) -> String {
    redact(&sanitize(line)).chars().take(MAX_LINE_CHARS).collect()
}

enum Piece<'a> {
    Line(&'a str),
    PrivateKey,
}

fn pieces(text: &str) -> Vec<Piece<'_>> {
    let mut out = Vec::new();
    let mut inside_key = false;
    for line in text.lines() {
        if inside_key {
            inside_key = !line.contains("-----END");
            continue;
        }
        if line.contains("-----BEGIN") && line.contains("PRIVATE KEY") {
            inside_key = !line.contains("-----END");
            out.push(Piece::PrivateKey);
            continue;
        }
        out.push(Piece::Line(line));
    }
    out
}

pub fn tail_redacted(text: &str, lines: usize) -> String {
    let all = pieces(text);
    let start = all.len().saturating_sub(lines);
    all[start..]
        .iter()
        .map(|piece| match piece {
            Piece::Line(line) => redact_line(line),
            Piece::PrivateKey => PRIVATE_KEY_PLACEHOLDER.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_hidden(input: &str, secrets: &[&str]) -> String {
        let out = tail_redacted(input, 20);
        for secret in secrets {
            assert!(!out.contains(secret), "{secret} leaked in {out}");
        }
        out
    }

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
    fn strips_private_and_colon_separated_csi_sequences() {
        assert_eq!(tail_redacted("\u{1b}[>4;2mX", 1), "X");
        assert_eq!(tail_redacted("\u{1b}[?25lY", 1), "Y");
        assert_eq!(tail_redacted("\u{1b}[38:5:196mred\u{1b}[0m", 1), "red");
        assert_eq!(tail_redacted("\u{9b}31mQ", 1), "Q");
    }

    #[test]
    fn strips_charset_designators() {
        assert_eq!(tail_redacted("\u{1b}(Bplain\u{1b})0 text", 1), "plain text");
    }

    #[test]
    fn removes_remaining_control_characters() {
        let out = tail_redacted("a\rb\u{1b}c\u{7}d\u{0}e\u{7f}f\u{85}g\u{9f}h\ti", 1);
        assert_eq!(out, "abcdefgh\ti");
        let noisy: String = (0u32..0xa0).filter_map(char::from_u32).filter(|c| *c != '\n').collect();
        let out = tail_redacted(&noisy, 1);
        assert!(out.chars().all(|c| !c.is_control() || c == '\t'), "{out:?}");
    }

    #[test]
    fn masks_keys_case_insensitively_in_both_forms() {
        let out = assert_hidden(
            "api_Key: abc123\nGITHUB_TOKEN=\"quoted value\"\nclient-secret = s3cr3t\n\"password\": \"pw\"\nPasswd=x",
            &["abc123", "quoted value", "s3cr3t", "\"pw\"", "=x"],
        );
        assert!(out.contains("api_Key: ***"));
        assert!(out.contains("GITHUB_TOKEN=***"));
    }

    #[test]
    fn masks_escaped_json() {
        let out = assert_hidden(
            r#"payload {\"username\":\"bob\",\"password\":\"hunter2\"}"#,
            &["hunter2"],
        );
        assert!(out.contains("bob"));
    }

    #[test]
    fn masks_plain_json() {
        assert_hidden(r#"{"username":"bob","password":"hunter2"}"#, &["hunter2"]);
    }

    #[test]
    fn masks_arrow_assignments() {
        assert_hidden("'password' => 'hunter2',", &["hunter2"]);
        assert_hidden("\"api_key\" => \"hunter2\"", &["hunter2"]);
        assert_hidden(":secret => 'hunter2'", &["hunter2"]);
    }

    #[test]
    fn masks_print_r_entries() {
        let out = assert_hidden("    [password] => hunter2\n    [user] => bob", &["hunter2"]);
        assert!(out.contains("[user] => bob"));
    }

    #[test]
    fn leaves_ordinary_lines_untouched() {
        for line in [
            "Step 3/7 : RUN npm ci --prefer-offline",
            "docker run -p 8080:80 nginx",
            "PATH=/usr/bin:/bin",
            "cpath=/x",
            "curl -u bob https://example.com",
        ] {
            assert_eq!(tail_redacted(line, 1), line);
        }
    }

    #[test]
    fn masks_user_without_password_in_urls() {
        let out = tail_redacted("clone https://ghp_abcdef@github.com/o/r.git", 1);
        assert_eq!(out, "clone https://***@github.com/o/r.git");
    }

    #[test]
    fn user_info_ends_at_the_last_at_sign_of_the_authority() {
        let out = assert_hidden("fetch https://user:p@ss@host/path", &["ss@host", "p@ss"]);
        assert_eq!(out, "fetch https://***@host/path");
        assert_eq!(
            tail_redacted("https://host/path/a@b", 1),
            "https://host/path/a@b"
        );
    }

    #[test]
    fn masks_flag_pair_secrets() {
        assert_hidden("docker login -u bob -p hunter2 registry.example.com", &["hunter2"]);
        assert_hidden("tool --password hunter2 --verbose", &["hunter2"]);
        assert_hidden("cli --token hunter2 run", &["hunter2"]);
        assert_hidden("cli --api-key=hunter2 run", &["hunter2"]);
        assert_hidden("curl -u bob:hunter2 https://example.com", &["hunter2"]);
        assert_hidden("curl --user bob:hunter2 https://example.com", &["hunter2"]);
        assert_hidden("docker login -p \"hunter 2\"", &["hunter 2", "hunter"]);
    }

    #[test]
    fn a_flag_followed_by_another_flag_is_kept() {
        let out = tail_redacted("docker login --password-stdin --username bob", 1);
        assert!(out.contains("--username bob"), "{out}");
    }

    #[test]
    fn treats_pat_as_a_key_word() {
        let out = assert_hidden("export GH_PAT=hunter2\npat: hunter3\nmy-pat=hunter4", &["hunter2", "hunter3", "hunter4"]);
        assert!(out.contains("export GH_PAT=***"));
    }

    #[test]
    fn masks_well_known_token_formats_anywhere() {
        let secrets = [
            "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "gho_abcdefghijklmnopqrstuvwxyz0123456789",
            "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
            "glpat-abcdefghijklmnopqrst",
            "xoxb-123456789012-abcdefABCDEF",
            "AKIAIOSFODNN7EXAMPLE",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl",
        ];
        for secret in secrets {
            let out = assert_hidden(&format!("pushing with {secret} now"), &[secret]);
            assert_eq!(out, "pushing with *** now");
        }
    }

    #[test]
    fn drops_private_key_bodies() {
        let text = "before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----\nafter";
        let out = assert_hidden(text, &["b3BlbnNz", "AAAABG5v", "OPENSSH"]);
        assert_eq!(out, "before\n*** private key ***\nafter");
    }

    #[test]
    fn an_unterminated_private_key_hides_the_rest() {
        let out = assert_hidden(
            "start\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
            &["MIIEvQ"],
        );
        assert_eq!(out, "start\n*** private key ***");
    }

    #[test]
    fn private_key_lines_do_not_use_up_the_tail_window() {
        let text = "one\ntwo\n-----BEGIN PRIVATE KEY-----\nAAAA\nBBBB\nCCCC\n-----END PRIVATE KEY-----\nthree";
        assert_eq!(tail_redacted(text, 3), "two\n*** private key ***\nthree");
    }

    #[test]
    fn masks_cookie_headers() {
        let out = assert_hidden(
            "Cookie: session=abc123; theme=dark\nSet-Cookie: sid=xyz789; Path=/; HttpOnly",
            &["abc123", "theme=dark", "xyz789"],
        );
        assert!(out.contains("Cookie: ***"));
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

    #[test]
    fn redact_line_applies_every_rule_and_the_cap() {
        let line = format!("\u{1b}[31mfatal: token=hunter2 {}", "y".repeat(600));
        let out = redact_line(&line);
        assert!(!out.contains("hunter2") && !out.contains('\u{1b}'));
        assert_eq!(out.chars().count(), 400);
    }
}

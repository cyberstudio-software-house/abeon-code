use std::path::Path;

const SCHEME: &str = "abeon-code://";

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn deep_link_path(raw: &str) -> Option<String> {
    let rest = raw.strip_prefix(SCHEME)?;
    let query = rest.split_once('?').map(|(_, q)| q).unwrap_or("");
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == "path" {
                let decoded = percent_decode(v);
                if decoded.is_empty() {
                    return None;
                }
                return Some(decoded);
            }
        }
    }
    None
}

fn looks_like_path(raw: &str) -> bool {
    !raw.starts_with('-')
}

fn expand_tilde(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().to_string();
        }
    }
    raw.to_string()
}

pub fn parse_open_input(raw: &str, base_cwd: Option<&str>) -> Option<String> {
    let candidate = if raw.starts_with(SCHEME) {
        deep_link_path(raw)?
    } else if looks_like_path(raw) {
        expand_tilde(raw)
    } else {
        return None;
    };

    let p = Path::new(&candidate);
    let abs = if p.is_absolute() {
        p.to_path_buf()
    } else if let Some(cwd) = base_cwd {
        Path::new(cwd).join(p)
    } else {
        p.to_path_buf()
    };
    Some(abs.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_path_passthrough() {
        assert_eq!(parse_open_input("/home/u/proj", None).as_deref(), Some("/home/u/proj"));
    }

    #[test]
    fn relative_path_joins_cwd() {
        assert_eq!(
            parse_open_input("proj", Some("/work")).as_deref(),
            Some("/work/proj"),
        );
    }

    #[test]
    fn dot_joins_cwd() {
        assert_eq!(parse_open_input(".", Some("/work")).as_deref(), Some("/work/."));
    }

    #[test]
    fn deep_link_decodes_path() {
        assert_eq!(
            parse_open_input("abeon-code://open?path=%2Fhome%2Fu%2Fmy%20proj", None).as_deref(),
            Some("/home/u/my proj"),
        );
    }

    #[test]
    fn non_path_is_ignored() {
        assert_eq!(parse_open_input("-psn_0_123", None), None);
        assert_eq!(parse_open_input("--flag", None), None);
    }
}

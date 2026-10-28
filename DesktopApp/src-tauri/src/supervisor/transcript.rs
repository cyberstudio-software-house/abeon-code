use crate::domain::session::HistoryBlock;

const RESULT_CHARS: usize = 300;

fn render_block(block: &HistoryBlock) -> Option<String> {
    match block {
        HistoryBlock::UserText { text, .. } => Some(format!("UŻYTKOWNIK: {text}")),
        HistoryBlock::AssistantText { text, .. } => Some(format!("ASYSTENT: {text}")),
        HistoryBlock::ToolUse {
            name,
            input_summary,
            ..
        } => Some(format!("NARZĘDZIE {name}: {input_summary}")),
        HistoryBlock::ToolResult { content, .. } => {
            let head: String = content.chars().take(RESULT_CHARS).collect();
            Some(format!("WYNIK: {head}"))
        }
        _ => None,
    }
}

pub fn render(blocks: &[HistoryBlock], max_blocks: usize, max_chars: usize) -> String {
    let header = blocks.iter().find_map(|block| match block {
        HistoryBlock::UserText { text, .. } => Some(format!("PIERWSZE POLECENIE:\n{text}")),
        _ => None,
    });

    let rendered: Vec<String> = blocks.iter().filter_map(render_block).collect();
    let start = rendered.len().saturating_sub(max_blocks);
    let mut tail = rendered[start..].join("\n");

    let separator = if header.is_some() { "\n\n" } else { "" };
    let header_len = header.as_deref().map_or(0, |h| h.chars().count()) + separator.len();
    let budget = max_chars.saturating_sub(header_len);
    let tail_len = tail.chars().count();
    if tail_len > budget {
        let skip = tail_len - budget;
        let cut = tail
            .char_indices()
            .nth(skip)
            .map_or(tail.len(), |(index, _)| index);
        tail = tail[cut..].to_string();
    }

    match header {
        Some(header) if tail.is_empty() => header,
        Some(header) => format!("{header}{separator}{tail}"),
        None => tail,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(text: &str) -> HistoryBlock {
        HistoryBlock::UserText {
            uuid: "u".into(),
            timestamp: 0,
            text: text.into(),
        }
    }

    fn assistant(text: &str) -> HistoryBlock {
        HistoryBlock::AssistantText {
            uuid: "a".into(),
            timestamp: 0,
            text: text.into(),
        }
    }

    fn tool_use(name: &str, summary: &str) -> HistoryBlock {
        HistoryBlock::ToolUse {
            uuid: "t".into(),
            timestamp: 0,
            name: name.into(),
            input_summary: summary.into(),
            raw_input: json!({}),
        }
    }

    fn tool_result(content: &str) -> HistoryBlock {
        HistoryBlock::ToolResult {
            uuid: "r".into(),
            timestamp: 0,
            content: content.into(),
            is_error: false,
        }
    }

    #[test]
    fn render_keeps_first_prompt_and_tail() {
        let blocks = vec![
            user("zrób refaktoryzację"),
            assistant("ok"),
            HistoryBlock::AssistantThinking {
                uuid: "k".into(),
                timestamp: 0,
                text: "hmm".into(),
            },
            tool_use("Read", "src/a.rs"),
            HistoryBlock::Attachment {
                uuid: "x".into(),
                timestamp: 0,
                attachment_kind: "file".into(),
                name: "a.png".into(),
            },
            assistant("gotowe"),
        ];
        let out = render(&blocks, 2, 10_000);
        assert_eq!(
            out,
            "PIERWSZE POLECENIE:\nzrób refaktoryzację\n\nNARZĘDZIE Read: src/a.rs\nASYSTENT: gotowe"
        );
        assert!(!out.contains("hmm"));
        assert!(!out.contains("a.png"));
    }

    #[test]
    fn render_prefixes_each_block_kind() {
        let blocks = vec![
            user("start"),
            assistant("a"),
            user("dalej"),
            tool_result("wynik"),
        ];
        let out = render(&blocks, 10, 10_000);
        assert!(out.contains("UŻYTKOWNIK: dalej"));
        assert!(out.contains("ASYSTENT: a"));
        assert!(out.contains("WYNIK: wynik"));
    }

    #[test]
    fn render_truncates_tool_results() {
        let long = "ą".repeat(500);
        let out = render(&[tool_result(&long)], 10, 10_000);
        assert_eq!(out, format!("WYNIK: {}", "ą".repeat(300)));
    }

    #[test]
    fn render_truncates_front_but_keeps_header_on_char_boundary() {
        let blocks = vec![
            user("pierwsze"),
            assistant(&"żółć".repeat(100)),
            assistant("koniec"),
        ];
        let out = render(&blocks, 10, 60);
        assert!(out.starts_with("PIERWSZE POLECENIE:\npierwsze"));
        assert!(out.ends_with("ASYSTENT: koniec"));
        assert!(out.chars().count() <= 60);
    }

    #[test]
    fn render_without_user_text_omits_header() {
        let out = render(&[assistant("hej")], 10, 1000);
        assert_eq!(out, "ASYSTENT: hej");
    }

    #[test]
    fn render_keeps_header_when_budget_is_tiny() {
        let out = render(&[user("polecenie"), assistant("długa odpowiedź")], 10, 5);
        assert_eq!(out, "PIERWSZE POLECENIE:\npolecenie");
    }
}

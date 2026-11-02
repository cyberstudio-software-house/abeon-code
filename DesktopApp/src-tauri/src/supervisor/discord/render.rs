use serde_json::{json, Value};

const PALETTE: [u32; 6] = [0x5865F2, 0x3BA55C, 0xFAA61A, 0xEB459E, 0x00A8FC, 0xED4245];
const COMPONENTS_FLAG: u64 = 1 << 15;
const MAX_COMPONENTS: usize = 40;
const MAX_TEXT_LENGTH: usize = 4000;
const ANSWER_PREVIEW_LENGTH: usize = 40;
const SAMPLE_KEYS: usize = 3;
const LABEL_SEPARATOR: &str = " · ";

pub const STALE_TEXT: &str = "⌛ Nieaktualne — odpowiedz tekstem";

#[derive(Clone, Debug, PartialEq)]
pub enum ItemState {
    Open,
    Clicked(String),
    Answered(String),
    Settled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalMark {
    Pending,
    Approved,
    Rejected,
    Expired,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ItemView {
    pub item_id: String,
    pub key: String,
    pub question: String,
    pub context: Option<String>,
    pub options: Vec<String>,
    pub text_options: Vec<String>,
    pub state: ItemState,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ApprovalRow {
    pub approval_id: String,
    pub action: String,
    pub code: String,
    pub mark: ApprovalMark,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BlockView {
    pub label: String,
    pub continued: bool,
    pub items: Vec<ItemView>,
    pub approvals: Vec<ApprovalRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MessageView {
    pub header: Option<String>,
    pub blocks: Vec<BlockView>,
    pub footer: Option<String>,
}

fn plain(text: &str) -> String {
    text.replace('`', "'")
}

fn text_display(content: impl Into<String>) -> Value {
    json!({"type": 10, "content": content.into()})
}

pub fn project_and_title(label: &str) -> (String, Option<String>) {
    match label.split_once(LABEL_SEPARATOR) {
        Some((project, title)) => (project.to_string(), Some(title.to_string())),
        None => (label.to_string(), None),
    }
}

pub fn accent(project: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for byte in project.bytes() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(0x01000193);
    }
    PALETTE[(hash % PALETTE.len() as u32) as usize]
}

fn approvals_part(count: usize) -> String {
    match count {
        1 => "zgoda".to_string(),
        2..=4 => format!("{count} zgody"),
        _ => format!("{count} zgód"),
    }
}

pub fn header(blocks: &[BlockView]) -> String {
    let mut projects: Vec<(String, usize, usize)> = Vec::new();
    for block in blocks {
        let (project, _) = project_and_title(&block.label);
        match projects.iter_mut().find(|entry| entry.0 == project) {
            Some(entry) => {
                entry.1 += block.items.len();
                entry.2 += block.approvals.len();
            }
            None => projects.push((project, block.items.len(), block.approvals.len())),
        }
    }
    let summaries: Vec<String> = projects
        .iter()
        .map(|(project, questions, approvals)| {
            let mut parts = Vec::new();
            if *questions > 0 {
                parts.push(questions.to_string());
            }
            if *approvals > 0 {
                parts.push(approvals_part(*approvals));
            }
            if parts.is_empty() {
                parts.push("0".to_string());
            }
            format!("{project} ({})", parts.join(" + "))
        })
        .collect();
    format!("**🧭 Do decyzji: {}**", summaries.join(LABEL_SEPARATOR))
}

pub fn footer(blocks: &[BlockView]) -> Option<String> {
    let samples: Vec<String> = blocks
        .iter()
        .flat_map(|block| block.items.iter())
        .filter_map(|item| {
            item.options
                .first()
                .map(|option| format!("{} {}", item.key, plain(option)))
        })
        .take(SAMPLE_KEYS)
        .collect();
    if samples.is_empty() {
        None
    } else {
        Some(format!(
            "-# Możesz też odpisać tekstem, np. `{}`",
            samples.join(", ")
        ))
    }
}

fn shorten(value: &str) -> String {
    if value.chars().count() > ANSWER_PREVIEW_LENGTH {
        let head: String = value.chars().take(ANSWER_PREVIEW_LENGTH).collect();
        format!("{head}…")
    } else {
        value.to_string()
    }
}

fn item_text(item: &ItemView) -> String {
    let mut content = format!("**{}** {}", item.key, plain(&item.question));
    if !item.text_options.is_empty() {
        let hints: Vec<String> = item
            .text_options
            .iter()
            .map(|option| format!("`{} {}: …`", item.key, plain(option)))
            .collect();
        content.push_str("\n-# albo odpisz ");
        content.push_str(&hints.join(LABEL_SEPARATOR));
    }
    if let Some(context) = &item.context {
        content.push_str("\n-# ");
        content.push_str(&plain(context));
    }
    content
}

fn state_text(item: &ItemView) -> Option<String> {
    match &item.state {
        ItemState::Open => None,
        ItemState::Clicked(value) => Some(format!("✅ {}: {}", item.key, plain(value))),
        ItemState::Answered(value) => Some(format!("✅ {}: {}", item.key, shorten(&plain(value)))),
        ItemState::Settled => Some(format!("✅ {}: rozstrzygnięte", item.key)),
    }
}

fn option_row(item: &ItemView) -> Value {
    let buttons: Vec<Value> = item
        .options
        .iter()
        .enumerate()
        .map(|(index, option)| {
            json!({
                "type": 2,
                "style": 2,
                "label": plain(option),
                "custom_id": format!("abeon:q:{}:{}", item.item_id, index),
            })
        })
        .collect();
    json!({"type": 1, "components": buttons})
}

fn approval_row(approval: &ApprovalRow) -> Value {
    json!({"type": 1, "components": [
        {
            "type": 2,
            "style": 3,
            "label": "Zatwierdź",
            "emoji": {"name": "✅"},
            "custom_id": format!("abeon:a:{}:y", approval.approval_id),
        },
        {
            "type": 2,
            "style": 4,
            "label": "Odrzuć",
            "emoji": {"name": "❌"},
            "custom_id": format!("abeon:a:{}:n", approval.approval_id),
        },
    ]})
}

fn mark_text(mark: ApprovalMark) -> Option<&'static str> {
    match mark {
        ApprovalMark::Pending => None,
        ApprovalMark::Approved => Some("✅ Zatwierdzono"),
        ApprovalMark::Rejected => Some("❌ Odrzucono"),
        ApprovalMark::Expired => Some("⌛ Wygasło"),
    }
}

fn render_block(block: &BlockView) -> Value {
    let (project, title) = project_and_title(&block.label);
    let mut heading = format!("**📁 {project}**");
    if let Some(title) = &title {
        heading.push_str(&format!(" — {title}"));
    }
    if block.continued {
        heading.push_str(" (cd.)");
    }
    let mut inner = vec![text_display(heading)];
    for item in &block.items {
        inner.push(text_display(item_text(item)));
        match state_text(item) {
            Some(text) => inner.push(text_display(text)),
            None if !item.options.is_empty() => inner.push(option_row(item)),
            None => {}
        }
    }
    for approval in &block.approvals {
        inner.push(text_display(format!(
            "🔒 **Zgoda:** `{}` · kod `{}`",
            plain(&approval.action),
            approval.code
        )));
        match mark_text(approval.mark) {
            Some(text) => inner.push(text_display(text)),
            None => inner.push(approval_row(approval)),
        }
    }
    json!({"type": 17, "accent_color": accent(&project), "components": inner})
}

pub fn render(view: &MessageView) -> Value {
    let mut components = Vec::new();
    if let Some(header) = &view.header {
        components.push(text_display(header.clone()));
    }
    for block in &view.blocks {
        components.push(render_block(block));
    }
    if let Some(footer) = &view.footer {
        components.push(text_display(footer.clone()));
    }
    v2_payload(Value::Array(components))
}

pub fn v2_payload(components: Value) -> Value {
    json!({
        "flags": COMPONENTS_FLAG,
        "allowed_mentions": {"parse": []},
        "components": components,
    })
}

pub fn component_count(components: &Value) -> usize {
    match components {
        Value::Array(list) => list.iter().map(component_count).sum(),
        Value::Object(map) => 1 + map.get("components").map_or(0, component_count),
        _ => 0,
    }
}

pub fn text_length(components: &Value) -> usize {
    match components {
        Value::Array(list) => list.iter().map(text_length).sum(),
        Value::Object(map) => {
            let own = if map.get("type") == Some(&json!(10)) {
                map.get("content")
                    .and_then(Value::as_str)
                    .map_or(0, |content| content.chars().count())
            } else {
                0
            };
            own + map.get("components").map_or(0, text_length)
        }
        _ => 0,
    }
}

pub fn replace_row(components: &Value, custom_id: &str, text: &str) -> Value {
    match components {
        Value::Array(list) => Value::Array(
            list.iter()
                .map(|entry| replace_row(entry, custom_id, text))
                .collect(),
        ),
        Value::Object(map) => {
            let is_row = map.get("type") == Some(&json!(1));
            let holds_button =
                map.get("components")
                    .and_then(Value::as_array)
                    .is_some_and(|buttons| {
                        buttons.iter().any(|button| {
                            button.get("custom_id").and_then(Value::as_str) == Some(custom_id)
                        })
                    });
            if is_row && holds_button {
                return text_display(text);
            }
            let mut copy = map.clone();
            if let Some(children) = map.get("components") {
                copy.insert(
                    "components".to_string(),
                    replace_row(children, custom_id, text),
                );
            }
            Value::Object(copy)
        }
        other => other.clone(),
    }
}

fn within_limits(view: &MessageView) -> bool {
    let json = render(view);
    component_count(&json["components"]) <= MAX_COMPONENTS
        && text_length(&json["components"]) <= MAX_TEXT_LENGTH
}

fn entry_count(block: &BlockView) -> usize {
    block.items.len() + block.approvals.len()
}

fn slice_block(block: &BlockView, start: usize, end: usize, continued: bool) -> BlockView {
    let item_total = block.items.len();
    BlockView {
        label: block.label.clone(),
        continued,
        items: block.items[start.min(item_total)..end.min(item_total)].to_vec(),
        approvals: block.approvals
            [start.saturating_sub(item_total)..end.saturating_sub(item_total)]
            .to_vec(),
    }
}

pub fn split(
    blocks: Vec<BlockView>,
    header: Option<String>,
    footer: Option<String>,
) -> Vec<MessageView> {
    let fits = |index: usize, candidate: &[BlockView]| {
        within_limits(&MessageView {
            header: if index == 0 { header.clone() } else { None },
            blocks: candidate.to_vec(),
            footer: footer.clone(),
        })
    };
    let mut finished: Vec<Vec<BlockView>> = Vec::new();
    let mut current: Vec<BlockView> = Vec::new();

    for block in blocks {
        let mut with_block = current.clone();
        with_block.push(block.clone());
        if fits(finished.len(), &with_block) {
            current = with_block;
            continue;
        }
        if !current.is_empty() && fits(finished.len() + 1, std::slice::from_ref(&block)) {
            finished.push(std::mem::take(&mut current));
            current.push(block);
            continue;
        }
        let total = entry_count(&block);
        if total == 0 {
            current.push(block);
            continue;
        }
        let mut start = 0;
        while start < total {
            let mut end = start;
            for candidate_end in (start + 1)..=total {
                let mut candidate = current.clone();
                candidate.push(slice_block(
                    &block,
                    start,
                    candidate_end,
                    block.continued || start > 0,
                ));
                if fits(finished.len(), &candidate) {
                    end = candidate_end;
                } else {
                    break;
                }
            }
            if end == start {
                if current.is_empty() {
                    end = start + 1;
                } else {
                    finished.push(std::mem::take(&mut current));
                    continue;
                }
            }
            current.push(slice_block(
                &block,
                start,
                end,
                block.continued || start > 0,
            ));
            start = end;
            if start < total {
                finished.push(std::mem::take(&mut current));
            }
        }
    }
    if !current.is_empty() {
        finished.push(current);
    }

    let last = finished.len().saturating_sub(1);
    finished
        .into_iter()
        .enumerate()
        .map(|(index, blocks)| MessageView {
            header: if index == 0 { header.clone() } else { None },
            blocks,
            footer: if index == last { footer.clone() } else { None },
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(item_id: &str, key: &str, options: &[&str]) -> ItemView {
        ItemView {
            item_id: item_id.into(),
            key: key.into(),
            question: format!("Pytanie {key}?"),
            context: None,
            options: options.iter().map(|o| o.to_string()).collect(),
            text_options: vec![],
            state: ItemState::Open,
        }
    }

    fn approval(id: &str, mark: ApprovalMark) -> ApprovalRow {
        ApprovalRow {
            approval_id: id.into(),
            action: "git push → master".into(),
            code: "K7QX".into(),
            mark,
        }
    }

    fn block(label: &str, items: Vec<ItemView>, approvals: Vec<ApprovalRow>) -> BlockView {
        BlockView {
            label: label.into(),
            continued: false,
            items,
            approvals,
        }
    }

    fn view_of(blocks: Vec<BlockView>) -> MessageView {
        MessageView {
            header: None,
            blocks,
            footer: None,
        }
    }

    fn texts(value: &Value) -> Vec<String> {
        let mut out = Vec::new();
        collect_texts(value, &mut out);
        out
    }

    fn collect_texts(value: &Value, out: &mut Vec<String>) {
        match value {
            Value::Array(list) => list.iter().for_each(|v| collect_texts(v, out)),
            Value::Object(map) => {
                if map.get("type") == Some(&json!(10)) {
                    out.push(map["content"].as_str().unwrap().to_string());
                }
                if let Some(children) = map.get("components") {
                    collect_texts(children, out);
                }
            }
            _ => {}
        }
    }

    fn rows(value: &Value) -> usize {
        match value {
            Value::Array(list) => list.iter().map(rows).sum(),
            Value::Object(map) => {
                let own = usize::from(map.get("type") == Some(&json!(1)));
                own + map.get("components").map(rows).unwrap_or(0)
            }
            _ => 0,
        }
    }

    fn fits(message: &MessageView) -> bool {
        let json = render(message);
        component_count(&json["components"]) <= 40 && text_length(&json["components"]) <= 4000
    }

    #[test]
    fn header_counts_questions_and_approvals_per_project() {
        let blocks = vec![
            block(
                "zargood · A",
                vec![item("i1", "S1", &["tak"]), item("i2", "S2", &[])],
                vec![],
            ),
            block("zargood · B", vec![item("i3", "S3", &[])], vec![]),
            block(
                "therappio · C",
                vec![item("i4", "S4", &[])],
                vec![approval("a1", ApprovalMark::Pending)],
            ),
        ];
        assert_eq!(
            header(&blocks),
            "**🧭 Do decyzji: zargood (3) · therappio (1 + zgoda)**"
        );
    }

    #[test]
    fn header_uses_polish_plurals_for_approvals() {
        let with = |n: usize| {
            let approvals = (0..n)
                .map(|i| approval(&format!("a{i}"), ApprovalMark::Pending))
                .collect();
            vec![block("p · t", vec![], approvals)]
        };
        assert_eq!(header(&with(3)), "**🧭 Do decyzji: p (3 zgody)**");
        assert_eq!(header(&with(5)), "**🧭 Do decyzji: p (5 zgód)**");
        assert_eq!(header(&with(1)), "**🧭 Do decyzji: p (zgoda)**");
        assert_eq!(header(&with(2)), "**🧭 Do decyzji: p (2 zgody)**");
    }

    #[test]
    fn render_puts_buttons_under_their_question() {
        let view = view_of(vec![block(
            "zargood · Refaktor",
            vec![item("i1", "S1", &["tak", "nie"])],
            vec![],
        )]);
        let json = render(&view);
        assert_eq!(json["flags"], 32768);
        assert_eq!(json["allowed_mentions"], json!({"parse": []}));
        assert!(json.get("content").is_none());
        let container = &json["components"][0];
        assert_eq!(container["type"], 17);
        assert_eq!(container["accent_color"], accent("zargood"));
        let inner = container["components"].as_array().unwrap();
        assert_eq!(inner.len(), 3);
        assert_eq!(
            inner[0],
            json!({"type": 10, "content": "**📁 zargood** — Refaktor"})
        );
        assert_eq!(inner[1]["content"], "**S1** Pytanie S1?");
        assert_eq!(inner[2]["type"], 1);
        let buttons = inner[2]["components"].as_array().unwrap();
        let ids: Vec<&str> = buttons
            .iter()
            .map(|b| b["custom_id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["abeon:q:i1:0", "abeon:q:i1:1"]);
        assert_eq!(buttons[0]["type"], 2);
        assert_eq!(buttons[0]["style"], 2);
        assert_eq!(buttons[0]["label"], "tak");
    }

    #[test]
    fn v2_payload_wraps_components_without_mentions() {
        let components = json!([{"type": 10, "content": "x"}]);
        assert_eq!(
            v2_payload(components.clone()),
            json!({
                "flags": 32768,
                "allowed_mentions": {"parse": []},
                "components": components,
            })
        );
    }

    #[test]
    fn render_adds_header_and_footer_around_containers() {
        let view = MessageView {
            header: Some("H".into()),
            blocks: vec![block("p · t", vec![], vec![])],
            footer: Some("F".into()),
        };
        let json = render(&view);
        let list = json["components"].as_array().unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[0], json!({"type": 10, "content": "H"}));
        assert_eq!(list[1]["type"], 17);
        assert_eq!(list[2], json!({"type": 10, "content": "F"}));
    }

    #[test]
    fn render_shows_text_options_and_context_as_small_text() {
        let mut entry = item("i1", "S1", &[]);
        entry.question = "Akceptujesz?".into();
        entry.text_options = vec!["uwagi".into()];
        entry.context = Some("Sesja przyjęła założenia.".into());
        let json = render(&view_of(vec![block("p · t", vec![entry], vec![])]));
        assert_eq!(
            json["components"][0]["components"][1]["content"],
            "**S1** Akceptujesz?\n-# albo odpisz `S1 uwagi: …`\n-# Sesja przyjęła założenia."
        );
    }

    #[test]
    fn render_joins_several_text_options() {
        let mut entry = item("i1", "S1", &[]);
        entry.question = "Q".into();
        entry.text_options = vec!["a".into(), "b".into()];
        let json = render(&view_of(vec![block("p · t", vec![entry], vec![])]));
        assert_eq!(
            json["components"][0]["components"][1]["content"],
            "**S1** Q\n-# albo odpisz `S1 a: …` · `S1 b: …`"
        );
    }

    #[test]
    fn render_title_variants() {
        let mut continued = block("p · Tytuł", vec![], vec![]);
        continued.continued = true;
        let bare = block("Sesja 0123abcd", vec![], vec![]);
        let json = render(&view_of(vec![continued, bare]));
        assert_eq!(
            json["components"][0]["components"][0]["content"],
            "**📁 p** — Tytuł (cd.)"
        );
        assert_eq!(
            json["components"][1]["components"][0]["content"],
            "**📁 Sesja 0123abcd**"
        );
    }

    #[test]
    fn render_pending_approval_has_success_and_danger_buttons() {
        let json = render(&view_of(vec![block(
            "p · t",
            vec![],
            vec![approval("a1", ApprovalMark::Pending)],
        )]));
        let inner = json["components"][0]["components"].as_array().unwrap();
        assert_eq!(
            inner[1]["content"],
            "🔒 **Zgoda:** `git push → master` · kod `K7QX`"
        );
        let buttons = inner[2]["components"].as_array().unwrap();
        assert_eq!(buttons[0]["style"], 3);
        assert_eq!(buttons[0]["label"], "Zatwierdź");
        assert_eq!(buttons[0]["emoji"], json!({"name": "✅"}));
        assert_eq!(buttons[0]["custom_id"], "abeon:a:a1:y");
        assert_eq!(buttons[1]["style"], 4);
        assert_eq!(buttons[1]["label"], "Odrzuć");
        assert_eq!(buttons[1]["emoji"], json!({"name": "❌"}));
        assert_eq!(buttons[1]["custom_id"], "abeon:a:a1:n");
    }

    #[test]
    fn resolved_states_replace_the_row_with_text() {
        let long = "x".repeat(60);
        let mut clicked = item("i1", "S1", &["tak"]);
        clicked.state = ItemState::Clicked("tak".into());
        let mut answered = item("i2", "S2", &["tak"]);
        answered.state = ItemState::Answered(long);
        let mut settled = item("i3", "S3", &["tak"]);
        settled.state = ItemState::Settled;
        let json = render(&view_of(vec![block(
            "p · t",
            vec![clicked, answered, settled],
            vec![
                approval("a1", ApprovalMark::Approved),
                approval("a2", ApprovalMark::Rejected),
                approval("a3", ApprovalMark::Expired),
            ],
        )]));
        let all = texts(&json["components"]);
        assert!(all.contains(&"✅ S1: tak".to_string()));
        assert!(all.contains(&format!("✅ S2: {}…", "x".repeat(40))));
        assert!(all.contains(&"✅ S3: rozstrzygnięte".to_string()));
        assert!(all.contains(&"✅ Zatwierdzono".to_string()));
        assert!(all.contains(&"❌ Odrzucono".to_string()));
        assert!(all.contains(&"⌛ Wygasło".to_string()));
        assert_eq!(rows(&json["components"]), 0);
    }

    #[test]
    fn answered_values_up_to_forty_characters_are_kept_whole() {
        let mut entry = item("i1", "S1", &["tak"]);
        entry.state = ItemState::Answered("ą".repeat(40));
        let json = render(&view_of(vec![block("p · t", vec![entry], vec![])]));
        assert!(texts(&json["components"]).contains(&format!("✅ S1: {}", "ą".repeat(40))));
        let mut longer = item("i1", "S1", &["tak"]);
        longer.state = ItemState::Answered("ą".repeat(41));
        let json = render(&view_of(vec![block("p · t", vec![longer], vec![])]));
        assert!(texts(&json["components"]).contains(&format!("✅ S1: {}…", "ą".repeat(40))));
    }

    #[test]
    fn footer_samples_the_first_three_keys_with_options() {
        let blocks = vec![
            block(
                "p · a",
                vec![item("i1", "S1", &["tak", "nie"]), item("i2", "S0", &[])],
                vec![],
            ),
            block(
                "p · b",
                vec![
                    item("i3", "S2", &["prod"]),
                    item("i4", "B1", &["tak"]),
                    item("i5", "B2", &["x"]),
                ],
                vec![],
            ),
        ];
        assert_eq!(
            footer(&blocks).unwrap(),
            "-# Możesz też odpisać tekstem, np. `S1 tak, S2 prod, B1 tak`"
        );
    }

    #[test]
    fn footer_is_absent_without_options() {
        let blocks = vec![block("p · a", vec![item("i1", "S1", &[])], vec![])];
        assert_eq!(footer(&blocks), None);
    }

    #[test]
    fn label_without_separator_is_the_whole_project() {
        assert_eq!(
            project_and_title("Sesja 0123abcd"),
            ("Sesja 0123abcd".into(), None)
        );
    }

    #[test]
    fn label_splits_at_the_first_separator() {
        assert_eq!(
            project_and_title("zargood · A · B"),
            ("zargood".into(), Some("A · B".into()))
        );
    }

    #[test]
    fn accent_is_stable_and_from_the_palette() {
        assert_eq!(accent("zargood"), accent("zargood"));
        assert!(PALETTE.contains(&accent("therappio")));
        assert!(PALETTE.contains(&accent("zargood")));
    }

    #[test]
    fn accent_matches_the_fnv1a_reference() {
        assert_eq!(accent(""), PALETTE[(0x811c9dc5u32 % 6) as usize]);
        assert_eq!(accent("a"), PALETTE[(0xe40c292cu32 % 6) as usize]);
    }

    fn big_block(items: usize) -> BlockView {
        let entries = (0..items)
            .map(|n| {
                item(
                    &format!("i{n}"),
                    &format!("S{n}"),
                    &["a", "b", "c", "d", "e"],
                )
            })
            .collect();
        block("zargood · Duży", entries, vec![])
    }

    #[test]
    fn split_keeps_a_small_batch_in_one_message() {
        let blocks = vec![block("p · t", vec![item("i1", "S1", &["tak"])], vec![])];
        let messages = split(blocks, Some("H".into()), Some("F".into()));
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].header.as_deref(), Some("H"));
        assert_eq!(messages[0].footer.as_deref(), Some("F"));
        assert_eq!(messages[0].blocks.len(), 1);
        assert!(!messages[0].blocks[0].continued);
    }

    #[test]
    fn split_moves_a_block_that_does_not_fit_to_the_next_message() {
        let blocks = vec![big_block(3), big_block(3)];
        let messages = split(blocks, Some("H".into()), Some("F".into()));
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].blocks.len(), 1);
        assert_eq!(messages[1].blocks.len(), 1);
        assert!(messages
            .iter()
            .all(|m| m.blocks.iter().all(|b| !b.continued)));
        assert_eq!(messages[0].header.as_deref(), Some("H"));
        assert_eq!(messages[0].footer, None);
        assert_eq!(messages[1].header, None);
        assert_eq!(messages[1].footer.as_deref(), Some("F"));
        assert!(messages.iter().all(fits));
    }

    #[test]
    fn split_continues_an_oversized_block_as_cd() {
        let blocks = vec![big_block(6)];
        let messages = split(blocks, Some("H".into()), Some("F".into()));
        assert_eq!(messages.len(), 2);
        assert!(!messages[0].blocks[0].continued);
        assert!(messages[1].blocks[0].continued);
        assert_eq!(messages[0].header.as_deref(), Some("H"));
        assert_eq!(messages[1].header, None);
        assert_eq!(messages[0].footer, None);
        assert_eq!(messages[1].footer.as_deref(), Some("F"));
        let total: usize = messages
            .iter()
            .flat_map(|m| &m.blocks)
            .map(|b| b.items.len())
            .sum();
        assert_eq!(total, 6);
        for message in &messages {
            let json = render(message);
            assert!(component_count(&json["components"]) <= 40);
            assert!(text_length(&json["components"]) <= 4000);
        }
    }

    #[test]
    fn split_respects_the_text_limit() {
        let entries = (0..15)
            .map(|n| {
                let mut entry = item(&format!("i{n}"), &format!("S{n}"), &[]);
                entry.question = "ż".repeat(300);
                entry
            })
            .collect();
        let messages = split(
            vec![block("p · t", entries, vec![])],
            Some("H".into()),
            Some("F".into()),
        );
        assert!(messages.len() >= 2);
        assert!(messages.iter().all(fits));
        assert_eq!(messages.last().unwrap().footer.as_deref(), Some("F"));
    }

    #[test]
    fn split_of_nothing_is_empty() {
        assert!(split(vec![], Some("H".into()), None).is_empty());
    }

    #[test]
    fn replace_row_swaps_only_the_clicked_row() {
        let view = view_of(vec![block(
            "p · t",
            vec![item("i1", "S1", &["tak"]), item("i2", "S2", &["nie"])],
            vec![],
        )]);
        let json = render(&view);
        let replaced = replace_row(&json["components"], "abeon:q:i1:0", "✅ S1: tak");
        let inner = replaced[0]["components"].as_array().unwrap();
        assert_eq!(inner[2], json!({"type": 10, "content": "✅ S1: tak"}));
        assert_eq!(inner[4]["type"], 1);
        assert_eq!(inner[4]["components"][0]["custom_id"], "abeon:q:i2:0");
        assert_eq!(rows(&replaced), 1);
        assert_eq!(rows(&json["components"]), 2);
    }

    #[test]
    fn replace_row_without_a_match_changes_nothing() {
        let view = view_of(vec![block(
            "p · t",
            vec![item("i1", "S1", &["tak"])],
            vec![],
        )]);
        let json = render(&view);
        assert_eq!(
            replace_row(&json["components"], "abeon:q:zz:0", "x"),
            json["components"]
        );
    }

    #[test]
    fn counts_cover_nested_components() {
        let view = view_of(vec![block(
            "p · t",
            vec![item("i1", "S1", &["a", "b"])],
            vec![],
        )]);
        let json = render(&view);
        assert_eq!(component_count(&json["components"]), 6);
        let expected = "**📁 p** — t".chars().count() + "**S1** Pytanie S1?".chars().count();
        assert_eq!(text_length(&json["components"]), expected);
    }

    #[test]
    fn backticks_in_supervisor_text_do_not_break_code_spans() {
        let mut entry = item("i1", "S1", &["a`b"]);
        entry.question = "Q`x".into();
        entry.context = Some("c`d".into());
        entry.text_options = vec!["o`p".into()];
        let blocks = vec![block("p · t", vec![entry], vec![])];
        let json = render(&view_of(blocks.clone()));
        let inner = json["components"][0]["components"].as_array().unwrap();
        assert_eq!(inner[2]["components"][0]["label"], "a'b");
        assert_eq!(
            inner[1]["content"],
            "**S1** Q'x\n-# albo odpisz `S1 o'p: …`\n-# c'd"
        );
        assert_eq!(
            footer(&blocks).unwrap(),
            "-# Możesz też odpisać tekstem, np. `S1 a'b`"
        );
    }
}

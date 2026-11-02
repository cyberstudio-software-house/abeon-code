use std::collections::{HashMap, HashSet};

use super::render::{
    footer, header, project_and_title, split, ApprovalMark, ApprovalRow, BlockView, ItemState,
    ItemView, MessageView,
};

const ITEM_ID_LENGTH: usize = 8;
const FALLBACK_PREFIX: &str = "X";

#[derive(Clone, Debug, PartialEq)]
pub struct PostItem {
    pub question_id: String,
    pub question: String,
    pub options: Vec<String>,
    pub text_options: Vec<String>,
    pub context: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PostApproval {
    pub approval_id: String,
    pub action: String,
    pub code: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PostBlock {
    pub session_id: String,
    pub label: String,
    pub items: Vec<PostItem>,
    pub approvals: Vec<PostApproval>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PostRequest {
    pub blocks: Vec<PostBlock>,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq)]
pub struct PostedKey {
    pub question_id: String,
    pub question: String,
    pub key: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Default)]
pub struct PostResult {
    pub posted: usize,
    pub keys: Vec<PostedKey>,
    pub skipped: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct KeyAnswer {
    pub key: String,
    pub value: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ClickedOption {
    pub question_id: String,
    pub session_id: String,
    pub label: String,
    pub key: String,
    pub question: String,
    pub value: String,
    pub open_keys: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ButtonTarget {
    Option {
        message: u64,
        item_id: String,
        index: usize,
    },
    Approval {
        message: u64,
        approval_id: String,
        approve: bool,
    },
}

pub struct PlannedPost {
    pub messages: Vec<u64>,
    pub result: PostResult,
}

pub struct AnswerOutcome {
    pub changed: Vec<u64>,
    pub skipped: Vec<String>,
}

struct StoredItem {
    item_id: String,
    message: u64,
    session_id: String,
    label: String,
    project: String,
    question_id: String,
    key: String,
    question: String,
    context: Option<String>,
    options: Vec<String>,
    text_options: Vec<String>,
    state: ItemState,
}

struct StoredApproval {
    message: u64,
    approval_id: String,
    action: String,
    code: String,
    mark: ApprovalMark,
}

struct StoredBlock {
    label: String,
    continued: bool,
    item_ids: Vec<String>,
    approval_ids: Vec<String>,
}

struct StoredMessage {
    discord_id: Option<String>,
    header: Option<String>,
    footer: Option<String>,
    blocks: Vec<StoredBlock>,
}

#[derive(Default)]
pub struct ButtonRegistry {
    next_message: u64,
    messages: HashMap<u64, StoredMessage>,
    items: Vec<StoredItem>,
    approvals: Vec<StoredApproval>,
    counters: HashMap<String, u64>,
}

fn alphanumeric_units(project: &str) -> Vec<String> {
    project
        .chars()
        .filter(|character| character.is_alphanumeric())
        .map(|character| character.to_uppercase().collect::<String>())
        .collect()
}

fn project_prefix(project: &str, length: usize) -> String {
    let units = alphanumeric_units(project);
    if units.is_empty() {
        FALLBACK_PREFIX.to_string()
    } else {
        units.iter().take(length).cloned().collect()
    }
}

fn push_unique(list: &mut Vec<String>, value: &str) {
    if !list.iter().any(|existing| existing == value) {
        list.push(value.to_string());
    }
}

fn push_changed(list: &mut Vec<u64>, message: u64) {
    if !list.contains(&message) {
        list.push(message);
    }
}

impl ButtonRegistry {
    fn random_item_id(&self) -> String {
        loop {
            let candidate: String = uuid::Uuid::new_v4()
                .simple()
                .to_string()
                .chars()
                .take(ITEM_ID_LENGTH)
                .collect();
            if !self.items.iter().any(|item| item.item_id == candidate) {
                return candidate;
            }
        }
    }

    fn assign_key(&mut self, project: &str) -> String {
        let longest = alphanumeric_units(project).len().max(1);
        let rivals: HashSet<&str> = self
            .items
            .iter()
            .filter(|item| item.state == ItemState::Open && item.project != project)
            .map(|item| item.project.as_str())
            .collect();
        let mut length = 1;
        while length < longest
            && rivals
                .iter()
                .any(|rival| project_prefix(rival, length) == project_prefix(project, length))
        {
            length += 1;
        }
        let prefix = project_prefix(project, length);
        loop {
            let counter = self.counters.entry(prefix.clone()).or_insert(0);
            *counter += 1;
            let key = format!("{prefix}{counter}");
            if !self.items.iter().any(|item| item.key == key) {
                return key;
            }
        }
    }

    fn forget_approval(&mut self, approval_id: &str) {
        self.approvals
            .retain(|approval| approval.approval_id != approval_id);
        for message in self.messages.values_mut() {
            for block in &mut message.blocks {
                block.approval_ids.retain(|id| id != approval_id);
            }
        }
    }

    fn block_view(
        &self,
        label: &str,
        continued: bool,
        item_ids: &[String],
        approval_ids: &[String],
    ) -> BlockView {
        let items = item_ids
            .iter()
            .filter_map(|id| self.items.iter().find(|item| &item.item_id == id))
            .map(|item| ItemView {
                item_id: item.item_id.clone(),
                key: item.key.clone(),
                question: item.question.clone(),
                context: item.context.clone(),
                options: item.options.clone(),
                text_options: item.text_options.clone(),
                state: item.state.clone(),
            })
            .collect();
        let approvals = approval_ids
            .iter()
            .filter_map(|id| {
                self.approvals
                    .iter()
                    .find(|approval| &approval.approval_id == id)
            })
            .map(|approval| ApprovalRow {
                approval_id: approval.approval_id.clone(),
                action: approval.action.clone(),
                code: approval.code.clone(),
                mark: approval.mark,
            })
            .collect();
        BlockView {
            label: label.to_string(),
            continued,
            items,
            approvals,
        }
    }

    pub fn plan_post(&mut self, request: PostRequest) -> PlannedPost {
        let open_questions: HashSet<String> = self
            .items
            .iter()
            .filter(|item| item.state == ItemState::Open)
            .map(|item| item.question_id.clone())
            .collect();
        let mut skipped: Vec<String> = Vec::new();
        let mut keys: Vec<PostedKey> = Vec::new();
        let mut staged: Vec<(String, Vec<String>, Vec<String>)> = Vec::new();

        for block in request.blocks {
            let (project, _) = project_and_title(&block.label);
            let mut item_ids = Vec::new();
            let mut approval_ids = Vec::new();
            for item in block.items {
                if open_questions.contains(&item.question_id) {
                    push_unique(&mut skipped, &item.question_id);
                    continue;
                }
                let item_id = self.random_item_id();
                let key = self.assign_key(&project);
                keys.push(PostedKey {
                    question_id: item.question_id.clone(),
                    question: item.question.clone(),
                    key: key.clone(),
                });
                self.items.push(StoredItem {
                    item_id: item_id.clone(),
                    message: 0,
                    session_id: block.session_id.clone(),
                    label: block.label.clone(),
                    project: project.clone(),
                    question_id: item.question_id,
                    key,
                    question: item.question,
                    context: item.context,
                    options: item.options,
                    text_options: item.text_options,
                    state: ItemState::Open,
                });
                item_ids.push(item_id);
            }
            for approval in block.approvals {
                let existing = self
                    .approvals
                    .iter()
                    .find(|stored| stored.approval_id == approval.approval_id);
                if let Some(stored) = existing {
                    if stored.mark == ApprovalMark::Pending {
                        push_unique(&mut skipped, &approval.approval_id);
                        continue;
                    }
                    self.forget_approval(&approval.approval_id);
                }
                self.approvals.push(StoredApproval {
                    message: 0,
                    approval_id: approval.approval_id.clone(),
                    action: approval.action,
                    code: approval.code,
                    mark: ApprovalMark::Pending,
                });
                approval_ids.push(approval.approval_id);
            }
            if !item_ids.is_empty() || !approval_ids.is_empty() {
                staged.push((block.label, item_ids, approval_ids));
            }
        }

        let views: Vec<BlockView> = staged
            .iter()
            .map(|(label, item_ids, approval_ids)| {
                self.block_view(label, false, item_ids, approval_ids)
            })
            .collect();
        let message_header = if views.is_empty() {
            None
        } else {
            Some(header(&views))
        };
        let message_footer = footer(&views);
        let layout = split(views, message_header, message_footer);

        let mut messages = Vec::new();
        for message_view in layout {
            self.next_message += 1;
            let message_id = self.next_message;
            let mut blocks = Vec::new();
            for block in message_view.blocks {
                let item_ids: Vec<String> = block
                    .items
                    .iter()
                    .map(|item| item.item_id.clone())
                    .collect();
                let approval_ids: Vec<String> = block
                    .approvals
                    .iter()
                    .map(|approval| approval.approval_id.clone())
                    .collect();
                for item in self
                    .items
                    .iter_mut()
                    .filter(|item| item_ids.contains(&item.item_id))
                {
                    item.message = message_id;
                }
                for approval in self
                    .approvals
                    .iter_mut()
                    .filter(|approval| approval_ids.contains(&approval.approval_id))
                {
                    approval.message = message_id;
                }
                blocks.push(StoredBlock {
                    label: block.label,
                    continued: block.continued,
                    item_ids,
                    approval_ids,
                });
            }
            self.messages.insert(
                message_id,
                StoredMessage {
                    discord_id: None,
                    header: message_view.header,
                    footer: message_view.footer,
                    blocks,
                },
            );
            messages.push(message_id);
        }

        PlannedPost {
            result: PostResult {
                posted: messages.len(),
                keys,
                skipped,
            },
            messages,
        }
    }

    pub fn view(&self, message: u64) -> Option<MessageView> {
        let stored = self.messages.get(&message)?;
        Some(MessageView {
            header: stored.header.clone(),
            blocks: stored
                .blocks
                .iter()
                .map(|block| {
                    self.block_view(
                        &block.label,
                        block.continued,
                        &block.item_ids,
                        &block.approval_ids,
                    )
                })
                .collect(),
            footer: stored.footer.clone(),
        })
    }

    pub fn discord_id(&self, message: u64) -> Option<String> {
        self.messages.get(&message)?.discord_id.clone()
    }

    pub fn confirm_posted(&mut self, message: u64, discord_id: String) {
        if let Some(stored) = self.messages.get_mut(&message) {
            stored.discord_id = Some(discord_id);
        }
    }

    pub fn discard(&mut self, message: u64) {
        self.messages.remove(&message);
        self.items.retain(|item| item.message != message);
        self.approvals
            .retain(|approval| approval.message != message);
    }

    pub fn target(&self, custom_id: &str) -> Option<ButtonTarget> {
        let parts: Vec<&str> = custom_id.split(':').collect();
        if parts.len() != 4 || parts[0] != "abeon" {
            return None;
        }
        match parts[1] {
            "q" => {
                let index: usize = parts[3].parse().ok()?;
                let item = self.items.iter().find(|item| item.item_id == parts[2])?;
                Some(ButtonTarget::Option {
                    message: item.message,
                    item_id: item.item_id.clone(),
                    index,
                })
            }
            "a" => {
                let approve = match parts[3] {
                    "y" => true,
                    "n" => false,
                    _ => return None,
                };
                let approval = self
                    .approvals
                    .iter()
                    .find(|approval| approval.approval_id == parts[2])?;
                Some(ButtonTarget::Approval {
                    message: approval.message,
                    approval_id: approval.approval_id.clone(),
                    approve,
                })
            }
            _ => None,
        }
    }

    pub fn click_option(&mut self, item_id: &str, index: usize) -> Option<ClickedOption> {
        let position = self.items.iter().position(|item| item.item_id == item_id)?;
        let item = &self.items[position];
        if item.state != ItemState::Open {
            return None;
        }
        let value = item.options.get(index)?.clone();
        let open_keys = self
            .items
            .iter()
            .filter(|other| {
                other.item_id != item_id
                    && other.question_id == item.question_id
                    && other.state == ItemState::Open
            })
            .map(|other| other.key.clone())
            .collect();
        let clicked = ClickedOption {
            question_id: item.question_id.clone(),
            session_id: item.session_id.clone(),
            label: item.label.clone(),
            key: item.key.clone(),
            question: item.question.clone(),
            value: value.clone(),
            open_keys,
        };
        self.items[position].state = ItemState::Clicked(value);
        Some(clicked)
    }

    pub fn mark_approval(&mut self, approval_id: &str, mark: ApprovalMark) -> Option<u64> {
        let approval = self
            .approvals
            .iter_mut()
            .find(|approval| approval.approval_id == approval_id)?;
        if approval.mark == mark {
            return None;
        }
        approval.mark = mark;
        Some(approval.message)
    }

    pub fn answer_keys(&mut self, answers: &[KeyAnswer]) -> AnswerOutcome {
        let mut changed = Vec::new();
        let mut skipped = Vec::new();
        for answer in answers {
            let key = answer.key.to_uppercase();
            let open = self
                .items
                .iter_mut()
                .find(|item| item.key == key && item.state == ItemState::Open);
            match open {
                Some(item) => {
                    item.state = ItemState::Answered(answer.value.clone());
                    push_changed(&mut changed, item.message);
                }
                None => push_unique(&mut skipped, &answer.key),
            }
        }
        AnswerOutcome { changed, skipped }
    }

    fn settle_where(&mut self, matches: impl Fn(&StoredItem) -> bool) -> Vec<u64> {
        let mut changed = Vec::new();
        for item in &mut self.items {
            if item.state == ItemState::Open && matches(item) {
                item.state = ItemState::Settled;
                push_changed(&mut changed, item.message);
            }
        }
        changed
    }

    pub fn settle_session(&mut self, session_id: &str) -> Vec<u64> {
        self.settle_where(|item| item.session_id == session_id)
    }

    pub fn settle_question(&mut self, question_id: &str) -> Vec<u64> {
        self.settle_where(|item| item.question_id == question_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(question_id: &str, options: &[&str]) -> PostItem {
        PostItem {
            question_id: question_id.into(),
            question: format!("Pytanie {question_id}?"),
            options: options.iter().map(|option| option.to_string()).collect(),
            text_options: vec![],
            context: None,
        }
    }

    fn block(session_id: &str, label: &str, items: Vec<PostItem>) -> PostBlock {
        PostBlock {
            session_id: session_id.into(),
            label: label.into(),
            items,
            approvals: vec![],
        }
    }

    fn request(blocks: Vec<PostBlock>) -> PostRequest {
        PostRequest { blocks }
    }

    fn keys_of(planned: &PlannedPost) -> Vec<String> {
        planned
            .result
            .keys
            .iter()
            .map(|posted| posted.key.clone())
            .collect()
    }

    fn approval_block(session_id: &str, approval_id: &str) -> PostBlock {
        PostBlock {
            session_id: session_id.into(),
            label: "sklep · Zgoda".into(),
            items: vec![],
            approvals: vec![PostApproval {
                approval_id: approval_id.into(),
                action: "git push → master".into(),
                code: "K7QX".into(),
            }],
        }
    }

    fn item_id_of(registry: &ButtonRegistry, key: &str) -> String {
        registry
            .items
            .iter()
            .find(|item| item.key == key)
            .unwrap()
            .item_id
            .clone()
    }

    fn first_item_state(registry: &ButtonRegistry, message: u64, key: &str) -> ItemState {
        registry
            .view(message)
            .unwrap()
            .blocks
            .iter()
            .flat_map(|block| block.items.iter())
            .find(|item| item.key == key)
            .unwrap()
            .state
            .clone()
    }

    #[test]
    fn keys_use_the_projects_first_letter_and_count_up() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![
            block(
                "s1",
                "sklep · A",
                vec![item("q1", &["tak"]), item("q2", &["tak"])],
            ),
            block("s2", "blog · B", vec![item("q3", &["tak"])]),
        ]));
        assert_eq!(keys_of(&planned), vec!["S1", "S2", "B1"]);
        assert_eq!(planned.result.posted, 1);
        assert_eq!(planned.messages.len(), 1);
        assert_eq!(planned.result.keys[0].question_id, "q1");
        assert_eq!(planned.result.keys[0].question, "Pytanie q1?");
    }

    #[test]
    fn keys_lengthen_only_for_new_items_when_letters_collide() {
        let mut registry = ButtonRegistry::default();
        let first = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"])],
        )]));
        assert_eq!(keys_of(&first), vec!["S1"]);
        let second = registry.plan_post(request(vec![block(
            "s2",
            "serwis · B",
            vec![item("q2", &["tak"])],
        )]));
        assert_eq!(keys_of(&second), vec!["SE1"]);
        let third = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q3", &["tak"])],
        )]));
        assert_eq!(keys_of(&third), vec!["SK1"]);
        let keys: Vec<&str> = registry
            .items
            .iter()
            .map(|item| item.key.as_str())
            .collect();
        assert_eq!(keys, vec!["S1", "SE1", "SK1"]);
    }

    #[test]
    fn items_of_the_same_request_count_as_open_for_later_items() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![
            block("s1", "sklep · A", vec![item("q1", &["tak"])]),
            block("s2", "serwis · B", vec![item("q2", &["tak"])]),
        ]));
        assert_eq!(keys_of(&planned), vec!["S1", "SE1"]);
    }

    #[test]
    fn key_lengthening_stops_at_a_shared_alphanumeric_prefix() {
        let mut registry = ButtonRegistry::default();
        registry.plan_post(request(vec![block(
            "s1",
            "ab · A",
            vec![item("q1", &["tak"])],
        )]));
        let planned = registry.plan_post(request(vec![block(
            "s2",
            "ab! · B",
            vec![item("q2", &["tak"])],
        )]));
        assert_eq!(keys_of(&planned), vec!["AB1"]);
        let again = registry.plan_post(request(vec![block(
            "s2",
            "ab! · B",
            vec![item("q3", &["tak"])],
        )]));
        assert_eq!(keys_of(&again), vec!["AB2"]);
    }

    #[test]
    fn keys_are_not_reused_after_an_item_closes() {
        let mut registry = ButtonRegistry::default();
        registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"])],
        )]));
        registry.answer_keys(&[KeyAnswer {
            key: "S1".into(),
            value: "tak".into(),
        }]);
        let planned = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q2", &["tak"])],
        )]));
        assert_eq!(keys_of(&planned), vec!["S2"]);
    }

    #[test]
    fn keys_use_the_uppercase_first_letter_of_unicode_names() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![
            block("s1", "łódź · x", vec![item("q1", &["tak"])]),
            block("s2", "Sesja 0123abcd", vec![item("q2", &["tak"])]),
        ]));
        assert_eq!(keys_of(&planned), vec!["Ł1", "S1"]);
    }

    #[test]
    fn a_name_without_alphanumeric_characters_uses_x() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![block(
            "s1",
            "!!! · x",
            vec![item("q1", &["tak"])],
        )]));
        assert_eq!(keys_of(&planned), vec!["X1"]);
    }

    #[test]
    fn posting_an_open_question_again_is_skipped() {
        let mut registry = ButtonRegistry::default();
        let same_request = request(vec![block("s1", "sklep · A", vec![item("q1", &["tak"])])]);
        let first = registry.plan_post(same_request.clone());
        assert_eq!(first.messages.len(), 1);
        let second = registry.plan_post(same_request);
        assert_eq!(second.result.skipped, vec!["q1".to_string()]);
        assert!(second.messages.is_empty());
        assert_eq!(second.result.posted, 0);
        assert!(second.result.keys.is_empty());
    }

    #[test]
    fn one_request_may_carry_the_same_question_twice() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"]), item("q1", &["nie"])],
        )]));
        assert_eq!(keys_of(&planned), vec!["S1", "S2"]);
        assert!(planned.result.skipped.is_empty());
        let again = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"]), item("q1", &["nie"])],
        )]));
        assert_eq!(again.result.skipped, vec!["q1".to_string()]);
    }

    #[test]
    fn a_closed_question_can_be_posted_again() {
        let mut registry = ButtonRegistry::default();
        registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"])],
        )]));
        registry.settle_question("q1");
        let planned = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"])],
        )]));
        assert_eq!(planned.messages.len(), 1);
        assert!(planned.result.skipped.is_empty());
    }

    #[test]
    fn a_pending_approval_is_posted_once() {
        let mut registry = ButtonRegistry::default();
        let first = registry.plan_post(request(vec![approval_block("s1", "ap1")]));
        assert_eq!(first.messages.len(), 1);
        assert!(first.result.keys.is_empty());
        let second = registry.plan_post(request(vec![
            approval_block("s1", "ap1"),
            approval_block("s1", "ap1"),
        ]));
        assert_eq!(second.result.skipped, vec!["ap1".to_string()]);
        assert!(second.messages.is_empty());
        let view = registry.view(first.messages[0]).unwrap();
        assert_eq!(view.blocks[0].approvals.len(), 1);
        assert_eq!(view.blocks[0].approvals[0].mark, ApprovalMark::Pending);
    }

    #[test]
    fn a_resolved_approval_can_be_posted_again_without_duplicates() {
        let mut registry = ButtonRegistry::default();
        let first = registry.plan_post(request(vec![approval_block("s1", "ap1")]));
        registry.mark_approval("ap1", ApprovalMark::Expired);
        let second = registry.plan_post(request(vec![approval_block("s1", "ap1")]));
        assert_eq!(second.messages.len(), 1);
        assert_eq!(registry.approvals.len(), 1);
        let old = registry.view(first.messages[0]).unwrap();
        assert!(old.blocks[0].approvals.is_empty());
        let new = registry.view(second.messages[0]).unwrap();
        assert_eq!(new.blocks[0].approvals[0].mark, ApprovalMark::Pending);
    }

    #[test]
    fn the_layout_carries_header_footer_and_message_ids_in_order() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"])],
        )]));
        let view = registry.view(planned.messages[0]).unwrap();
        assert_eq!(view.header.as_deref(), Some("**🧭 Do decyzji: sklep (1)**"));
        assert_eq!(
            view.footer.as_deref(),
            Some("-# Możesz też odpisać tekstem, np. `S1 tak`")
        );
        assert_eq!(view.blocks[0].items[0].key, "S1");
        assert_eq!(view.blocks[0].items[0].item_id.len(), 8);
        assert!(view.blocks[0].items[0]
            .item_id
            .chars()
            .all(|character| character.is_ascii_hexdigit() && !character.is_uppercase()));
        assert!(registry.view(999).is_none());

        let more = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q2", &["tak"])],
        )]));
        assert!(more.messages[0] > planned.messages[0]);
    }

    #[test]
    fn a_large_batch_is_split_across_messages() {
        let mut registry = ButtonRegistry::default();
        let items: Vec<PostItem> = (0..12)
            .map(|n| item(&format!("q{n}"), &["a", "b", "c", "d", "e"]))
            .collect();
        let planned = registry.plan_post(request(vec![block("s1", "sklep · A", items)]));
        assert!(planned.messages.len() >= 2);
        assert_eq!(planned.result.posted, planned.messages.len());
        assert_eq!(planned.result.keys.len(), 12);
        let first = registry.view(planned.messages[0]).unwrap();
        let last = registry.view(*planned.messages.last().unwrap()).unwrap();
        assert!(first.header.is_some());
        assert!(first.footer.is_none());
        assert!(last.footer.is_some());
        assert!(last.blocks[0].continued);
        let first_key = first.blocks[0].items[0].key.clone();
        let target = registry.target(&format!("abeon:q:{}:0", item_id_of(&registry, &first_key)));
        match target {
            Some(ButtonTarget::Option { message, .. }) => assert_eq!(message, planned.messages[0]),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn target_parses_both_custom_id_formats_and_rejects_others() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![
            block("s1", "sklep · A", vec![item("q1", &["tak", "nie"])]),
            approval_block("s1", "ap1"),
        ]));
        let message = planned.messages[0];
        let item_id = item_id_of(&registry, "S1");
        assert_eq!(
            registry.target(&format!("abeon:q:{item_id}:1")),
            Some(ButtonTarget::Option {
                message,
                item_id: item_id.clone(),
                index: 1
            })
        );
        assert_eq!(
            registry.target("abeon:a:ap1:y"),
            Some(ButtonTarget::Approval {
                message,
                approval_id: "ap1".into(),
                approve: true
            })
        );
        assert_eq!(
            registry.target("abeon:a:ap1:n"),
            Some(ButtonTarget::Approval {
                message,
                approval_id: "ap1".into(),
                approve: false
            })
        );
        assert_eq!(registry.target("perm:allow:abcde"), None);
        assert_eq!(registry.target(&format!("abeon:q:{item_id}:x")), None);
        assert_eq!(registry.target("abeon:q:unknown:0"), None);
        assert_eq!(registry.target("abeon:a:unknown:y"), None);
        assert_eq!(registry.target("abeon:a:ap1:z"), None);
        assert_eq!(registry.target("abeon:z:ap1:y"), None);
        assert_eq!(registry.target("abeon:q:ap1"), None);
        assert_eq!(registry.target(""), None);
    }

    #[test]
    fn click_option_returns_the_answer_and_the_still_open_keys() {
        let mut registry = ButtonRegistry::default();
        registry.plan_post(request(vec![block(
            "sess",
            "sklep · Refaktor",
            vec![item("q1", &["tak", "nie"]), item("q1", &["prod", "dev"])],
        )]));
        let first = item_id_of(&registry, "S1");
        let clicked = registry.click_option(&first, 0).unwrap();
        assert_eq!(clicked.value, "tak");
        assert_eq!(clicked.open_keys, vec!["S2".to_string()]);
        assert_eq!(clicked.question_id, "q1");
        assert_eq!(clicked.session_id, "sess");
        assert_eq!(clicked.label, "sklep · Refaktor");
        assert_eq!(clicked.key, "S1");
        assert_eq!(clicked.question, "Pytanie q1?");
        assert_eq!(registry.click_option(&first, 0), None);
        let second = item_id_of(&registry, "S2");
        assert_eq!(registry.click_option(&second, 5), None);
        let last = registry.click_option(&second, 1).unwrap();
        assert_eq!(last.value, "dev");
        assert!(last.open_keys.is_empty());
        assert_eq!(registry.click_option("nope", 0), None);
    }

    #[test]
    fn open_keys_follow_creation_order() {
        let mut registry = ButtonRegistry::default();
        let items: Vec<PostItem> = (0..11).map(|_| item("q1", &["tak"])).collect();
        let planned = registry.plan_post(request(vec![block("s1", "sklep · A", items)]));
        assert_eq!(keys_of(&planned)[9], "S10");
        let first = item_id_of(&registry, "S1");
        let clicked = registry.click_option(&first, 0).unwrap();
        let expected: Vec<String> = (2..=11).map(|n| format!("S{n}")).collect();
        assert_eq!(clicked.open_keys, expected);
    }

    #[test]
    fn answer_keys_ignores_the_case_of_the_key() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"])],
        )]));
        let outcome = registry.answer_keys(&[
            KeyAnswer {
                key: "s1".into(),
                value: "tak".into(),
            },
            KeyAnswer {
                key: "s9".into(),
                value: "x".into(),
            },
        ]);
        assert_eq!(outcome.changed, vec![planned.messages[0]]);
        assert_eq!(outcome.skipped, vec!["s9".to_string()]);
        assert_eq!(
            first_item_state(&registry, planned.messages[0], "S1"),
            ItemState::Answered("tak".into())
        );
    }

    #[test]
    fn only_projects_with_open_items_count_as_rivals() {
        let mut registry = ButtonRegistry::default();
        registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"])],
        )]));
        registry.answer_keys(&[KeyAnswer {
            key: "S1".into(),
            value: "tak".into(),
        }]);
        let planned = registry.plan_post(request(vec![block(
            "s2",
            "serwis · B",
            vec![item("q2", &["tak"])],
        )]));
        assert_eq!(keys_of(&planned), vec!["S2"]);
    }

    #[test]
    fn answer_keys_closes_open_keys_and_skips_the_rest() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"]), item("q2", &["tak"])],
        )]));
        let outcome = registry.answer_keys(&[
            KeyAnswer {
                key: "S1".into(),
                value: "dowolnie".into(),
            },
            KeyAnswer {
                key: "S9".into(),
                value: "x".into(),
            },
            KeyAnswer {
                key: "S9".into(),
                value: "y".into(),
            },
            KeyAnswer {
                key: "S2".into(),
                value: "tak".into(),
            },
        ]);
        assert_eq!(outcome.changed, vec![planned.messages[0]]);
        assert_eq!(outcome.skipped, vec!["S9".to_string()]);
        assert_eq!(
            first_item_state(&registry, planned.messages[0], "S1"),
            ItemState::Answered("dowolnie".into())
        );
        let again = registry.answer_keys(&[KeyAnswer {
            key: "S1".into(),
            value: "znowu".into(),
        }]);
        assert!(again.changed.is_empty());
        assert_eq!(again.skipped, vec!["S1".to_string()]);
    }

    #[test]
    fn settle_session_closes_only_open_items_of_that_session() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![
            block(
                "s1",
                "sklep · A",
                vec![item("q1", &["tak"]), item("q2", &["tak"])],
            ),
            block("s2", "blog · B", vec![item("q3", &["tak"])]),
            approval_block("s1", "ap1"),
        ]));
        let message = planned.messages[0];
        let clicked = item_id_of(&registry, "S2");
        registry.click_option(&clicked, 0);
        let changed = registry.settle_session("s1");
        assert_eq!(changed, vec![message]);
        assert_eq!(
            first_item_state(&registry, message, "S1"),
            ItemState::Settled
        );
        assert_eq!(
            first_item_state(&registry, message, "S2"),
            ItemState::Clicked("tak".into())
        );
        assert_eq!(first_item_state(&registry, message, "B1"), ItemState::Open);
        let view = registry.view(message).unwrap();
        assert_eq!(view.blocks[2].approvals[0].mark, ApprovalMark::Pending);
        assert!(registry.settle_session("s1").is_empty());
        assert!(registry.settle_session("unknown").is_empty());
    }

    #[test]
    fn settle_question_closes_every_open_item_of_the_question() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![
                item("q1", &["tak"]),
                item("q1", &["nie"]),
                item("q2", &["x"]),
            ],
        )]));
        let message = planned.messages[0];
        assert_eq!(registry.settle_question("q1"), vec![message]);
        assert_eq!(
            first_item_state(&registry, message, "S1"),
            ItemState::Settled
        );
        assert_eq!(
            first_item_state(&registry, message, "S2"),
            ItemState::Settled
        );
        assert_eq!(first_item_state(&registry, message, "S3"), ItemState::Open);
        assert!(registry.settle_question("q1").is_empty());
    }

    #[test]
    fn mark_approval_reports_a_change_once() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![approval_block("s1", "ap1")]));
        assert_eq!(
            registry.mark_approval("ap1", ApprovalMark::Approved),
            Some(planned.messages[0])
        );
        assert_eq!(registry.mark_approval("ap1", ApprovalMark::Approved), None);
        assert_eq!(
            registry.mark_approval("missing", ApprovalMark::Approved),
            None
        );
        let view = registry.view(planned.messages[0]).unwrap();
        assert_eq!(view.blocks[0].approvals[0].mark, ApprovalMark::Approved);
    }

    #[test]
    fn discard_lets_the_same_question_be_posted_again() {
        let mut registry = ButtonRegistry::default();
        let same_request = request(vec![
            block("s1", "sklep · A", vec![item("q1", &["tak"])]),
            approval_block("s1", "ap1"),
        ]);
        let first = registry.plan_post(same_request.clone());
        let message = first.messages[0];
        let item_id = item_id_of(&registry, "S1");
        registry.discard(message);
        assert!(registry.view(message).is_none());
        assert_eq!(registry.target(&format!("abeon:q:{item_id}:0")), None);
        assert_eq!(registry.target("abeon:a:ap1:y"), None);
        let second = registry.plan_post(same_request);
        assert_eq!(second.messages.len(), 1);
        assert!(second.result.skipped.is_empty());
        assert_eq!(keys_of(&second), vec!["S2"]);
    }

    #[test]
    fn view_reflects_the_current_state() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"])],
        )]));
        let message = planned.messages[0];
        assert_eq!(first_item_state(&registry, message, "S1"), ItemState::Open);
        let item_id = item_id_of(&registry, "S1");
        registry.click_option(&item_id, 0);
        assert_eq!(
            first_item_state(&registry, message, "S1"),
            ItemState::Clicked("tak".into())
        );
    }

    #[test]
    fn discord_ids_are_stored_per_message() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![block(
            "s1",
            "sklep · A",
            vec![item("q1", &["tak"])],
        )]));
        let message = planned.messages[0];
        assert_eq!(registry.discord_id(message), None);
        registry.confirm_posted(message, "d-1".into());
        assert_eq!(registry.discord_id(message), Some("d-1".into()));
        assert_eq!(registry.discord_id(999), None);
    }

    #[test]
    fn a_request_with_empty_blocks_plans_nothing() {
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(request(vec![block("s1", "sklep · A", vec![])]));
        assert!(planned.messages.is_empty());
        assert_eq!(planned.result, PostResult::default());
    }
}

use serde_json::{json, Value};

use super::gateway::Interaction;
use super::registry::{ButtonRegistry, ButtonTarget, ClickedOption};
use super::render::{render, replace_row, v2_payload, ApprovalMark, STALE_TEXT};
use super::BUTTON_PREFIX;
use crate::supervisor::core::{ApprovalSource, ApprovalState, SupervisorCore};

pub const NOT_ALLOWED: &str = "Brak uprawnień.";
pub const SUPERVISOR_OFF: &str = "Agent sterujący jest wyłączony — odpowiedz w aplikacji.";

const EPHEMERAL_FLAG: u64 = 1 << 6;
const CHANNEL_MESSAGE_CALLBACK: u64 = 4;
const UPDATE_MESSAGE_CALLBACK: u64 = 7;

#[derive(Clone, Debug, PartialEq)]
pub enum InteractionReply {
    Update(Value),
    Ephemeral(&'static str),
}

#[derive(Clone, Debug, PartialEq)]
pub struct InteractionOutcome {
    pub reply: InteractionReply,
    pub answer: Option<ClickedOption>,
}

fn without_answer(reply: InteractionReply) -> InteractionOutcome {
    InteractionOutcome {
        reply,
        answer: None,
    }
}

fn stale(interaction: &Interaction) -> InteractionReply {
    InteractionReply::Update(v2_payload(replace_row(
        &interaction.message_components,
        &interaction.custom_id,
        STALE_TEXT,
    )))
}

fn current(registry: &ButtonRegistry, message: u64, interaction: &Interaction) -> InteractionReply {
    match registry.view(message) {
        Some(view) => InteractionReply::Update(render(&view)),
        None => stale(interaction),
    }
}

fn target_message(target: &ButtonTarget) -> u64 {
    match target {
        ButtonTarget::Option { message, .. } | ButtonTarget::Approval { message, .. } => *message,
    }
}

fn settled_mark(core: &SupervisorCore, approval_id: &str, approve: bool) -> Option<ApprovalMark> {
    if core
        .resolve_approval(approval_id, approve, ApprovalSource::Discord)
        .is_ok()
    {
        return Some(if approve {
            ApprovalMark::Approved
        } else {
            ApprovalMark::Rejected
        });
    }
    match core
        .approval_status(approval_id)
        .map(|status| status.status)
    {
        Ok(ApprovalState::Pending) => None,
        Ok(ApprovalState::Approved) => Some(ApprovalMark::Approved),
        Ok(ApprovalState::Rejected) => Some(ApprovalMark::Rejected),
        Ok(ApprovalState::Expired) | Err(_) => Some(ApprovalMark::Expired),
    }
}

pub fn decide(
    interaction: &Interaction,
    allow_from: &[String],
    registry: &mut ButtonRegistry,
    core: &SupervisorCore,
) -> InteractionOutcome {
    if !allow_from
        .iter()
        .any(|allowed| *allowed == interaction.user_id)
    {
        return without_answer(InteractionReply::Ephemeral(NOT_ALLOWED));
    }
    let target = interaction
        .custom_id
        .starts_with(BUTTON_PREFIX)
        .then(|| registry.target(&interaction.custom_id))
        .flatten()
        .filter(|target| {
            registry
                .discord_id(target_message(target))
                .is_none_or(|posted| posted == interaction.message_id)
        });
    match target {
        None => without_answer(stale(interaction)),
        Some(ButtonTarget::Approval {
            message,
            approval_id,
            approve,
        }) => {
            if let Some(mark) = settled_mark(core, &approval_id, approve) {
                registry.mark_approval(&approval_id, mark);
            }
            without_answer(current(registry, message, interaction))
        }
        Some(ButtonTarget::Option {
            message,
            item_id,
            index,
        }) => {
            if !core.accepts_discord_answers() {
                return without_answer(InteractionReply::Ephemeral(SUPERVISOR_OFF));
            }
            let answer = registry.click_option(&item_id, index);
            InteractionOutcome {
                reply: current(registry, message, interaction),
                answer,
            }
        }
    }
}

pub fn callback_payload(reply: &InteractionReply) -> Value {
    match reply {
        InteractionReply::Update(payload) => json!({
            "type": UPDATE_MESSAGE_CALLBACK,
            "data": payload,
        }),
        InteractionReply::Ephemeral(text) => json!({
            "type": CHANNEL_MESSAGE_CALLBACK,
            "data": {
                "content": text,
                "flags": EPHEMERAL_FLAG,
                "allowed_mentions": {"parse": []},
            },
        }),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::domain::supervisor::{ApprovalView, EscalationChannel, SupervisorLevel};
    use crate::supervisor::core::decision_kind;
    use crate::supervisor::discord::registry::{PostApproval, PostBlock, PostItem, PostRequest};
    use crate::supervisor::discord::render::{ItemState, MessageView};
    use crate::supervisor::effects::DiscordSync;
    use crate::supervisor::events::SupervisorEvent;
    use crate::supervisor::test_support::*;

    const OWNER: &str = "user-1";
    const STRANGER: &str = "user-2";
    const POSTED_ID: &str = "d-1";
    const TOKEN: &str = "interaction-token-secret";
    const LABEL: &str = "projekt · s1";

    struct Fixture {
        effects: Arc<FakeEffects>,
        core: Arc<SupervisorCore>,
        registry: ButtonRegistry,
        message: u64,
        approval: ApprovalView,
    }

    fn post_item(question: &str, options: &[&str]) -> PostItem {
        PostItem {
            question_id: "q1".into(),
            question: question.into(),
            options: options.iter().map(|option| option.to_string()).collect(),
            text_options: vec![],
            context: None,
        }
    }

    async fn fixture() -> Fixture {
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        link_discord(&effects);
        core.set_discord_active(true);
        core.set_away(true);
        core.on_session_hook(bash("s1", "git push origin main"))
            .await;
        let approvals = core.snapshot().approvals;
        assert_eq!(approvals.len(), 1);
        let approval = approvals.into_iter().next().unwrap();
        assert_eq!(approval.channel, EscalationChannel::Discord);
        let mut registry = ButtonRegistry::default();
        let planned = registry.plan_post(PostRequest {
            blocks: vec![PostBlock {
                session_id: "s1".into(),
                label: LABEL.into(),
                items: vec![
                    post_item("Wdrożyć na produkcję?", &["tak", "nie"]),
                    post_item("Które środowisko?", &["prod", "dev"]),
                ],
                approvals: vec![PostApproval {
                    approval_id: approval.id.clone(),
                    action: approval.action.clone(),
                    code: approval.code.clone(),
                }],
            }],
        });
        assert_eq!(planned.messages.len(), 1);
        let message = planned.messages[0];
        registry.confirm_posted(message, POSTED_ID.into());
        Fixture {
            effects,
            core,
            registry,
            message,
            approval,
        }
    }

    impl Fixture {
        fn view(&self) -> MessageView {
            self.registry.view(self.message).unwrap()
        }

        fn item_id(&self, key: &str) -> String {
            self.view()
                .blocks
                .iter()
                .flat_map(|block| block.items.iter())
                .find(|item| item.key == key)
                .unwrap()
                .item_id
                .clone()
        }

        fn item_state(&self, key: &str) -> ItemState {
            self.view()
                .blocks
                .iter()
                .flat_map(|block| block.items.iter())
                .find(|item| item.key == key)
                .unwrap()
                .state
                .clone()
        }

        fn approval_mark(&self) -> ApprovalMark {
            self.view().blocks[0].approvals[0].mark
        }

        fn approve_id(&self) -> String {
            format!("abeon:a:{}:y", self.approval.id)
        }

        fn reject_id(&self) -> String {
            format!("abeon:a:{}:n", self.approval.id)
        }

        fn option_id(&self, key: &str, index: usize) -> String {
            format!("abeon:q:{}:{index}", self.item_id(key))
        }

        fn click(&self, user_id: &str, custom_id: &str) -> Interaction {
            Interaction {
                id: "i-1".into(),
                token: TOKEN.into(),
                user_id: user_id.into(),
                custom_id: custom_id.into(),
                message_id: POSTED_ID.into(),
                message_components: render(&self.view())["components"].clone(),
            }
        }

        fn press(&mut self, interaction: &Interaction) -> InteractionOutcome {
            decide(
                interaction,
                &[OWNER.to_string()],
                &mut self.registry,
                &self.core,
            )
        }

        fn status(&self) -> ApprovalState {
            self.core.approval_status(&self.approval.id).unwrap().status
        }

        fn settled_syncs(&self) -> Vec<DiscordSync> {
            self.effects
                .discord_syncs()
                .into_iter()
                .filter(|change| matches!(change, DiscordSync::ApprovalSettled { .. }))
                .collect()
        }
    }

    fn strings(value: &Value, field: &str) -> Vec<String> {
        let mut found = Vec::new();
        collect(value, field, &mut found);
        found
    }

    fn collect(value: &Value, field: &str, found: &mut Vec<String>) {
        match value {
            Value::Array(list) => list.iter().for_each(|entry| collect(entry, field, found)),
            Value::Object(map) => {
                if let Some(text) = map.get(field).and_then(Value::as_str) {
                    found.push(text.to_string());
                }
                map.values().for_each(|entry| collect(entry, field, found));
            }
            _ => {}
        }
    }

    fn updated(reply: &InteractionReply) -> &Value {
        match reply {
            InteractionReply::Update(payload) => payload,
            other => panic!("expected an update, got {other:?}"),
        }
    }

    fn resolutions(events: &[SupervisorEvent]) -> usize {
        events
            .iter()
            .filter(|event| matches!(event, SupervisorEvent::ApprovalResolved { .. }))
            .count()
    }

    #[tokio::test(start_paused = true)]
    async fn a_click_from_another_account_is_refused() {
        let mut fixture = fixture().await;
        let before = fixture.view();
        let approve = fixture.click(STRANGER, &fixture.approve_id());
        let outcome = fixture.press(&approve);
        assert_eq!(outcome.reply, InteractionReply::Ephemeral(NOT_ALLOWED));
        assert_eq!(outcome.answer, None);
        let option = fixture.click(STRANGER, &fixture.option_id("P1", 0));
        let outcome = fixture.press(&option);
        assert_eq!(outcome.reply, InteractionReply::Ephemeral(NOT_ALLOWED));
        assert_eq!(outcome.answer, None);
        assert_eq!(fixture.status(), ApprovalState::Pending);
        assert_eq!(fixture.view(), before);
        assert_eq!(fixture.effects.kinds(), vec![decision_kind::GUARD_BLOCKED]);
        assert!(fixture.settled_syncs().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn an_empty_allow_list_refuses_everyone() {
        let mut fixture = fixture().await;
        let before = fixture.view();
        for user_id in [OWNER, STRANGER, ""] {
            let interaction = fixture.click(user_id, &fixture.approve_id());
            let outcome = decide(&interaction, &[], &mut fixture.registry, &fixture.core);
            assert_eq!(outcome.reply, InteractionReply::Ephemeral(NOT_ALLOWED));
            assert_eq!(outcome.answer, None);
        }
        assert_eq!(fixture.status(), ApprovalState::Pending);
        assert_eq!(fixture.view(), before);
        assert_eq!(fixture.effects.kinds(), vec![decision_kind::GUARD_BLOCKED]);
    }

    fn old_message_click(user_id: &str, custom_id: &str) -> Interaction {
        Interaction {
            id: "i-1".into(),
            token: TOKEN.into(),
            user_id: user_id.into(),
            custom_id: custom_id.into(),
            message_id: "d-old".into(),
            message_components: json!([{"type": 17, "components": [
                {"type": 10, "content": "**P9** Stare pytanie?"},
                {"type": 1, "components": [
                    {"type": 2, "style": 2, "label": "tak", "custom_id": custom_id},
                    {"type": 2, "style": 2, "label": "nie", "custom_id": "abeon:q:00000000:1"},
                ]},
            ]}]),
        }
    }

    fn stale_row() -> InteractionReply {
        InteractionReply::Update(json!({
            "flags": 32768,
            "allowed_mentions": {"parse": []},
            "components": [{"type": 17, "components": [
                {"type": 10, "content": "**P9** Stare pytanie?"},
                {"type": 10, "content": STALE_TEXT},
            ]}],
        }))
    }

    #[tokio::test(start_paused = true)]
    async fn an_unknown_button_gets_the_stale_row() {
        let mut fixture = fixture().await;
        let before = fixture.view();
        let outcome = fixture.press(&old_message_click(OWNER, "abeon:q:00000000:0"));
        assert_eq!(outcome.reply, stale_row());
        assert_eq!(outcome.answer, None);
        assert_eq!(fixture.view(), before);
    }

    #[tokio::test(start_paused = true)]
    async fn a_button_of_another_component_gets_the_stale_row() {
        let mut fixture = fixture().await;
        let before = fixture.view();
        let outcome = fixture.press(&old_message_click(OWNER, "perm:allow:abcde"));
        assert_eq!(outcome.reply, stale_row());
        assert_eq!(outcome.answer, None);
        assert_eq!(fixture.view(), before);
        assert_eq!(fixture.status(), ApprovalState::Pending);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stranger_clicking_an_unknown_button_is_refused() {
        let mut fixture = fixture().await;
        let outcome = fixture.press(&old_message_click(STRANGER, "abeon:q:00000000:0"));
        assert_eq!(outcome.reply, InteractionReply::Ephemeral(NOT_ALLOWED));
        assert_eq!(outcome.answer, None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stale_option_click_with_the_supervisor_off_gets_the_stale_row() {
        let mut fixture = fixture().await;
        fixture.effects.settings.lock().level = SupervisorLevel::Off;
        let before = fixture.view();
        let outcome = fixture.press(&old_message_click(OWNER, "abeon:q:00000000:0"));
        assert_eq!(outcome.reply, stale_row());
        assert_eq!(outcome.answer, None);

        let custom_id = fixture.option_id("P1", 0);
        let moved = Interaction {
            message_id: "d-other".into(),
            ..fixture.click(OWNER, &custom_id)
        };
        let outcome = fixture.press(&moved);
        assert_eq!(
            outcome.reply,
            InteractionReply::Update(json!({
                "flags": 32768,
                "allowed_mentions": {"parse": []},
                "components": replace_row(&moved.message_components, &custom_id, STALE_TEXT),
            }))
        );
        assert_eq!(outcome.answer, None);
        assert_eq!(fixture.item_state("P1"), ItemState::Open);
        assert_eq!(fixture.view(), before);
    }

    #[tokio::test(start_paused = true)]
    async fn an_out_of_range_option_rerenders_without_an_answer() {
        let mut fixture = fixture().await;
        let before = fixture.view();
        let interaction = fixture.click(OWNER, &fixture.option_id("P1", 9));
        let outcome = fixture.press(&interaction);
        assert_eq!(outcome.reply, InteractionReply::Update(render(&before)));
        assert_eq!(outcome.answer, None);
        assert_eq!(fixture.item_state("P1"), ItemState::Open);
        assert_eq!(fixture.view(), before);
    }

    #[tokio::test(start_paused = true)]
    async fn a_click_on_a_message_with_a_different_discord_id_is_stale() {
        let mut fixture = fixture().await;
        let before = fixture.view();
        for custom_id in [fixture.approve_id(), fixture.option_id("P1", 0)] {
            let interaction = Interaction {
                message_id: "d-other".into(),
                ..fixture.click(OWNER, &custom_id)
            };
            let outcome = fixture.press(&interaction);
            let expected = json!({
                "flags": 32768,
                "allowed_mentions": {"parse": []},
                "components": replace_row(&interaction.message_components, &custom_id, STALE_TEXT),
            });
            assert_eq!(outcome.reply, InteractionReply::Update(expected.clone()));
            assert!(strings(&expected, "content").contains(&STALE_TEXT.to_string()));
            assert!(!strings(&expected, "custom_id").contains(&custom_id));
            assert_eq!(outcome.answer, None);
        }
        assert_eq!(fixture.status(), ApprovalState::Pending);
        assert_eq!(fixture.item_state("P1"), ItemState::Open);
        assert_eq!(fixture.view(), before);
        assert_eq!(fixture.effects.kinds(), vec![decision_kind::GUARD_BLOCKED]);
    }

    #[tokio::test(start_paused = true)]
    async fn approve_click_resolves_the_approval_and_shows_the_outcome() {
        let mut fixture = fixture().await;
        let interaction = fixture.click(OWNER, &fixture.approve_id());
        let outcome = fixture.press(&interaction);
        assert_eq!(outcome.answer, None);
        assert_eq!(fixture.status(), ApprovalState::Approved);
        {
            let decisions = fixture.effects.decisions.lock();
            let last = decisions.last().unwrap();
            assert_eq!(last.kind, decision_kind::APPROVED);
            assert_eq!(last.rationale, "Decyzja użytkownika na Discordzie");
        }
        assert_eq!(fixture.approval_mark(), ApprovalMark::Approved);
        let payload = updated(&outcome.reply);
        assert_eq!(payload, &render(&fixture.view()));
        assert_eq!(payload["flags"], json!(32768));
        assert_eq!(payload["allowed_mentions"], json!({"parse": []}));
        assert!(strings(payload, "content").contains(&"✅ Zatwierdzono".to_string()));
        let custom_ids = strings(payload, "custom_id");
        assert!(!custom_ids.contains(&fixture.approve_id()));
        assert!(!custom_ids.contains(&fixture.reject_id()));
        assert!(custom_ids.contains(&fixture.option_id("P1", 0)));
        assert!(!callback_payload(&outcome.reply).to_string().contains(TOKEN));
        assert_eq!(
            fixture.settled_syncs(),
            vec![DiscordSync::ApprovalSettled {
                approval_id: fixture.approval.id.clone(),
                state: ApprovalState::Approved,
            }]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn reject_click_rejects() {
        let mut fixture = fixture().await;
        let interaction = fixture.click(OWNER, &fixture.reject_id());
        let outcome = fixture.press(&interaction);
        assert_eq!(outcome.answer, None);
        assert_eq!(fixture.status(), ApprovalState::Rejected);
        {
            let decisions = fixture.effects.decisions.lock();
            let last = decisions.last().unwrap();
            assert_eq!(last.kind, decision_kind::REJECTED);
            assert_eq!(last.rationale, "Decyzja użytkownika na Discordzie");
        }
        assert_eq!(fixture.approval_mark(), ApprovalMark::Rejected);
        let payload = updated(&outcome.reply);
        assert_eq!(payload, &render(&fixture.view()));
        let texts = strings(payload, "content");
        assert!(texts.contains(&"❌ Odrzucono".to_string()));
        assert!(!texts.contains(&"✅ Zatwierdzono".to_string()));
        let custom_ids = strings(payload, "custom_id");
        assert!(!custom_ids.contains(&fixture.approve_id()));
        assert!(!custom_ids.contains(&fixture.reject_id()));
    }

    #[tokio::test(start_paused = true)]
    async fn click_on_an_already_rejected_approval_shows_its_state() {
        let mut fixture = fixture().await;
        fixture
            .core
            .resolve_approval(&fixture.approval.id, false, ApprovalSource::App)
            .unwrap();
        assert_eq!(fixture.approval_mark(), ApprovalMark::Pending);
        let decisions_before = fixture.effects.kinds();
        let interaction = fixture.click(OWNER, &fixture.approve_id());
        let outcome = fixture.press(&interaction);
        assert_eq!(outcome.answer, None);
        assert_eq!(fixture.status(), ApprovalState::Rejected);
        assert_eq!(fixture.approval_mark(), ApprovalMark::Rejected);
        let payload = updated(&outcome.reply);
        assert_eq!(payload, &render(&fixture.view()));
        let texts = strings(payload, "content");
        assert!(texts.contains(&"❌ Odrzucono".to_string()));
        assert!(!texts.contains(&"✅ Zatwierdzono".to_string()));
        assert!(!strings(payload, "custom_id").contains(&fixture.approve_id()));

        let again = fixture.press(&interaction);
        assert_eq!(again.reply, outcome.reply);
        assert_eq!(fixture.status(), ApprovalState::Rejected);
        assert_eq!(fixture.effects.kinds(), decisions_before);
        assert_eq!(
            fixture.effects.decisions.lock().last().unwrap().rationale,
            "Decyzja użytkownika"
        );
        assert_eq!(resolutions(&fixture.core.take_events()), 1);
        assert_eq!(
            fixture.settled_syncs(),
            vec![DiscordSync::ApprovalSettled {
                approval_id: fixture.approval.id.clone(),
                state: ApprovalState::Rejected,
            }]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn an_approval_unknown_to_the_core_shows_as_expired() {
        let mut fixture = fixture().await;
        let planned = fixture.registry.plan_post(PostRequest {
            blocks: vec![PostBlock {
                session_id: "s1".into(),
                label: LABEL.into(),
                items: vec![],
                approvals: vec![PostApproval {
                    approval_id: "ap-missing".into(),
                    action: "task release".into(),
                    code: "K7QX".into(),
                }],
            }],
        });
        let message = planned.messages[0];
        fixture.registry.confirm_posted(message, "d-2".into());
        let interaction = Interaction {
            id: "i-2".into(),
            token: TOKEN.into(),
            user_id: OWNER.into(),
            custom_id: "abeon:a:ap-missing:y".into(),
            message_id: "d-2".into(),
            message_components: render(&fixture.registry.view(message).unwrap())["components"]
                .clone(),
        };
        let outcome = fixture.press(&interaction);
        let view = fixture.registry.view(message).unwrap();
        assert_eq!(view.blocks[0].approvals[0].mark, ApprovalMark::Expired);
        assert_eq!(outcome.reply, InteractionReply::Update(render(&view)));
        assert!(strings(updated(&outcome.reply), "content").contains(&"⌛ Wygasło".to_string()));
        assert_eq!(fixture.status(), ApprovalState::Pending);
        assert_eq!(fixture.effects.kinds(), vec![decision_kind::GUARD_BLOCKED]);
    }

    #[tokio::test(start_paused = true)]
    async fn option_click_returns_the_answer_with_open_keys() {
        let mut fixture = fixture().await;
        let custom_id = fixture.option_id("P1", 0);
        let interaction = fixture.click(OWNER, &custom_id);
        let outcome = fixture.press(&interaction);
        assert_eq!(
            outcome.answer,
            Some(ClickedOption {
                question_id: "q1".into(),
                session_id: "s1".into(),
                label: LABEL.into(),
                key: "P1".into(),
                question: "Wdrożyć na produkcję?".into(),
                value: "tak".into(),
                open_keys: vec!["P2".into()],
            })
        );
        assert_eq!(fixture.item_state("P1"), ItemState::Clicked("tak".into()));
        assert_eq!(fixture.item_state("P2"), ItemState::Open);
        let payload = updated(&outcome.reply);
        assert_eq!(payload, &render(&fixture.view()));
        assert!(strings(payload, "content").contains(&"✅ P1: tak".to_string()));
        let custom_ids = strings(payload, "custom_id");
        assert!(!custom_ids.contains(&custom_id));
        assert!(custom_ids.contains(&fixture.option_id("P2", 0)));
        assert_eq!(fixture.status(), ApprovalState::Pending);
        assert!(!fixture
            .core
            .take_events()
            .iter()
            .any(|event| matches!(event, SupervisorEvent::DiscordAnswer { .. })));
    }

    #[tokio::test(start_paused = true)]
    async fn option_click_is_refused_while_the_supervisor_is_off() {
        let mut fixture = fixture().await;
        fixture.effects.settings.lock().level = SupervisorLevel::Off;
        let before = fixture.view();
        let interaction = fixture.click(OWNER, &fixture.option_id("P1", 0));
        let outcome = fixture.press(&interaction);
        assert_eq!(outcome.reply, InteractionReply::Ephemeral(SUPERVISOR_OFF));
        assert_eq!(outcome.answer, None);
        assert_eq!(fixture.item_state("P1"), ItemState::Open);
        assert_eq!(fixture.view(), before);

        fixture.effects.settings.lock().level = SupervisorLevel::Assistant;
        let later = fixture.press(&interaction);
        assert_eq!(later.answer.map(|answer| answer.value), Some("tak".into()));
        assert_eq!(fixture.item_state("P1"), ItemState::Clicked("tak".into()));
    }

    #[tokio::test(start_paused = true)]
    async fn a_second_click_on_the_same_item_has_no_answer() {
        let mut fixture = fixture().await;
        let first = fixture.click(OWNER, &fixture.option_id("P1", 0));
        let second = Interaction {
            custom_id: fixture.option_id("P1", 1),
            ..first.clone()
        };
        assert!(fixture.press(&first).answer.is_some());
        let outcome = fixture.press(&second);
        assert_eq!(outcome.answer, None);
        assert_eq!(fixture.item_state("P1"), ItemState::Clicked("tak".into()));
        let payload = updated(&outcome.reply);
        assert_eq!(payload, &render(&fixture.view()));
        let texts = strings(payload, "content");
        assert!(texts.contains(&"✅ P1: tak".to_string()));
        assert!(!texts.contains(&"✅ P1: nie".to_string()));
        assert_eq!(fixture.press(&first).answer, None);
    }

    #[test]
    fn callback_payload_shapes() {
        let payload = json!({"flags": 32768, "allowed_mentions": {"parse": []}, "components": []});
        assert_eq!(
            callback_payload(&InteractionReply::Update(payload.clone())),
            json!({"type": 7, "data": payload})
        );
        assert_eq!(
            callback_payload(&InteractionReply::Ephemeral(NOT_ALLOWED)),
            json!({"type": 4, "data": {
                "content": "Brak uprawnień.",
                "flags": 64,
                "allowed_mentions": {"parse": []},
            }})
        );
        assert_eq!(
            callback_payload(&InteractionReply::Ephemeral(SUPERVISOR_OFF)),
            json!({"type": 4, "data": {
                "content": "Agent sterujący jest wyłączony — odpowiedz w aplikacji.",
                "flags": 64,
                "allowed_mentions": {"parse": []},
            }})
        );
    }
}

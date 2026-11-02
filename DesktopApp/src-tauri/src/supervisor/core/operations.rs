use super::{
    decision_kind, excerpt, now, single_line, DiscordSync, Outbox, SessionListing, SupervisorCore,
    ANSWER_PREFIX, SUMMARY_CHARS,
};
use crate::db::supervisor_decisions_repo::NewDecision;
use crate::domain::supervisor::EscalationChannel;
use crate::sessions::reader::now_ms;
use crate::supervisor::discord::registry::{
    KeyAnswer, PostBlock, PostItem, PostRequest, PostResult,
};

const RATIONALE_RELAY: &str = "Wiadomość od agenta sterującego";
const ERROR_EMPTY_MESSAGE: &str = "Wiadomość wymaga niepustego pola text";
const ERROR_NO_TERMINAL: &str = "Sesja nie ma otwartego terminala w AbeonCode";
const ERROR_SESSION_BUSY: &str = "Sesja nie czeka na wiadomość — agent w niej pracuje";
const ERROR_EMPTY_SUMMARY: &str = "Eskalacja wymaga niepustego pola summary";
const ERROR_NO_QUESTIONS: &str = "Eskalacja wymaga co najmniej jednego pytania w question_ids";
const ERROR_NOT_ESCALATABLE: &str =
    "Te pytania nie są otwarte albo nie zostały przekazane agentowi";
const ERROR_EMPTY_FIELD: &str = "Pole nie może być puste";
const ERROR_DISCORD_INACTIVE: &str = "Discord nie jest aktywny — eskalacje pokazuje aplikacja";
const ERROR_NOTHING_TO_POST: &str = "Nie ma czego wysłać";
const ERROR_EMPTY_QUESTION: &str = "Pusta treść pytania";
const ERROR_QUESTION_TOO_LONG: &str = "Treść pytania może mieć najwyżej 300 znaków";
const ERROR_CONTEXT_TOO_LONG: &str = "Kontekst może mieć najwyżej 300 znaków";
const ERROR_TOO_MANY_OPTIONS: &str = "Pytanie może mieć najwyżej 5 opcji z przyciskami";
const ERROR_OPTION_LENGTH: &str = "Opcja przycisku musi mieć od 1 do 25 znaków";
const MAX_QUESTION_CHARS: usize = 300;
const MAX_CONTEXT_CHARS: usize = 300;
const MAX_OPTIONS: usize = 5;
const MAX_OPTION_CHARS: usize = 25;

#[derive(Clone, Debug, PartialEq)]
pub struct EscalateOutcome {
    pub skipped: Vec<String>,
    pub channel: EscalationChannel,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DiscordPostItemInput {
    pub question_id: String,
    pub question: String,
    pub options: Vec<String>,
    pub text_options: Vec<String>,
    pub context: Option<String>,
}

fn post_item(input: DiscordPostItemInput) -> Result<PostItem, String> {
    let question = input.question.trim();
    if question.is_empty() {
        return Err(ERROR_EMPTY_QUESTION.to_string());
    }
    if question.chars().count() > MAX_QUESTION_CHARS {
        return Err(ERROR_QUESTION_TOO_LONG.to_string());
    }
    let context = input
        .context
        .as_deref()
        .map(str::trim)
        .filter(|context| !context.is_empty());
    if context.is_some_and(|context| context.chars().count() > MAX_CONTEXT_CHARS) {
        return Err(ERROR_CONTEXT_TOO_LONG.to_string());
    }
    if input.options.len() > MAX_OPTIONS {
        return Err(ERROR_TOO_MANY_OPTIONS.to_string());
    }
    let options: Vec<String> = input
        .options
        .iter()
        .map(|option| option.trim().to_string())
        .collect();
    if options
        .iter()
        .any(|option| option.is_empty() || option.chars().count() > MAX_OPTION_CHARS)
    {
        return Err(ERROR_OPTION_LENGTH.to_string());
    }
    Ok(PostItem {
        question_id: input.question_id,
        question: question.to_string(),
        options,
        text_options: input.text_options,
        context: context.map(str::to_string),
    })
}

fn session_block<'a>(
    blocks: &'a mut Vec<PostBlock>,
    session_id: &str,
    label: &str,
) -> &'a mut PostBlock {
    let index = match blocks
        .iter()
        .position(|block| block.session_id == session_id)
    {
        Some(index) => index,
        None => {
            blocks.push(PostBlock {
                session_id: session_id.to_string(),
                label: label.to_string(),
                items: Vec::new(),
                approvals: Vec::new(),
            });
            blocks.len() - 1
        }
    };
    &mut blocks[index]
}

impl SupervisorCore {
    pub fn escalate(
        &self,
        question_ids: &[String],
        summary: &str,
    ) -> Result<EscalateOutcome, String> {
        let summary = summary.trim();
        if summary.is_empty() {
            return Err(ERROR_EMPTY_SUMMARY.to_string());
        }
        let mut unique: Vec<&str> = Vec::new();
        for question_id in question_ids {
            if !unique.contains(&question_id.as_str()) {
                unique.push(question_id);
            }
        }
        if unique.is_empty() {
            return Err(ERROR_NO_QUESTIONS.to_string());
        }
        let settings = self.effects.settings();
        let now = now();
        let mut outbox = Outbox::default();
        let mut skipped = Vec::new();
        let mut channel = None;
        {
            let mut state = self.state.lock();
            for question_id in unique {
                let handed = state
                    .questions
                    .iter()
                    .any(|question| question.id == question_id && question.with_supervisor());
                let question = if handed {
                    state.take_question(question_id)
                } else {
                    None
                };
                let Some(question) = question else {
                    skipped.push(question_id.to_string());
                    continue;
                };
                state.discard_queued_question(question_id);
                let escalation = state.escalate_question(
                    question,
                    summary.to_string(),
                    summary,
                    &settings,
                    now,
                    &mut outbox,
                );
                channel = Some(escalation.channel);
            }
        }
        let Some(channel) = channel else {
            return Err(format!("{ERROR_NOT_ESCALATABLE}: {}", skipped.join(", ")));
        };
        self.flush(outbox);
        self.publish_with(&settings);
        Ok(EscalateOutcome { skipped, channel })
    }

    pub fn send_to_session(&self, session_id: &str, text: &str) -> Result<(), String> {
        let text = single_line(text);
        if text.is_empty() {
            return Err(ERROR_EMPTY_MESSAGE.to_string());
        }
        let info = self
            .effects
            .session_info(session_id)
            .filter(|info| info.pty_id.is_some())
            .ok_or_else(|| ERROR_NO_TERMINAL.to_string())?;
        {
            let mut state = self.state.lock();
            if !state.at_prompt(session_id) {
                return Err(ERROR_SESSION_BUSY.to_string());
            }
            state.queue_injection(session_id, &format!("{ANSWER_PREFIX}{text}"));
        }
        self.effects.log_decision(NewDecision {
            created_at: now_ms(),
            session_id: Some(session_id.to_string()),
            kind: decision_kind::RELAYED,
            question: info.label,
            decision: text,
            rationale: RATIONALE_RELAY.to_string(),
        });
        self.effects.discord_sync(DiscordSync::SessionSettled {
            session_id: session_id.to_string(),
        });
        Ok(())
    }

    pub fn open_session(
        &self,
        project_path: &str,
        prompt: &str,
        rationale: &str,
    ) -> Result<(), String> {
        for (name, value) in [
            ("project_path", project_path),
            ("prompt", prompt),
            ("rationale", rationale),
        ] {
            if value.trim().is_empty() {
                return Err(format!("{ERROR_EMPTY_FIELD}: {name}"));
            }
        }
        self.effects.open_session(project_path, prompt)?;
        self.effects.log_decision(NewDecision {
            created_at: now_ms(),
            session_id: None,
            kind: decision_kind::SESSION_OPENED,
            question: project_path.to_string(),
            decision: excerpt(prompt, SUMMARY_CHARS),
            rationale: rationale.trim().to_string(),
        });
        Ok(())
    }

    pub fn list_sessions(&self) -> Vec<SessionListing> {
        let mut listings = self.effects.list_sessions();
        let state = self.state.lock();
        for listing in &mut listings {
            listing.pending_question_id = state
                .questions
                .iter()
                .find(|question| {
                    question.session_id == listing.session_id && question.with_supervisor()
                })
                .map(|question| question.id.clone());
        }
        listings
    }

    pub fn read_session(&self, session_id: &str, max_blocks: usize) -> Option<String> {
        self.effects.read_session(session_id, max_blocks)
    }

    pub fn discord_post(
        &self,
        items: Vec<DiscordPostItemInput>,
        approval_ids: Vec<String>,
    ) -> Result<PostResult, String> {
        let settings = self.effects.settings();
        let now = now();
        let request = {
            let state = self.state.lock();
            if !state.discord_active || settings.discord_chat_id.is_none() {
                return Err(ERROR_DISCORD_INACTIVE.to_string());
            }
            if items.is_empty() && approval_ids.is_empty() {
                return Err(ERROR_NOTHING_TO_POST.to_string());
            }
            let mut blocks = Vec::new();
            for input in items {
                let escalation = state
                    .escalations
                    .iter()
                    .find(|escalation| {
                        escalation.question_id == input.question_id
                            && escalation.channel == EscalationChannel::Discord
                    })
                    .ok_or_else(|| {
                        format!(
                            "Pytanie {} nie jest przekazane na Discorda",
                            input.question_id
                        )
                    })?;
                let item = post_item(input)?;
                session_block(&mut blocks, &escalation.session_id, &escalation.label)
                    .items
                    .push(item);
            }
            for approval_id in approval_ids {
                let (session_id, label, approval) =
                    state.discord_approval(&approval_id, now).ok_or_else(|| {
                        format!("Prośba o zgodę {approval_id} nie czeka na decyzję na Discordzie")
                    })?;
                session_block(&mut blocks, &session_id, &label)
                    .approvals
                    .push(approval);
            }
            PostRequest { blocks }
        };
        self.effects.discord_post(request)
    }

    pub fn discord_answered(&self, answers: Vec<KeyAnswer>) -> Result<Vec<String>, String> {
        self.effects.discord_answered(answers)
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::supervisor::discord::registry::{
        KeyAnswer, PostApproval, PostBlock, PostItem, PostRequest, PostResult, PostedKey,
    };
    use crate::supervisor::test_support::*;
    use tokio::time::advance;

    const SUMMARY: &str = "Wariant wybiera użytkownik";
    const INACTIVE: &str = "Discord nie jest aktywny — eskalacje pokazuje aplikacja";
    const OPTION_LENGTH: &str = "Opcja przycisku musi mieć od 1 do 25 znaków";

    fn item(question_id: &str, question: &str, options: &[&str]) -> DiscordPostItemInput {
        DiscordPostItemInput {
            question_id: question_id.to_string(),
            question: question.to_string(),
            options: options.iter().map(|option| option.to_string()).collect(),
            text_options: Vec::new(),
            context: None,
        }
    }

    fn not_routed(question_id: &str) -> String {
        format!("Pytanie {question_id} nie jest przekazane na Discorda")
    }

    fn not_waiting(approval_id: &str) -> String {
        format!("Prośba o zgodę {approval_id} nie czeka na decyzję na Discordzie")
    }

    fn discord_ready() -> (Arc<FakeEffects>, Arc<SupervisorCore>) {
        let (effects, core) = setup();
        link_discord(&effects);
        core.set_discord_active(true);
        core.set_away(true);
        (effects, core)
    }

    async fn discord_escalation(core: &Arc<SupervisorCore>, session_id: &str) -> String {
        core.on_session_hook(stop(session_id, "Który wariant wybrać?"))
            .await;
        let question_id = only_question_id(core.take_events());
        let outcome = core.escalate(&[question_id.clone()], SUMMARY).unwrap();
        assert_eq!(outcome.channel, EscalationChannel::Discord);
        question_id
    }

    #[tokio::test(start_paused = true)]
    async fn discord_post_requires_an_active_discord() {
        let (effects, core) = setup();
        let items = || vec![item("q1", "Który wariant?", &["A", "B"])];
        assert_eq!(
            core.discord_post(items(), Vec::new()).unwrap_err(),
            INACTIVE
        );
        assert_eq!(
            core.discord_post(Vec::new(), Vec::new()).unwrap_err(),
            INACTIVE
        );
        core.set_discord_active(true);
        assert_eq!(
            core.discord_post(items(), Vec::new()).unwrap_err(),
            INACTIVE
        );
        link_discord(&effects);
        core.set_discord_active(false);
        assert_eq!(
            core.discord_post(items(), Vec::new()).unwrap_err(),
            INACTIVE
        );
        core.set_discord_active(true);
        assert_eq!(
            core.discord_post(Vec::new(), Vec::new()).unwrap_err(),
            "Nie ma czego wysłać"
        );
        assert!(effects.discord_posts.lock().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn discord_post_rejects_questions_not_routed_to_discord() {
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        link_discord(&effects);
        core.set_discord_active(true);
        core.report_activity(None);
        core.on_session_hook(stop("s1", "Który wariant wybrać?"))
            .await;
        advance(61 * SECOND).await;
        core.tick();
        let question_id = only_question_id(core.take_events());
        let outcome = core.escalate(&[question_id.clone()], SUMMARY).unwrap();
        assert_eq!(outcome.channel, EscalationChannel::App);
        core.on_session_hook(bash("s2", "git push")).await;
        let approval_id = core.snapshot().approvals[0].id.clone();
        let question = || item(&question_id, "Który wariant?", &["A", "B"]);
        assert_eq!(
            core.discord_post(vec![question()], Vec::new()).unwrap_err(),
            not_routed(&question_id)
        );
        assert_eq!(
            core.discord_post(vec![item("nope", "Który wariant?", &[])], Vec::new())
                .unwrap_err(),
            not_routed("nope")
        );
        assert_eq!(
            core.discord_post(Vec::new(), vec![approval_id.clone()])
                .unwrap_err(),
            not_waiting(&approval_id)
        );
        assert_eq!(
            core.discord_post(Vec::new(), vec!["missing".into()])
                .unwrap_err(),
            not_waiting("missing")
        );
        core.set_away(true);
        core.take_events();
        core.resolve_approval(&approval_id, true, ApprovalSource::App)
            .unwrap();
        assert_eq!(
            core.discord_post(vec![question()], vec![approval_id.clone()])
                .unwrap_err(),
            not_waiting(&approval_id)
        );
        assert!(effects.discord_posts.lock().is_empty());
        assert!(core.discord_post(vec![question()], Vec::new()).is_ok());
        assert_eq!(effects.discord_posts.lock().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn discord_post_rejects_too_many_or_too_long_options() {
        let (effects, core) = discord_ready();
        let question_id = discord_escalation(&core, "s1").await;
        let base = || item(&question_id, "Który wariant?", &["A"]);
        let error_of =
            |input: DiscordPostItemInput| core.discord_post(vec![input], Vec::new()).unwrap_err();
        assert_eq!(
            error_of(DiscordPostItemInput {
                question: " \n ".into(),
                ..base()
            }),
            "Pusta treść pytania"
        );
        assert_eq!(
            error_of(DiscordPostItemInput {
                question: "ż".repeat(301),
                options: vec!["A".into(); 6],
                ..base()
            }),
            "Treść pytania może mieć najwyżej 300 znaków"
        );
        assert_eq!(
            error_of(DiscordPostItemInput {
                context: Some("ż".repeat(301)),
                ..base()
            }),
            "Kontekst może mieć najwyżej 300 znaków"
        );
        assert_eq!(
            error_of(item(&question_id, "Q", &["1", "2", "3", "4", "5", "6"])),
            "Pytanie może mieć najwyżej 5 opcji z przyciskami"
        );
        assert_eq!(
            error_of(item(&question_id, "Q", &["a".repeat(26).as_str()])),
            OPTION_LENGTH
        );
        assert_eq!(
            error_of(item(&question_id, "Q", &["tak", "  "])),
            OPTION_LENGTH
        );
        assert_eq!(
            core.discord_post(
                vec![base(), item(&question_id, "Q", &["x".repeat(26).as_str()])],
                Vec::new()
            )
            .unwrap_err(),
            OPTION_LENGTH
        );
        assert!(effects.discord_posts.lock().is_empty());
        let longest = DiscordPostItemInput {
            question_id: question_id.clone(),
            question: "ż".repeat(300),
            options: vec!["ż".repeat(25); 5],
            text_options: vec!["a".repeat(400)],
            context: Some("ż".repeat(300)),
        };
        assert!(core.discord_post(vec![longest], Vec::new()).is_ok());
        let posts = effects.discord_posts.lock();
        assert_eq!(
            posts[0].blocks[0].items,
            vec![PostItem {
                question_id: question_id.clone(),
                question: "ż".repeat(300),
                options: vec!["ż".repeat(25); 5],
                text_options: vec!["a".repeat(400)],
                context: Some("ż".repeat(300)),
            }]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn discord_post_builds_blocks_with_labels_and_approval_codes() {
        let (effects, core) = discord_ready();
        *effects.branch.lock() = Some("main".into());
        let question_id = discord_escalation(&core, "s1").await;
        core.on_session_hook(bash("s2", "git push")).await;
        core.on_session_hook(bash("s1", "git push")).await;
        let approvals = core.snapshot().approvals;
        let approval_of = |session_id: &str| {
            approvals
                .iter()
                .find(|approval| approval.session_id == session_id)
                .unwrap()
                .clone()
        };
        let (first, second) = (approval_of("s1"), approval_of("s2"));
        for session_id in ["s1", "s2"] {
            effects.sessions.lock().get_mut(session_id).unwrap().label = "inna · etykieta".into();
        }
        core.discord_post(
            vec![
                item(
                    &question_id,
                    "Specyfikacja etapu 2: akceptujesz?",
                    &["tak", "nie"],
                ),
                DiscordPostItemInput {
                    text_options: vec!["uwagi".into()],
                    context: Some("Sesja przyjęła, że makiety zostają.".into()),
                    ..item(&question_id, "Uruchomić testy E2E?", &[])
                },
            ],
            vec![second.id.clone(), first.id.clone()],
        )
        .unwrap();
        assert_eq!(
            *effects.discord_posts.lock(),
            vec![PostRequest {
                blocks: vec![
                    PostBlock {
                        session_id: "s1".into(),
                        label: "projekt · s1".into(),
                        items: vec![
                            PostItem {
                                question_id: question_id.clone(),
                                question: "Specyfikacja etapu 2: akceptujesz?".into(),
                                options: vec!["tak".into(), "nie".into()],
                                text_options: Vec::new(),
                                context: None,
                            },
                            PostItem {
                                question_id: question_id.clone(),
                                question: "Uruchomić testy E2E?".into(),
                                options: Vec::new(),
                                text_options: vec!["uwagi".into()],
                                context: Some("Sesja przyjęła, że makiety zostają.".into()),
                            },
                        ],
                        approvals: vec![PostApproval {
                            approval_id: first.id.clone(),
                            action: "git push → main".into(),
                            code: first.code.clone(),
                        }],
                    },
                    PostBlock {
                        session_id: "s2".into(),
                        label: "projekt · s2".into(),
                        items: Vec::new(),
                        approvals: vec![PostApproval {
                            approval_id: second.id.clone(),
                            action: "git push → main".into(),
                            code: second.code.clone(),
                        }],
                    },
                ],
            }]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn discord_post_returns_the_effects_result() {
        let (effects, core) = discord_ready();
        let question_id = discord_escalation(&core, "s1").await;
        let post = || {
            core.discord_post(
                vec![item(&question_id, "Który wariant?", &["A"])],
                Vec::new(),
            )
        };
        let result = PostResult {
            posted: 1,
            keys: vec![PostedKey {
                question_id: question_id.clone(),
                question: "Który wariant?".into(),
                key: "P1".into(),
            }],
            skipped: vec!["q0".into()],
        };
        *effects.discord_post_result.lock() = Ok(result.clone());
        assert_eq!(post(), Ok(result));
        *effects.discord_post_result.lock() = Err("Discord nie odpowiada".into());
        assert_eq!(post(), Err("Discord nie odpowiada".to_string()));
        assert_eq!(effects.discord_posts.lock().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn discord_answered_passes_answers_and_returns_skipped() {
        let (effects, core) = setup();
        let answers = vec![
            KeyAnswer {
                key: "S1".into(),
                value: "tak".into(),
            },
            KeyAnswer {
                key: "S9".into(),
                value: "nie".into(),
            },
        ];
        *effects.discord_answered_skipped.lock() = Ok(vec!["S9".into()]);
        assert_eq!(
            core.discord_answered(answers.clone()),
            Ok(vec!["S9".to_string()])
        );
        assert_eq!(*effects.discord_answers.lock(), vec![answers.clone()]);
        *effects.discord_answered_skipped.lock() = Err("Discord jest niedostępny".into());
        assert_eq!(
            core.discord_answered(answers),
            Err("Discord jest niedostępny".to_string())
        );
    }

    #[tokio::test(start_paused = true)]
    async fn relay_into_escalated_session_clears_awaiting_user() {
        let (effects, core) = setup();
        core.set_away(true);
        let handle = spawn_menu(&core, "s1").await;
        let question_id = only_question_id(core.take_events());
        core.escalate(&[question_id], "Kolor wybiera użytkownik")
            .unwrap();
        assert!(matches!(reply_of(handle).await, HookReply::Deny { .. }));
        core.on_session_hook(stop("s1", "Czekam na decyzję użytkownika."))
            .await;
        assert!(core.take_events().is_empty());
        core.send_to_session("s1", "Użytkownik wybrał zielony")
            .unwrap();
        core.tick();
        assert_eq!(
            effects.typed(),
            vec![(
                "pty-s1".to_string(),
                "[agent sterujący] Użytkownik wybrał zielony\r".to_string()
            )]
        );
        core.on_session_hook(prompt("s1", "[agent sterujący] Użytkownik wybrał zielony"))
            .await;
        assert_eq!(
            core.state.lock().provenance.origin("s1"),
            PromptOrigin::Supervisor
        );
        assert_eq!(core.snapshot().escalations.len(), 1);
        core.on_session_hook(stop("s1", "Zrobione. Commitować?"))
            .await;
        assert_eq!(core.take_events().len(), 1);
        assert_eq!(
            effects.kinds(),
            vec![decision_kind::ESCALATED, decision_kind::RELAYED]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn any_prompt_closes_the_open_turn_end() {
        let (effects, core) = setup();
        core.set_away(true);
        core.on_session_hook(stop("s1", "Czy kontynuować?")).await;
        let seen = only_question_id(core.take_events());
        core.send_to_session("s1", "Najpierw uruchom testy")
            .unwrap();
        core.tick();
        core.on_session_hook(prompt("s1", "[agent sterujący] Najpierw uruchom testy"))
            .await;
        assert_eq!(
            core.take_events(),
            vec![SupervisorEvent::QuestionResolved {
                question_id: seen.clone(),
                by: ResolvedBy::User,
            }]
        );
        assert!(core
            .answer_question(&seen, Some("tak".into()), None, "x")
            .is_err());
        core.on_session_hook(stop("s1", "Testy przechodzą. Dalej?"))
            .await;
        core.send_to_session("s1", "Dalej").unwrap();
        core.tick();
        core.on_session_hook(prompt("s1", "[agent sterujący] Dalej"))
            .await;
        assert!(core.take_events().is_empty());
        assert_eq!(effects.typed().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn send_to_session_settles_the_session_on_discord() {
        let (effects, core) = setup();
        core.set_away(true);
        assert!(core.send_to_session("s1", "Dalej").is_err());
        assert!(effects.discord_syncs().is_empty());
        core.on_session_hook(stop("s1", "Czy kontynuować?")).await;
        core.send_to_session("s1", "Użytkownik wybrał wariant A")
            .unwrap();
        assert_eq!(
            effects.discord_syncs(),
            vec![DiscordSync::SessionSettled {
                session_id: "s1".into()
            }]
        );
    }
}

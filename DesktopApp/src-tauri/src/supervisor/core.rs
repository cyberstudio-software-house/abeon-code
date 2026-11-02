use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::commands::pty::MAX_INITIAL_PROMPT_BYTES;
use crate::db::supervisor_decisions_repo::NewDecision;
use crate::domain::supervisor::{
    CardPhase, EscalationChannel, EscalationView, MenuQuestion, QuestionCardView, SessionRebound,
    SupervisorLevel, SupervisorSnapshot,
};
use crate::pty::session_registry::SessionClaim;
use crate::sessions::reader::now_ms;
use crate::supervisor::approvals::ApprovalBook;
use crate::supervisor::discord::registry::ClickedOption;
use crate::supervisor::effects::{DiscordSync, Effects, SessionInfo, SessionListing};
use crate::supervisor::events::{ForwardedEscalation, QuestionKind, ResolvedBy, SupervisorEvent};
use crate::supervisor::hook_io::{menu_questions, HookInput, HookReply};
use crate::supervisor::presence::{route, Presence};
use crate::supervisor::provenance::{PromptEvidence, PromptOrigin, ProvenanceTracker};
use crate::supervisor::settings::SupervisorSettings;

mod operations;
mod production;

pub use operations::{DiscordPostItemInput, EscalateOutcome};
pub use production::{ApprovalSource, ApprovalState, ApprovalStatus};

pub const ESCALATED_REASON: &str =
    "Pytanie przekazane użytkownikowi — poczekaj na jego odpowiedź w kolejnej wiadomości.";
pub const ANSWER_PREFIX: &str = "[agent sterujący] ";
pub const GUARD_REASON: &str =
    "Ta operacja wymaga zgody użytkownika. Nie ponawiaj jej — agent sterujący poprosił użytkownika o zgodę. Nie obchodź tej blokady innym poleceniem ani skryptem.";
pub const QUIET_WINDOW: Duration = Duration::from_secs(5);
pub const SUBMIT_WINDOW: Duration = Duration::from_secs(10);
pub const WAKE_DEBOUNCE: Duration = Duration::from_secs(10);
pub const WAKE_RETRY: Duration = Duration::from_secs(120);
pub const DECISION_WINDOW: Duration = Duration::from_secs(120);
pub const MENU_HOLD_CAP: Duration = Duration::from_secs(570);
pub const MENU_SAFETY_TIMEOUT: Duration = Duration::from_secs(580);

pub mod decision_kind {
    pub const ANSWERED: &str = "answered";
    pub const RELAYED: &str = "relayed";
    pub const ESCALATED: &str = "escalated";
    pub const GUARD_BLOCKED: &str = "guard_blocked";
    pub const APPROVED: &str = "approved";
    pub const REJECTED: &str = "rejected";
    pub const SESSION_OPENED: &str = "session_opened";
    pub const RELEASED_TO_USER: &str = "released_to_user";
}

const ASK_USER_QUESTION: &str = "AskUserQuestion";
const SESSION_START: &str = "SessionStart";
const ELLIPSIS: char = '…';
const SUMMARY_CHARS: usize = 500;
const NOTIFICATION_CHARS: usize = 160;
const ESCALATION_TITLE: &str = "Agent sterujący: potrzebna Twoja decyzja";
const ATTENTION_MENU: &str = "Pytanie w sesji czeka na Twoją odpowiedź";
const ATTENTION_ESCALATION: &str = "Agent sterujący przekazał Ci pytanie";
const DECISION_ESCALATED: &str = "Przekazane użytkownikowi";
const DECISION_RELEASED: &str = "Pytanie oddane użytkownikowi";
const RATIONALE_DECISION_TIMEOUT: &str = "Agent nie podjął decyzji w ciągu 2 minut";
const RATIONALE_HOLD_CAP: &str = "Upłynął limit wstrzymania menu";
const RATIONALE_UNSEEN: &str = "Agent nie odebrał pytania w ciągu 2 minut";
const RATIONALE_CARD_RELEASE: &str = "Użytkownik wybrał odpowiedź w terminalu";
const RATIONALE_HUMAN_PROMPT: &str = "Użytkownik odpowiedział w sesji";
const RATIONALE_SESSION_REPLACED: &str = "W terminalu sesji działa teraz inna rozmowa";
const ERROR_UNKNOWN_QUESTION: &str = "Nie ma otwartego pytania o tym identyfikatorze";
const ERROR_IN_GRACE: &str = "Pytanie czeka jeszcze na odpowiedź użytkownika";
const ERROR_MISSING_ANSWERS: &str = "Odpowiedź na menu wymaga niepustego pola answers";
const ERROR_RELAY_LEVEL: &str = "Poziom Przekaźnik: agent nie podejmuje decyzji — użyj escalate.";
const ERROR_ANSWER_KEYS: &str = "Klucze answers muszą być dokładnie treściami pytań";
const ERROR_BLANK_ANSWER: &str = "Pusta odpowiedź na pytanie";
const ERROR_MISSING_TEXT: &str = "Odpowiedź wymaga niepustego pola text";
const ERROR_UNKNOWN_CARD: &str = "Nie ma karty pytania o tym identyfikatorze";
const ERROR_EMPTY_CARD_ANSWER: &str = "Wybierz odpowiedź";

fn now() -> Instant {
    tokio::time::Instant::now().into_std()
}

fn excerpt(text: &str, max_chars: usize) -> String {
    let text = text.trim();
    match text.char_indices().nth(max_chars) {
        Some((cut, _)) => format!("{}…", text[..cut].trim_end()),
        None => text.to_string(),
    }
}

fn single_line(text: &str) -> String {
    text.chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn cap_bytes(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.to_string();
    }
    let mut cut = max_bytes.saturating_sub(ELLIPSIS.len_utf8());
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{ELLIPSIS}", &text[..cut])
}

fn quoted_list<'a>(items: impl IntoIterator<Item = &'a str>) -> String {
    items
        .into_iter()
        .map(|item| format!("„{item}”"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn check_menu_answers(
    questions: &[MenuQuestion],
    answers: &HashMap<String, String>,
) -> Result<(), String> {
    let expected: BTreeSet<&str> = questions
        .iter()
        .map(|entry| entry.question.as_str())
        .collect();
    let given: BTreeSet<&str> = answers.keys().map(String::as_str).collect();
    if expected != given {
        let missing = quoted_list(expected.difference(&given).copied());
        let extra = quoted_list(given.difference(&expected).copied());
        return Err(format!(
            "{ERROR_ANSWER_KEYS}. Brakuje: [{missing}]. Nadmiarowe: [{extra}]"
        ));
    }
    let blank: BTreeSet<&str> = answers
        .iter()
        .filter(|(_, answer)| answer.trim().is_empty())
        .map(|(question, _)| question.as_str())
        .collect();
    if !blank.is_empty() {
        return Err(format!("{ERROR_BLANK_ANSWER}: {}", quoted_list(blank)));
    }
    Ok(())
}

fn forwarded_escalation(escalation: &EscalationView) -> ForwardedEscalation {
    ForwardedEscalation {
        session_id: escalation.session_id.clone(),
        question_id: escalation.question_id.clone(),
        label: escalation.label.clone(),
        summary: escalation.summary.clone(),
    }
}

fn describe_answers(answers: &HashMap<String, String>) -> String {
    answers
        .iter()
        .collect::<BTreeMap<_, _>>()
        .into_iter()
        .map(|(question, answer)| format!("{question}: {answer}"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[derive(Default)]
struct SessionState {
    at_prompt: bool,
    awaiting_user: bool,
}

enum Phase {
    Grace { deadline: Instant, deadline_ms: i64 },
    WithSupervisor { since: Instant },
}

enum QuestionBody {
    TurnEnded {
        text: String,
    },
    Menu {
        original: Value,
        questions: Vec<MenuQuestion>,
        reply: Option<oneshot::Sender<HookReply>>,
    },
}

struct Question {
    id: String,
    session_id: String,
    label: String,
    project_id: Option<i64>,
    created: Instant,
    pause_mark: Instant,
    phase: Phase,
    body: QuestionBody,
}

impl Question {
    fn is_menu(&self) -> bool {
        matches!(self.body, QuestionBody::Menu { .. })
    }

    fn with_supervisor(&self) -> bool {
        matches!(self.phase, Phase::WithSupervisor { .. })
    }

    fn summary(&self) -> String {
        match &self.body {
            QuestionBody::TurnEnded { text } => excerpt(text, SUMMARY_CHARS),
            QuestionBody::Menu { questions, .. } => {
                let texts: Vec<&str> = questions
                    .iter()
                    .map(|entry| entry.question.as_str())
                    .collect();
                excerpt(&texts.join("\n"), SUMMARY_CHARS)
            }
        }
    }

    fn event(&self) -> SupervisorEvent {
        let (kind, text, questions) = match &self.body {
            QuestionBody::TurnEnded { text } => (QuestionKind::TurnEnded, Some(text.clone()), None),
            QuestionBody::Menu { questions, .. } => {
                (QuestionKind::Menu, None, Some(questions.clone()))
            }
        };
        SupervisorEvent::Question {
            question_id: self.id.clone(),
            session_id: self.session_id.clone(),
            label: self.label.clone(),
            kind,
            text,
            questions,
        }
    }

    fn reply(&mut self, reply: HookReply) {
        if let QuestionBody::Menu { reply: sender, .. } = &mut self.body {
            if let Some(sender) = sender.take() {
                let _ = sender.send(reply);
            }
        }
    }

    fn answer_menu(&mut self, answers: HashMap<String, String>) {
        let QuestionBody::Menu { original, .. } = &self.body else {
            return;
        };
        let reply = HookReply::AnswerMenu {
            questions: original.clone(),
            answers: answers
                .into_iter()
                .map(|(question, answer)| (question, Value::String(answer)))
                .collect(),
        };
        self.reply(reply);
    }

    fn decision(&self, kind: &'static str, decision: String, rationale: &str) -> NewDecision {
        NewDecision {
            created_at: now_ms(),
            session_id: Some(self.session_id.clone()),
            kind,
            question: self.summary(),
            decision,
            rationale: rationale.to_string(),
        }
    }
}

struct Injection {
    id: u64,
    session_id: String,
    text: String,
}

#[derive(Default)]
struct WakeState {
    last_event: Option<Instant>,
    attention: bool,
    woken_at: Option<Instant>,
    drains: u64,
}

#[derive(Default)]
struct Outbox {
    decisions: Vec<NewDecision>,
    notifications: Vec<(String, String, String)>,
    attention: Vec<(String, String)>,
    discord: Vec<DiscordSync>,
}

enum Step {
    HandOff,
    Release,
    Escalate,
}

#[derive(Default)]
struct CoreState {
    level: SupervisorLevel,
    running: bool,
    ready: bool,
    supervisor_pty: Option<String>,
    presence: Presence,
    last_present: bool,
    discord_active: bool,
    provenance: ProvenanceTracker,
    sessions: HashMap<String, SessionState>,
    questions: Vec<Question>,
    injections: Vec<Injection>,
    next_injection: u64,
    escalations: Vec<EscalationView>,
    events: Vec<SupervisorEvent>,
    wake: WakeState,
    last_snapshot: Option<SupervisorSnapshot>,
    approvals: ApprovalBook,
    approval_records: HashMap<String, production::ApprovalRecord>,
}

impl CoreState {
    fn session_mut(&mut self, session_id: &str) -> &mut SessionState {
        self.sessions.entry(session_id.to_string()).or_default()
    }

    fn at_prompt(&self, session_id: &str) -> bool {
        self.sessions
            .get(session_id)
            .is_some_and(|session| session.at_prompt)
    }

    fn supervising(&self, settings: &SupervisorSettings, info: &SessionInfo) -> bool {
        settings.level != SupervisorLevel::Off && self.running && info.pty_id.is_some()
    }

    fn channel(&self, settings: &SupervisorSettings, now: Instant) -> EscalationChannel {
        route(
            self.discord_active,
            self.presence.is_present(now, settings.presence),
            settings.discord_mute_when_present,
        )
    }

    fn track_presence(&mut self, settings: &SupervisorSettings, now: Instant) {
        let present = self.presence.is_present(now, settings.presence);
        let left = self.last_present && !present;
        self.last_present = present;
        if left && self.discord_active {
            self.forward_to_discord(now);
        }
    }

    fn activate_discord(&mut self, active: bool, settings: &SupervisorSettings, now: Instant) {
        let activated = active && !self.discord_active;
        self.discord_active = active;
        if activated && self.channel(settings, now) == EscalationChannel::Discord {
            self.forward_to_discord(now);
        }
    }

    fn forward_to_discord(&mut self, now: Instant) {
        let sessions = &self.sessions;
        let escalations: Vec<ForwardedEscalation> = self
            .escalations
            .iter_mut()
            .filter(|escalation| {
                escalation.channel == EscalationChannel::App
                    && sessions
                        .get(&escalation.session_id)
                        .is_some_and(|session| session.awaiting_user)
            })
            .map(|escalation| {
                escalation.channel = EscalationChannel::Discord;
                forwarded_escalation(escalation)
            })
            .collect();
        let approvals = self.forward_pending_approvals(now);
        if escalations.is_empty() && approvals.is_empty() {
            return;
        }
        self.push_event(
            SupervisorEvent::Forwarded {
                escalations,
                approvals,
            },
            now,
        );
    }

    fn focused_present(&self, settings: &SupervisorSettings, now: Instant) -> Option<&str> {
        self.presence
            .focused_session()
            .filter(|_| self.presence.is_present(now, settings.presence))
    }

    fn menu_position(&self, question_id: &str) -> Option<usize> {
        self.questions
            .iter()
            .position(|question| question.id == question_id && question.is_menu())
    }

    fn take_question(&mut self, question_id: &str) -> Option<Question> {
        let index = self
            .questions
            .iter()
            .position(|question| question.id == question_id)?;
        Some(self.questions.remove(index))
    }

    fn take_session_questions(&mut self, session_id: &str) -> Vec<Question> {
        self.take_questions_where(|question| question.session_id == session_id)
    }

    fn take_session_turn_ends(&mut self, session_id: &str) -> Vec<Question> {
        self.take_questions_where(|question| {
            question.session_id == session_id && !question.is_menu()
        })
    }

    fn take_questions_where(&mut self, selected: impl Fn(&Question) -> bool) -> Vec<Question> {
        let (taken, kept) = std::mem::take(&mut self.questions)
            .into_iter()
            .partition(|question| selected(question));
        self.questions = kept;
        taken
    }

    fn push_event(&mut self, event: SupervisorEvent, now: Instant) {
        if event.wakes_supervisor() {
            self.wake.attention = true;
            self.wake.last_event = Some(now);
        }
        self.events.push(event);
    }

    fn reset_wake(&mut self) {
        self.wake.woken_at = None;
        self.wake.attention = self.events.iter().any(SupervisorEvent::wakes_supervisor);
    }

    fn discard_queued_question(&mut self, question_id: &str) -> bool {
        let queued = self.events.iter().position(|event| {
            matches!(event, SupervisorEvent::Question { question_id: id, .. } if id == question_id)
        });
        let Some(index) = queued else {
            return false;
        };
        self.events.remove(index);
        self.wake.attention = self.events.iter().any(SupervisorEvent::wakes_supervisor);
        true
    }

    fn withdraw_from_supervisor(&mut self, question: &Question) -> bool {
        if !question.with_supervisor() || self.discard_queued_question(&question.id) {
            return false;
        }
        self.events.push(SupervisorEvent::QuestionResolved {
            question_id: question.id.clone(),
            by: ResolvedBy::User,
        });
        true
    }

    fn open_question(
        &mut self,
        settings: &SupervisorSettings,
        info: SessionInfo,
        session_id: &str,
        body: QuestionBody,
        now: Instant,
        outbox: &mut Outbox,
    ) -> String {
        for mut previous in self.take_session_questions(session_id) {
            previous.reply(HookReply::Empty);
            self.withdraw_from_supervisor(&previous);
        }
        let id = Uuid::new_v4().to_string();
        self.questions.push(Question {
            id: id.clone(),
            session_id: session_id.to_string(),
            label: info.label,
            project_id: info.project_id,
            created: now,
            pause_mark: now,
            phase: Phase::Grace {
                deadline: now + settings.grace,
                deadline_ms: now_ms() + settings.grace.as_millis() as i64,
            },
            body,
        });
        if !self.presence.is_present(now, settings.presence) {
            self.hand_off(&id, now);
        } else if let Some(question) = self.questions.last().filter(|question| question.is_menu()) {
            outbox.attention.push((
                session_id.to_string(),
                format!(
                    "{ATTENTION_MENU}: {}",
                    excerpt(&question.summary(), NOTIFICATION_CHARS)
                ),
            ));
        }
        id
    }

    fn hand_off(&mut self, question_id: &str, now: Instant) {
        let Some(question) = self
            .questions
            .iter_mut()
            .find(|question| question.id == question_id)
        else {
            return;
        };
        question.phase = Phase::WithSupervisor { since: now };
        let event = question.event();
        self.push_event(event, now);
    }

    fn settle_pause(&mut self, settings: &SupervisorSettings, now: Instant) {
        let focused = self.focused_present(settings, now).map(str::to_string);
        for question in &mut self.questions {
            let elapsed = now.saturating_duration_since(question.pause_mark);
            question.pause_mark = now;
            if focused.as_deref() != Some(question.session_id.as_str()) {
                continue;
            }
            if let Phase::Grace {
                deadline,
                deadline_ms,
            } = &mut question.phase
            {
                *deadline += elapsed;
                *deadline_ms += elapsed.as_millis() as i64;
            }
        }
    }

    fn due_steps(&self, settings: &SupervisorSettings, now: Instant) -> Vec<(String, Step)> {
        let present = self.presence.is_present(now, settings.presence);
        self.questions
            .iter()
            .filter_map(|question| {
                let held = now.saturating_duration_since(question.created);
                let step = match question.phase {
                    Phase::Grace { .. } if question.is_menu() && held >= MENU_HOLD_CAP => {
                        Step::Release
                    }
                    Phase::Grace { deadline, .. } if !present || now >= deadline => Step::HandOff,
                    Phase::WithSupervisor { since }
                        if question.is_menu()
                            && (now.saturating_duration_since(since) >= DECISION_WINDOW
                                || held >= MENU_HOLD_CAP) =>
                    {
                        Step::Escalate
                    }
                    _ => return None,
                };
                Some((question.id.clone(), step))
            })
            .collect()
    }

    fn advance_questions(
        &mut self,
        settings: &SupervisorSettings,
        now: Instant,
        outbox: &mut Outbox,
    ) {
        for (question_id, step) in self.due_steps(settings, now) {
            match step {
                Step::HandOff => self.hand_off(&question_id, now),
                Step::Release => {
                    if let Some(question) = self.take_question(&question_id) {
                        self.release_question(question, RATIONALE_HOLD_CAP, outbox);
                    }
                }
                Step::Escalate => {
                    if let Some(mut question) = self.take_question(&question_id) {
                        if self.discard_queued_question(&question.id) {
                            question.reply(HookReply::Empty);
                            outbox.decisions.push(question.decision(
                                decision_kind::RELEASED_TO_USER,
                                DECISION_RELEASED.to_string(),
                                RATIONALE_UNSEEN,
                            ));
                            continue;
                        }
                        self.withdraw_from_supervisor(&question);
                        let summary = question.summary();
                        let escalation = self.escalate_question(
                            question,
                            summary,
                            RATIONALE_DECISION_TIMEOUT,
                            settings,
                            now,
                            outbox,
                        );
                        if escalation.channel == EscalationChannel::Discord {
                            self.push_event(
                                SupervisorEvent::Forwarded {
                                    escalations: vec![forwarded_escalation(&escalation)],
                                    approvals: Vec::new(),
                                },
                                now,
                            );
                        }
                    }
                }
            }
        }
    }

    fn release_question(&mut self, mut question: Question, rationale: &str, outbox: &mut Outbox) {
        question.reply(HookReply::Empty);
        self.withdraw_from_supervisor(&question);
        outbox.decisions.push(question.decision(
            decision_kind::RELEASED_TO_USER,
            DECISION_RELEASED.to_string(),
            rationale,
        ));
    }

    fn escalate_question(
        &mut self,
        mut question: Question,
        summary: String,
        rationale: &str,
        settings: &SupervisorSettings,
        now: Instant,
        outbox: &mut Outbox,
    ) -> EscalationView {
        let channel = self.channel(settings, now);
        question.reply(HookReply::Deny {
            reason: ESCALATED_REASON.to_string(),
        });
        self.session_mut(&question.session_id).awaiting_user = true;
        outbox.attention.push((
            question.session_id.clone(),
            format!(
                "{ATTENTION_ESCALATION}: {}",
                excerpt(&summary, NOTIFICATION_CHARS)
            ),
        ));
        if channel == EscalationChannel::App {
            outbox.notifications.push((
                question.session_id.clone(),
                ESCALATION_TITLE.to_string(),
                format!(
                    "{} — {}",
                    question.label,
                    excerpt(&summary, NOTIFICATION_CHARS)
                ),
            ));
        }
        outbox.decisions.push(question.decision(
            decision_kind::ESCALATED,
            DECISION_ESCALATED.to_string(),
            rationale,
        ));
        let escalation = EscalationView {
            id: Uuid::new_v4().to_string(),
            session_id: question.session_id,
            question_id: question.id,
            project_id: question.project_id,
            label: question.label,
            summary,
            channel,
            created_at: now_ms(),
        };
        self.escalations.push(escalation.clone());
        escalation
    }

    fn forget_session(&mut self, session_id: &str, outbox: &mut Outbox) {
        outbox.discord.push(DiscordSync::SessionSettled {
            session_id: session_id.to_string(),
        });
        self.sessions.remove(session_id);
        self.injections
            .retain(|injection| injection.session_id != session_id);
        self.escalations
            .retain(|escalation| escalation.session_id != session_id);
        self.approvals.revoke_session(session_id);
        self.provenance.forget_session(session_id);
        for mut question in self.take_session_questions(session_id) {
            question.reply(HookReply::Empty);
            if self.withdraw_from_supervisor(&question) {
                outbox.decisions.push(question.decision(
                    decision_kind::RELEASED_TO_USER,
                    DECISION_RELEASED.to_string(),
                    RATIONALE_SESSION_REPLACED,
                ));
            }
        }
    }

    fn drop_all_questions(&mut self) {
        for mut question in std::mem::take(&mut self.questions) {
            question.reply(HookReply::Empty);
        }
        self.events.retain(|event| {
            !matches!(
                event,
                SupervisorEvent::Question { .. } | SupervisorEvent::QuestionResolved { .. }
            )
        });
        self.reset_wake();
    }

    fn queue_injection(&mut self, session_id: &str, text: &str) -> bool {
        let text = single_line(text);
        if text.is_empty() {
            return false;
        }
        let text = cap_bytes(&text, MAX_INITIAL_PROMPT_BYTES);
        self.next_injection += 1;
        self.injections.push(Injection {
            id: self.next_injection,
            session_id: session_id.to_string(),
            text,
        });
        true
    }

    fn injection_candidates(&self) -> Vec<(u64, String, String)> {
        let mut seen = HashSet::new();
        self.injections
            .iter()
            .filter(|injection| {
                seen.insert(injection.session_id.as_str()) && self.at_prompt(&injection.session_id)
            })
            .map(|injection| {
                (
                    injection.id,
                    injection.session_id.clone(),
                    injection.text.clone(),
                )
            })
            .collect()
    }

    fn claim_injection(&mut self, injection_id: u64, now: Instant) -> bool {
        let Some(index) = self
            .injections
            .iter()
            .position(|injection| injection.id == injection_id)
        else {
            return false;
        };
        if !self.at_prompt(&self.injections[index].session_id) {
            return false;
        }
        let injection = self.injections.remove(index);
        self.session_mut(&injection.session_id).at_prompt = false;
        self.provenance
            .record_injection(&injection.session_id, &injection.text, now);
        true
    }

    fn requeue_injection(
        &mut self,
        injection_id: u64,
        session_id: String,
        text: String,
        typed_at: Instant,
    ) {
        self.provenance.forget_injection(&session_id, typed_at);
        self.session_mut(&session_id).at_prompt = true;
        self.injections.insert(
            0,
            Injection {
                id: injection_id,
                session_id,
                text,
            },
        );
    }

    fn wake_due(&self, now: Instant) -> bool {
        if !self.running || !self.ready || !self.wake.attention {
            return false;
        }
        match self.wake.woken_at {
            Some(woken_at) => now.saturating_duration_since(woken_at) >= WAKE_RETRY,
            None => self
                .wake
                .last_event
                .is_some_and(|last| now.saturating_duration_since(last) >= WAKE_DEBOUNCE),
        }
    }

    fn build_snapshot(&self, settings: &SupervisorSettings, now: Instant) -> SupervisorSnapshot {
        let focused = self.focused_present(settings, now);
        let cards = self
            .questions
            .iter()
            .filter_map(|question| {
                let QuestionBody::Menu { questions, .. } = &question.body else {
                    return None;
                };
                let (phase, deadline_ms) = match question.phase {
                    Phase::Grace { .. } if focused == Some(question.session_id.as_str()) => {
                        (CardPhase::Paused, None)
                    }
                    Phase::Grace { deadline_ms, .. } => (CardPhase::Grace, Some(deadline_ms)),
                    Phase::WithSupervisor { .. } => (CardPhase::WithSupervisor, None),
                };
                Some(QuestionCardView {
                    question_id: question.id.clone(),
                    session_id: question.session_id.clone(),
                    questions: questions.clone(),
                    phase,
                    deadline_ms,
                })
            })
            .collect();
        SupervisorSnapshot {
            level: settings.level,
            running: self.running,
            ready: self.ready,
            pty_id: self.supervisor_pty.clone(),
            present: self.presence.is_present(now, settings.presence),
            away: self.presence.away(),
            discord_active: self.discord_active,
            escalations: self.escalations.clone(),
            approvals: self.approval_views(now),
            cards,
        }
    }
}

struct PendingMenu {
    core: Arc<SupervisorCore>,
    question_id: String,
}

impl Drop for PendingMenu {
    fn drop(&mut self) {
        self.core.forget_question(&self.question_id);
    }
}

pub struct SupervisorCore {
    effects: Arc<dyn Effects>,
    state: Mutex<CoreState>,
    publishing: Mutex<()>,
}

impl SupervisorCore {
    pub fn new(effects: Arc<dyn Effects>) -> Arc<SupervisorCore> {
        let level = effects.settings().level;
        Arc::new(SupervisorCore {
            effects,
            state: Mutex::new(CoreState {
                level,
                ..CoreState::default()
            }),
            publishing: Mutex::new(()),
        })
    }

    pub async fn on_session_hook(self: &Arc<Self>, input: HookInput) -> HookReply {
        if let (SESSION_START, Some(pty_id)) =
            (input.hook_event_name.as_str(), input.pty_id.as_deref())
        {
            self.track_terminal(&input.session_id, pty_id);
        }
        match input.hook_event_name.as_str() {
            "Stop" if input.stop_hook_active != Some(true) => {
                self.on_stop(&input);
                HookReply::Empty
            }
            "UserPromptSubmit" => {
                self.on_user_prompt(&input);
                HookReply::Empty
            }
            "PreToolUse" if input.tool_name.as_deref() == Some(ASK_USER_QUESTION) => {
                self.on_menu(input).await
            }
            "PreToolUse" => self.on_guarded_tool(&input).await,
            _ => HookReply::Empty,
        }
    }

    fn track_terminal(&self, session_id: &str, pty_id: &str) {
        let submitted = self.effects.submitted_recently(pty_id, SUBMIT_WINDOW);
        let SessionClaim::Rebound { displaced } =
            self.effects.bind_session(session_id, pty_id, submitted)
        else {
            return;
        };
        let mut outbox = Outbox::default();
        {
            let mut state = self.state.lock();
            for previous in &displaced {
                state.forget_session(previous, &mut outbox);
            }
        }
        self.flush(outbox);
        self.effects.session_rebound(SessionRebound {
            pty_id: pty_id.to_string(),
            session_id: session_id.to_string(),
        });
        self.publish();
    }

    fn on_stop(&self, input: &HookInput) {
        let settings = self.effects.settings();
        let info = self.effects.session_info(&input.session_id);
        let text = input
            .last_assistant_message
            .as_deref()
            .unwrap_or_default()
            .trim()
            .to_string();
        let now = now();
        let mut outbox = Outbox::default();
        {
            let mut state = self.state.lock();
            let session = state.session_mut(&input.session_id);
            session.at_prompt = true;
            if text.is_empty() || session.awaiting_user {
                return;
            }
            let Some(info) = info.filter(|info| state.supervising(&settings, info)) else {
                return;
            };
            state.open_question(
                &settings,
                info,
                &input.session_id,
                QuestionBody::TurnEnded { text },
                now,
                &mut outbox,
            );
        }
        self.flush(outbox);
        self.publish_with(&settings);
    }

    fn on_user_prompt(&self, input: &HookInput) {
        let session_id = input.session_id.as_str();
        let prompt = input.prompt.as_deref().unwrap_or_default();
        let now = now();
        let typed_at = self.state.lock().provenance.last_typed_at(session_id, now);
        let evidence = self.prompt_evidence(session_id, typed_at, now);
        let mut outbox = Outbox::default();
        {
            let mut state = self.state.lock();
            let origin = state
                .provenance
                .on_user_prompt(session_id, prompt, evidence, now);
            let session = state.session_mut(session_id);
            session.at_prompt = false;
            session.awaiting_user = false;
            if origin == PromptOrigin::Human {
                outbox.discord.push(DiscordSync::SessionSettled {
                    session_id: session_id.to_string(),
                });
                state.approvals.revoke_session(session_id);
                state
                    .injections
                    .retain(|injection| injection.session_id != session_id);
                state
                    .escalations
                    .retain(|escalation| escalation.session_id != session_id);
                for mut question in state.take_session_questions(session_id) {
                    question.reply(HookReply::Empty);
                    if state.withdraw_from_supervisor(&question) {
                        outbox.decisions.push(question.decision(
                            decision_kind::RELEASED_TO_USER,
                            DECISION_RELEASED.to_string(),
                            RATIONALE_HUMAN_PROMPT,
                        ));
                    }
                }
            } else {
                for question in state.take_session_turn_ends(session_id) {
                    state.withdraw_from_supervisor(&question);
                }
            }
        }
        self.flush(outbox);
        self.publish();
    }

    fn prompt_evidence(
        &self,
        session_id: &str,
        typed_at: Option<Instant>,
        now: Instant,
    ) -> PromptEvidence {
        let pty_id = self
            .effects
            .session_info(session_id)
            .and_then(|info| info.pty_id);
        let Some(pty_id) = pty_id else {
            return PromptEvidence {
                pty_known: false,
                quiet_since_typed: false,
                recent_submit: false,
            };
        };
        PromptEvidence {
            pty_known: true,
            quiet_since_typed: typed_at.is_some_and(|typed_at| {
                self.effects
                    .input_quiet(&pty_id, now.saturating_duration_since(typed_at))
            }),
            recent_submit: self.effects.submitted_recently(&pty_id, SUBMIT_WINDOW),
        }
    }

    async fn on_menu(self: &Arc<Self>, input: HookInput) -> HookReply {
        let settings = self.effects.settings();
        let info = self.effects.session_info(&input.session_id);
        let tool_input = input.tool_input.unwrap_or_default();
        let questions = menu_questions(&tool_input);
        let original = tool_input.get("questions").cloned().unwrap_or_default();
        let (sender, receiver) = oneshot::channel();
        let now = now();
        let mut outbox = Outbox::default();
        let question_id = {
            let mut state = self.state.lock();
            state.session_mut(&input.session_id).at_prompt = false;
            let Some(info) = info.filter(|info| state.supervising(&settings, info)) else {
                return HookReply::Empty;
            };
            if questions.is_empty() {
                return HookReply::Empty;
            }
            let body = QuestionBody::Menu {
                original,
                questions,
                reply: Some(sender),
            };
            state.open_question(&settings, info, &input.session_id, body, now, &mut outbox)
        };
        self.flush(outbox);
        self.publish_with(&settings);
        let pending = PendingMenu {
            core: Arc::clone(self),
            question_id,
        };
        let reply = match tokio::time::timeout(MENU_SAFETY_TIMEOUT, receiver).await {
            Ok(Ok(reply)) => reply,
            _ => HookReply::Empty,
        };
        drop(pending);
        reply
    }

    fn forget_question(&self, question_id: &str) {
        let removed = {
            let mut state = self.state.lock();
            match state.take_question(question_id) {
                Some(question) => {
                    state.withdraw_from_supervisor(&question);
                    true
                }
                None => false,
            }
        };
        if removed {
            self.publish();
        }
    }

    pub fn tick(self: &Arc<Self>) {
        let settings = self.effects.settings();
        let now = now();
        let mut outbox = Outbox::default();
        {
            let mut state = self.state.lock();
            state.settle_pause(&settings, now);
            state.track_presence(&settings, now);
            state.advance_questions(&settings, now, &mut outbox);
        }
        self.flush(outbox);
        self.report_expired_approvals(now);
        self.deliver_injections(now);
        self.wake_if_due(now);
        self.publish_with(&settings);
    }

    fn deliver_injections(&self, now: Instant) {
        let candidates = self.state.lock().injection_candidates();
        for (injection_id, session_id, text) in candidates {
            let pty_id = self
                .effects
                .session_info(&session_id)
                .and_then(|info| info.pty_id);
            let Some(pty_id) = pty_id else {
                self.state
                    .lock()
                    .injections
                    .retain(|injection| injection.id != injection_id);
                continue;
            };
            if !self.effects.input_quiet(&pty_id, QUIET_WINDOW) {
                continue;
            }
            if !self.state.lock().claim_injection(injection_id, now) {
                continue;
            }
            if self.effects.type_into_pty(&pty_id, &text).is_err() {
                self.state
                    .lock()
                    .requeue_injection(injection_id, session_id, text, now);
            }
        }
    }

    fn wake_if_due(&self, now: Instant) {
        let drains = {
            let state = self.state.lock();
            if !state.wake_due(now) {
                return;
            }
            state.wake.drains
        };
        if !self.effects.wake_supervisor() {
            return;
        }
        let mut state = self.state.lock();
        if state.wake.drains == drains {
            state.wake.woken_at = Some(now);
        }
    }

    fn flush(&self, outbox: Outbox) {
        for entry in outbox.decisions {
            self.effects.log_decision(entry);
        }
        for (session_id, title, body) in outbox.notifications {
            self.effects.notify_desktop(&session_id, &title, &body);
        }
        for (session_id, message) in outbox.attention {
            self.effects.attention(&session_id, &message);
        }
        for change in outbox.discord {
            self.effects.discord_sync(change);
        }
    }

    fn publish(&self) {
        let settings = self.effects.settings();
        self.publish_with(&settings);
    }

    fn publish_with(&self, settings: &SupervisorSettings) {
        let _publishing = self.publishing.lock();
        let snapshot = {
            let mut state = self.state.lock();
            let snapshot = state.build_snapshot(settings, now());
            if state.last_snapshot.as_ref() == Some(&snapshot) {
                return;
            }
            state.last_snapshot = Some(snapshot.clone());
            snapshot
        };
        self.effects.publish_snapshot(snapshot);
    }

    pub fn set_supervisor_state(&self, running: bool, ready: bool, pty_id: Option<String>) {
        {
            let mut state = self.state.lock();
            state.running = running;
            state.ready = running && ready;
            state.supervisor_pty = pty_id;
            if !running {
                state.drop_all_questions();
            }
        }
        self.publish();
    }

    pub fn report_activity(&self, focused_session: Option<String>) {
        let settings = self.effects.settings();
        let now = now();
        {
            let mut state = self.state.lock();
            state.settle_pause(&settings, now);
            state.presence.record_activity(now, focused_session);
            state.track_presence(&settings, now);
        }
        self.publish_with(&settings);
    }

    pub fn set_away(&self, away: bool) {
        let settings = self.effects.settings();
        let now = now();
        {
            let mut state = self.state.lock();
            state.settle_pause(&settings, now);
            state.presence.set_away(away);
            state.track_presence(&settings, now);
        }
        self.publish_with(&settings);
    }

    pub fn set_discord_active(&self, active: bool) {
        let settings = self.effects.settings();
        let now = now();
        self.state.lock().activate_discord(active, &settings, now);
        self.publish_with(&settings);
    }

    pub fn accepts_discord_answers(&self) -> bool {
        let settings = self.effects.settings();
        settings.level != SupervisorLevel::Off
            && settings.discord_enabled
            && settings.discord_chat_id.is_some()
    }

    pub fn record_discord_answer(&self, answer: ClickedOption) {
        let event = SupervisorEvent::DiscordAnswer {
            question_id: answer.question_id,
            session_id: answer.session_id,
            label: answer.label,
            key: answer.key,
            question: answer.question,
            value: answer.value,
            open_keys: answer.open_keys,
        };
        self.state.lock().push_event(event, now());
    }

    pub fn answer_card(
        &self,
        question_id: &str,
        answers: HashMap<String, String>,
    ) -> Result<(), String> {
        {
            let mut state = self.state.lock();
            let index = state
                .menu_position(question_id)
                .ok_or_else(|| ERROR_UNKNOWN_CARD.to_string())?;
            if answers.is_empty() {
                return Err(ERROR_EMPTY_CARD_ANSWER.to_string());
            }
            let mut question = state.questions.remove(index);
            question.answer_menu(answers);
            state.withdraw_from_supervisor(&question);
        }
        self.publish();
        Ok(())
    }

    pub fn release_card(&self, question_id: &str) -> Result<(), String> {
        let mut outbox = Outbox::default();
        {
            let mut state = self.state.lock();
            let index = state
                .menu_position(question_id)
                .ok_or_else(|| ERROR_UNKNOWN_CARD.to_string())?;
            let question = state.questions.remove(index);
            state.release_question(question, RATIONALE_CARD_RELEASE, &mut outbox);
        }
        self.flush(outbox);
        self.publish();
        Ok(())
    }

    pub fn dismiss_escalation(&self, id: &str) {
        let question_id = {
            let mut state = self.state.lock();
            let Some(index) = state
                .escalations
                .iter()
                .position(|escalation| escalation.id == id)
            else {
                return;
            };
            let escalation = state.escalations.remove(index);
            let remaining = state
                .escalations
                .iter()
                .any(|other| other.session_id == escalation.session_id);
            if !remaining {
                state.session_mut(&escalation.session_id).awaiting_user = false;
            }
            escalation.question_id
        };
        self.effects
            .discord_sync(DiscordSync::QuestionSettled { question_id });
        self.publish();
    }

    pub fn answer_question(
        &self,
        question_id: &str,
        text: Option<String>,
        answers: Option<HashMap<String, String>>,
        rationale: &str,
    ) -> Result<(), String> {
        if self.effects.settings().level == SupervisorLevel::Relay {
            return Err(ERROR_RELAY_LEVEL.to_string());
        }
        let entry = {
            let mut state = self.state.lock();
            let index = state
                .questions
                .iter()
                .position(|question| question.id == question_id)
                .ok_or_else(|| ERROR_UNKNOWN_QUESTION.to_string())?;
            if !state.questions[index].with_supervisor() {
                return Err(ERROR_IN_GRACE.to_string());
            }
            if let QuestionBody::Menu { questions, .. } = &state.questions[index].body {
                let answers = answers
                    .filter(|answers| !answers.is_empty())
                    .ok_or_else(|| ERROR_MISSING_ANSWERS.to_string())?;
                check_menu_answers(questions, &answers)?;
                let decision = describe_answers(&answers);
                let mut question = state.questions.remove(index);
                question.answer_menu(answers);
                state.discard_queued_question(&question.id);
                state.provenance.mark_supervisor(&question.session_id);
                question.decision(decision_kind::ANSWERED, decision, rationale)
            } else {
                let text = single_line(text.as_deref().unwrap_or_default());
                if text.is_empty() {
                    return Err(ERROR_MISSING_TEXT.to_string());
                }
                let question = state.questions.remove(index);
                state.discard_queued_question(&question.id);
                state.queue_injection(&question.session_id, &format!("{ANSWER_PREFIX}{text}"));
                question.decision(decision_kind::ANSWERED, text, rationale)
            }
        };
        self.effects.log_decision(entry);
        self.publish();
        Ok(())
    }

    pub fn snapshot(&self) -> SupervisorSnapshot {
        let settings = self.effects.settings();
        self.state.lock().build_snapshot(&settings, now())
    }

    pub fn take_events(&self) -> Vec<SupervisorEvent> {
        let mut state = self.state.lock();
        state.wake = WakeState {
            drains: state.wake.drains + 1,
            ..WakeState::default()
        };
        std::mem::take(&mut state.events)
    }

    pub fn level_changed(&self) {
        let settings = self.effects.settings();
        let now = now();
        {
            let mut state = self.state.lock();
            if state.level == settings.level {
                return;
            }
            state.level = settings.level;
            if settings.level == SupervisorLevel::Off {
                state.events.clear();
                state.injections.clear();
                state.drop_all_questions();
            } else {
                state.push_event(
                    SupervisorEvent::LevelChanged {
                        level: settings.level,
                    },
                    now,
                );
            }
        }
        self.publish_with(&settings);
    }

    pub fn expect_cli_prompt(&self, session_id: &str, prompt: &str) {
        self.state
            .lock()
            .provenance
            .expect_cli_prompt(session_id, prompt, now());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::supervisor::events::ForwardedApproval;
    use crate::supervisor::test_support::*;
    use serde_json::json;
    use std::sync::atomic::Ordering;
    use tokio::time::advance;

    fn only_card(core: &SupervisorCore) -> QuestionCardView {
        let cards = core.snapshot().cards;
        assert_eq!(cards.len(), 1, "expected exactly one card");
        cards.into_iter().next().unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn turn_end_waits_grace_when_present_then_queues() {
        let (effects, core) = setup();
        core.report_activity(None);
        let reply = core
            .on_session_hook(stop("s1", "Kontynuować z kolejnym zadaniem?"))
            .await;
        assert_eq!(reply, HookReply::Empty);
        advance(59 * SECOND).await;
        core.tick();
        assert!(core.take_events().is_empty());
        advance(2 * SECOND).await;
        core.tick();
        advance(9 * SECOND).await;
        core.tick();
        assert_eq!(effects.wakes(), 0);
        advance(SECOND).await;
        core.tick();
        core.tick();
        assert_eq!(effects.wakes(), 1);
        let events = core.take_events();
        assert_eq!(events.len(), 1);
        match &events[0] {
            SupervisorEvent::Question {
                session_id,
                label,
                kind,
                text,
                questions,
                ..
            } => {
                assert_eq!(session_id, "s1");
                assert_eq!(label, "projekt · s1");
                assert_eq!(*kind, QuestionKind::TurnEnded);
                assert_eq!(text.as_deref(), Some("Kontynuować z kolejnym zadaniem?"));
                assert!(questions.is_none());
            }
            other => panic!("unexpected event {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn turn_end_queues_immediately_when_away() {
        let (_effects, core) = setup();
        core.report_activity(None);
        core.set_away(true);
        assert!(core.snapshot().away);
        core.on_session_hook(stop("s1", "Który wariant wybrać?"))
            .await;
        let events = core.take_events();
        assert!(matches!(
            events.as_slice(),
            [SupervisorEvent::Question {
                kind: QuestionKind::TurnEnded,
                ..
            }]
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn stop_fired_by_an_active_stop_hook_is_ignored() {
        let (_effects, core) = setup();
        core.set_away(true);
        let continued = HookInput {
            stop_hook_active: Some(true),
            ..stop("s1", "Czy kontynuować?")
        };
        assert_eq!(core.on_session_hook(continued).await, HookReply::Empty);
        assert!(core.take_events().is_empty());
        assert!(!core.state.lock().at_prompt("s1"));
        assert!(core.send_to_session("s1", "Dalej").is_err());
        let settled = HookInput {
            stop_hook_active: Some(false),
            ..stop("s1", "Czy kontynuować?")
        };
        core.on_session_hook(settled).await;
        assert_eq!(core.take_events().len(), 1);
        assert!(core.state.lock().at_prompt("s1"));
    }

    #[tokio::test(start_paused = true)]
    async fn human_prompt_during_grace_cancels_question() {
        let (effects, core) = setup();
        core.report_activity(None);
        core.on_session_hook(stop("s1", "Czy mam kontynuować?"))
            .await;
        advance(30 * SECOND).await;
        core.tick();
        effects.submit("pty-s1");
        let reply = core
            .on_session_hook(prompt("s1", "nie, najpierw testy"))
            .await;
        assert_eq!(reply, HookReply::Empty);
        advance(60 * SECOND).await;
        core.tick();
        advance(20 * SECOND).await;
        core.tick();
        assert!(core.take_events().is_empty());
        assert_eq!(effects.wakes(), 0);
        assert!(effects.kinds().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn menu_card_answer_releases_hook_with_answers() {
        let (effects, core) = setup();
        core.report_activity(None);
        let handle = spawn_menu(&core, "s1").await;
        let card = only_card(&core);
        assert_eq!(card.session_id, "s1");
        assert_eq!(card.phase, CardPhase::Grace);
        assert!(card.deadline_ms.is_some());
        assert_eq!(card.questions[0].options, vec!["Red", "Green"]);
        assert_eq!(effects.last_snapshot().unwrap().cards.len(), 1);
        core.answer_card(&card.question_id, answer(COLOR_QUESTION, "Green"))
            .unwrap();
        match reply_of(handle).await {
            HookReply::AnswerMenu { questions, answers } => {
                assert_eq!(questions, menu_tool_input()["questions"]);
                assert_eq!(answers.len(), 1);
                assert_eq!(answers.get(COLOR_QUESTION), Some(&json!("Green")));
            }
            other => panic!("unexpected reply {other:?}"),
        }
        assert!(core.snapshot().cards.is_empty());
        assert!(effects.last_snapshot().unwrap().cards.is_empty());
        assert!(effects.kinds().is_empty());
        assert!(core
            .answer_card(&card.question_id, answer(COLOR_QUESTION, "Red"))
            .is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn menu_release_card_returns_empty() {
        let (effects, core) = setup();
        core.report_activity(None);
        let handle = spawn_menu(&core, "s1").await;
        let card = only_card(&core);
        assert!(core.release_card("unknown").is_err());
        core.release_card(&card.question_id).unwrap();
        assert_eq!(reply_of(handle).await, HookReply::Empty);
        assert!(core.snapshot().cards.is_empty());
        assert_eq!(effects.kinds(), vec![decision_kind::RELEASED_TO_USER]);
        assert!(core.release_card(&card.question_id).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn menu_hold_timeout_escalates_with_reason() {
        let (effects, core) = setup();
        core.report_activity(None);
        let handle = spawn_menu(&core, "s1").await;
        advance(60 * SECOND).await;
        core.tick();
        assert_eq!(only_card(&core).phase, CardPhase::WithSupervisor);
        assert_eq!(core.take_events().len(), 1);
        advance(119 * SECOND).await;
        core.tick();
        settle().await;
        assert!(!handle.is_finished());
        advance(SECOND).await;
        core.tick();
        assert_eq!(
            reply_of(handle).await,
            HookReply::Deny {
                reason: "Pytanie przekazane użytkownikowi — poczekaj na jego odpowiedź w kolejnej wiadomości.".into()
            }
        );
        let snapshot = core.snapshot();
        assert!(snapshot.cards.is_empty());
        assert_eq!(snapshot.escalations.len(), 1);
        let escalation = &snapshot.escalations[0];
        assert_eq!(escalation.session_id, "s1");
        assert_eq!(escalation.project_id, Some(1));
        assert_eq!(escalation.label, "projekt · s1");
        assert_eq!(escalation.summary, COLOR_QUESTION);
        let notifications = effects.notifications();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].0, "s1");
        assert!(notifications[0].2.contains("projekt · s1"));
        assert_eq!(effects.kinds(), vec![decision_kind::ESCALATED]);
        assert!(matches!(
            core.take_events().as_slice(),
            [SupervisorEvent::QuestionResolved {
                by: ResolvedBy::User,
                ..
            }]
        ));
        assert_eq!(
            effects.attentions(),
            vec![
                (
                    "s1".to_string(),
                    format!("Pytanie w sesji czeka na Twoją odpowiedź: {COLOR_QUESTION}")
                ),
                (
                    "s1".to_string(),
                    format!("Agent sterujący przekazał Ci pytanie: {COLOR_QUESTION}")
                ),
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn only_menus_waiting_for_the_user_raise_attention() {
        let (effects, core) = setup();
        core.report_activity(None);
        core.on_session_hook(stop("s2", "Czy kontynuować?")).await;
        assert!(effects.attentions().is_empty());
        let held = spawn_menu(&core, "s1").await;
        assert_eq!(effects.attentions().len(), 1);
        assert_eq!(effects.attentions()[0].0, "s1");
        core.release_card(&only_card(&core).question_id).unwrap();
        assert_eq!(reply_of(held).await, HookReply::Empty);
        core.set_away(true);
        let away = spawn_menu(&core, "s1").await;
        assert_eq!(effects.attentions().len(), 1);
        let question_id = core
            .take_events()
            .into_iter()
            .find_map(|event| match event {
                SupervisorEvent::Question {
                    question_id,
                    kind: QuestionKind::Menu,
                    ..
                } => Some(question_id),
                _ => None,
            })
            .unwrap();
        core.escalate(&[question_id], "Kolor wybiera użytkownik")
            .unwrap();
        assert!(matches!(reply_of(away).await, HookReply::Deny { .. }));
        assert_eq!(
            effects.attentions().last(),
            Some(&(
                "s1".to_string(),
                "Agent sterujący przekazał Ci pytanie: Kolor wybiera użytkownik".to_string()
            ))
        );
        assert_eq!(effects.attentions().len(), 2);
    }

    #[tokio::test(start_paused = true)]
    async fn undrained_menu_is_released_when_the_decision_window_expires() {
        let (effects, core) = setup();
        core.report_activity(None);
        let handle = spawn_menu(&core, "s1").await;
        advance(60 * SECOND).await;
        core.tick();
        assert_eq!(only_card(&core).phase, CardPhase::WithSupervisor);
        advance(119 * SECOND).await;
        core.tick();
        settle().await;
        assert!(!handle.is_finished());
        advance(SECOND).await;
        core.tick();
        assert_eq!(reply_of(handle).await, HookReply::Empty);
        let snapshot = core.snapshot();
        assert!(snapshot.cards.is_empty());
        assert!(snapshot.escalations.is_empty());
        assert!(effects.notifications().is_empty());
        assert_eq!(effects.kinds(), vec![decision_kind::RELEASED_TO_USER]);
        assert!(core.take_events().is_empty());
        core.on_session_hook(stop("s1", "Który kolor?")).await;
        advance(60 * SECOND).await;
        core.tick();
        assert_eq!(core.take_events().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn escalated_session_ignores_stop_until_human_prompt() {
        let (effects, core) = setup();
        core.set_away(true);
        let handle = spawn_menu(&core, "s1").await;
        assert_eq!(core.take_events().len(), 1);
        advance(DECISION_WINDOW).await;
        core.tick();
        assert!(matches!(reply_of(handle).await, HookReply::Deny { .. }));
        assert!(matches!(
            core.take_events().as_slice(),
            [SupervisorEvent::QuestionResolved {
                by: ResolvedBy::User,
                ..
            }]
        ));
        core.on_session_hook(stop("s1", "Czekam na decyzję użytkownika."))
            .await;
        assert!(core.take_events().is_empty());
        effects.submit("pty-s1");
        core.on_session_hook(prompt("s1", "wybierz zielony")).await;
        assert!(core.snapshot().escalations.is_empty());
        core.on_session_hook(stop("s1", "Gotowe. Czy commitować?"))
            .await;
        assert_eq!(core.take_events().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn grace_pauses_while_session_focused() {
        let (_effects, core) = setup();
        core.report_activity(Some("s1".into()));
        let _handle = spawn_menu(&core, "s1").await;
        let card = only_card(&core);
        assert_eq!(card.phase, CardPhase::Paused);
        assert_eq!(card.deadline_ms, None);
        advance(120 * SECOND).await;
        core.tick();
        assert_eq!(only_card(&core).phase, CardPhase::Paused);
        assert!(core.take_events().is_empty());
        assert!(core
            .answer_question(
                &card.question_id,
                None,
                Some(answer(COLOR_QUESTION, "Red")),
                "x"
            )
            .is_err());
        core.report_activity(None);
        let card = only_card(&core);
        assert_eq!(card.phase, CardPhase::Grace);
        assert!(card.deadline_ms.is_some());
        advance(59 * SECOND).await;
        core.tick();
        assert_eq!(only_card(&core).phase, CardPhase::Grace);
        advance(2 * SECOND).await;
        core.tick();
        assert_eq!(only_card(&core).phase, CardPhase::WithSupervisor);
        assert_eq!(core.take_events().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn turn_answer_waits_for_quiet_window() {
        let (effects, core) = setup();
        core.set_away(true);
        core.on_session_hook(stop("s1", "Czy kontynuować?")).await;
        let question_id = only_question_id(core.take_events());
        effects.quiet.store(false, Ordering::SeqCst);
        core.answer_question(
            &question_id,
            Some(" tak ".into()),
            None,
            "Plan przewiduje kolejne zadanie",
        )
        .unwrap();
        core.tick();
        advance(5 * SECOND).await;
        core.tick();
        assert!(effects.typed().is_empty());
        effects.quiet.store(true, Ordering::SeqCst);
        core.tick();
        core.tick();
        assert_eq!(
            effects.typed(),
            vec![("pty-s1".to_string(), "[agent sterujący] tak\r".to_string())]
        );
        assert_eq!(effects.kinds(), vec![decision_kind::ANSWERED]);
        core.on_session_hook(prompt("s1", "[agent sterujący] tak"))
            .await;
        assert_eq!(
            core.state.lock().provenance.origin("s1"),
            PromptOrigin::Supervisor
        );
    }

    #[tokio::test(start_paused = true)]
    async fn human_prompt_drops_pending_answer() {
        let (effects, core) = setup();
        core.set_away(true);
        core.on_session_hook(stop("s1", "Czy kontynuować?")).await;
        let question_id = only_question_id(core.take_events());
        assert!(core
            .answer_question(&question_id, Some("  ".into()), None, "x")
            .is_err());
        effects.quiet.store(false, Ordering::SeqCst);
        core.answer_question(&question_id, Some("tak".into()), None, "plan")
            .unwrap();
        effects.submit("pty-s1");
        core.on_session_hook(prompt("s1", "poczekaj, sprawdzę coś"))
            .await;
        effects.quiet.store(true, Ordering::SeqCst);
        core.tick();
        assert!(effects.typed().is_empty());
        core.on_session_hook(stop("s1", "Sprawdzone.")).await;
        core.tick();
        assert!(effects.typed().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn supervisor_menu_answer_marks_provenance() {
        let (effects, core) = setup();
        core.set_away(true);
        let handle = spawn_menu(&core, "s1").await;
        let question_id = only_question_id(core.take_events());
        assert!(core
            .answer_question(&question_id, Some("Red".into()), None, "x")
            .is_err());
        core.answer_question(
            &question_id,
            None,
            Some(answer(COLOR_QUESTION, "Red")),
            "Preferencja zapisana w preferences.md",
        )
        .unwrap();
        match reply_of(handle).await {
            HookReply::AnswerMenu { answers, .. } => {
                assert_eq!(answers.get(COLOR_QUESTION), Some(&json!("Red")));
            }
            other => panic!("unexpected reply {other:?}"),
        }
        assert_eq!(
            core.state.lock().provenance.origin("s1"),
            PromptOrigin::Supervisor
        );
        assert_eq!(effects.kinds(), vec![decision_kind::ANSWERED]);
        assert!(core.snapshot().cards.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn supervisor_down_releases_held_menus() {
        let (effects, core) = setup();
        core.report_activity(None);
        let first = spawn_menu(&core, "s1").await;
        advance(60 * SECOND).await;
        core.tick();
        let second = spawn_menu(&core, "s2").await;
        assert_eq!(core.snapshot().cards.len(), 2);
        core.set_supervisor_state(false, false, None);
        assert_eq!(reply_of(first).await, HookReply::Empty);
        assert_eq!(reply_of(second).await, HookReply::Empty);
        let snapshot = core.snapshot();
        assert!(snapshot.cards.is_empty());
        assert!(!snapshot.running);
        assert!(core.take_events().is_empty());
        let started = tokio::time::Instant::now();
        assert_eq!(core.on_session_hook(menu("s1")).await, HookReply::Empty);
        assert_eq!(tokio::time::Instant::now(), started);
        core.on_session_hook(stop("s1", "Dalej?")).await;
        advance(30 * SECOND).await;
        core.tick();
        assert!(core.take_events().is_empty());
        assert_eq!(effects.wakes(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn level_off_is_inert() {
        let (effects, core) = setup();
        effects.settings.lock().level = SupervisorLevel::Off;
        core.set_away(true);
        let started = tokio::time::Instant::now();
        assert_eq!(core.on_session_hook(menu("s1")).await, HookReply::Empty);
        assert_eq!(tokio::time::Instant::now(), started);
        assert_eq!(
            core.on_session_hook(stop("s1", "Dalej?")).await,
            HookReply::Empty
        );
        assert_eq!(
            core.on_session_hook(prompt("s1", "tak")).await,
            HookReply::Empty
        );
        let bash = HookInput {
            tool_name: Some("Bash".into()),
            tool_input: Some(json!({"command": "git push origin main"})),
            ..hook("s1", "PreToolUse")
        };
        assert_eq!(core.on_session_hook(bash).await, HookReply::Empty);
        advance(30 * SECOND).await;
        core.tick();
        assert!(core.snapshot().cards.is_empty());
        assert!(core.take_events().is_empty());
        assert_eq!(effects.wakes(), 0);
        assert!(effects.kinds().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn paused_menu_is_released_to_terminal_at_hold_cap() {
        let (effects, core) = setup();
        core.report_activity(Some("s1".into()));
        let handle = spawn_menu(&core, "s1").await;
        for _ in 0..5 {
            advance(100 * SECOND).await;
            core.report_activity(Some("s1".into()));
            core.tick();
        }
        advance(69 * SECOND).await;
        core.tick();
        settle().await;
        assert!(!handle.is_finished());
        assert_eq!(only_card(&core).phase, CardPhase::Paused);
        advance(SECOND).await;
        core.tick();
        assert_eq!(reply_of(handle).await, HookReply::Empty);
        assert_eq!(effects.kinds(), vec![decision_kind::RELEASED_TO_USER]);
        assert!(core.snapshot().cards.is_empty());
        assert!(core.take_events().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn wake_waits_for_ready_and_repeats_until_drained() {
        let (effects, core) = setup();
        core.set_supervisor_state(true, false, Some("pty-supervisor".into()));
        effects.wake_accepts.store(false, Ordering::SeqCst);
        core.set_away(true);
        core.on_session_hook(stop("s1", "Dalej?")).await;
        advance(WAKE_DEBOUNCE).await;
        core.tick();
        assert_eq!(effects.wakes(), 0);
        core.set_supervisor_state(true, true, Some("pty-supervisor".into()));
        core.tick();
        core.tick();
        assert_eq!(effects.wakes(), 2);
        effects.wake_accepts.store(true, Ordering::SeqCst);
        core.tick();
        core.tick();
        assert_eq!(effects.wakes(), 3);
        advance(119 * SECOND).await;
        core.tick();
        assert_eq!(effects.wakes(), 3);
        advance(SECOND).await;
        core.tick();
        assert_eq!(effects.wakes(), 4);
        assert_eq!(core.take_events().len(), 1);
        advance(300 * SECOND).await;
        core.tick();
        assert_eq!(effects.wakes(), 4);
    }

    #[tokio::test(start_paused = true)]
    async fn no_wake_before_ready() {
        let effects = FakeEffects::new();
        let core = SupervisorCore::new(effects.clone());
        core.set_supervisor_state(true, false, Some("pty-supervisor".into()));
        core.set_away(true);
        core.on_session_hook(stop("s1", "Kontynuować z kolejnym zadaniem?"))
            .await;
        let held = spawn_menu(&core, "s2").await;
        for _ in 0..6 {
            advance(WAKE_DEBOUNCE).await;
            core.tick();
        }
        assert_eq!(effects.wakes(), 0);
        assert!(effects.typed().is_empty());
        assert!(!core.snapshot().ready);
        assert!(!held.is_finished());

        core.set_supervisor_state(true, true, Some("pty-supervisor".into()));
        core.tick();
        assert_eq!(effects.wakes(), 1);
        let events = core.take_events();
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|event| matches!(
            event,
            SupervisorEvent::Question { session_id, .. } if session_id == "s1" || session_id == "s2"
        )));
        held.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn level_change_is_queued_once_and_off_releases_menus() {
        let (effects, core) = setup();
        core.report_activity(None);
        effects.settings.lock().level = SupervisorLevel::Relay;
        core.level_changed();
        core.level_changed();
        assert!(matches!(
            core.take_events().as_slice(),
            [SupervisorEvent::LevelChanged {
                level: SupervisorLevel::Relay
            }]
        ));
        let handle = spawn_menu(&core, "s1").await;
        effects.settings.lock().level = SupervisorLevel::Off;
        core.level_changed();
        assert_eq!(reply_of(handle).await, HookReply::Empty);
        assert!(core.snapshot().cards.is_empty());
        assert!(core.take_events().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn abandoned_hook_removes_its_card() {
        let (effects, core) = setup();
        core.report_activity(None);
        let handle = spawn_menu(&core, "s1").await;
        assert_eq!(core.snapshot().cards.len(), 1);
        handle.abort();
        settle().await;
        assert!(core.snapshot().cards.is_empty());
        assert!(effects.last_snapshot().unwrap().cards.is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn new_session_in_the_same_terminal_drops_the_queued_injection() {
        let (effects, core) = setup();
        core.set_away(true);
        core.on_session_hook(stop("s1", "Czy wypchnąć?")).await;
        let question_id = only_question_id(core.take_events());
        effects.quiet.store(false, Ordering::SeqCst);
        core.answer_question(
            &question_id,
            Some("tak, git push origin main".into()),
            None,
            "x",
        )
        .unwrap();
        core.tick();
        assert!(effects.typed().is_empty());
        effects.submit("pty-s1");
        core.on_session_hook(on_terminal(hook("s3", "SessionStart"), "pty-s1"))
            .await;
        assert_eq!(
            effects.session_info("s3").and_then(|info| info.pty_id),
            Some("pty-s1".to_string())
        );
        assert_eq!(
            effects.session_info("s1").and_then(|info| info.pty_id),
            None
        );
        effects.quiet.store(true, Ordering::SeqCst);
        core.tick();
        core.tick();
        assert!(effects.typed().is_empty());
        core.on_session_hook(on_terminal(stop("s3", "Gotowe."), "pty-s1"))
            .await;
        core.tick();
        assert!(effects.typed().is_empty());
        assert!(core.send_to_session("s1", "x").is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn new_session_in_the_same_terminal_needs_a_submit_to_count_as_human() {
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        effects.submit("pty-s1");
        core.on_session_hook(prompt("s1", "zrób push")).await;
        advance(30 * SECOND).await;
        effects.submit("pty-s1");
        core.on_session_hook(on_terminal(hook("s3", "SessionStart"), "pty-s1"))
            .await;
        advance(SUBMIT_WINDOW + SECOND).await;
        core.on_session_hook(on_terminal(
            prompt("s3", "[agent sterujący] git push"),
            "pty-s1",
        ))
        .await;
        assert_eq!(
            core.state.lock().provenance.origin("s3"),
            PromptOrigin::Agent
        );
        assert!(matches!(
            core.on_session_hook(on_terminal(bash("s3", "git push origin main"), "pty-s1"))
                .await,
            HookReply::Deny { .. }
        ));
        effects.submit("pty-s1");
        core.on_session_hook(on_terminal(prompt("s3", "wypchnij"), "pty-s1"))
            .await;
        assert_eq!(
            core.state.lock().provenance.origin("s3"),
            PromptOrigin::Human
        );
        assert_eq!(
            core.on_session_hook(on_terminal(bash("s3", "git push origin main"), "pty-s1"))
                .await,
            HookReply::Empty
        );
    }

    #[tokio::test(start_paused = true)]
    async fn prompt_from_an_unknown_terminal_is_agent_and_guarded() {
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        core.on_session_hook(on_terminal(prompt("s9", "git push"), "pty-ghost"))
            .await;
        assert_eq!(effects.session_info("s9"), None);
        assert_eq!(
            core.state.lock().provenance.origin("s9"),
            PromptOrigin::Agent
        );
        assert!(matches!(
            core.on_session_hook(bash("s9", "git push origin main"))
                .await,
            HookReply::Deny { .. }
        ));
        assert_eq!(core.snapshot().approvals.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn new_session_in_the_same_terminal_releases_the_old_menu_and_escalations() {
        let (effects, core) = setup();
        core.set_away(true);
        let escalated = spawn_menu(&core, "s1").await;
        let question_id = only_question_id(core.take_events());
        core.escalate(&[question_id], "Kolor wybiera użytkownik")
            .unwrap();
        assert!(matches!(reply_of(escalated).await, HookReply::Deny { .. }));
        core.take_events();
        let held = spawn_menu(&core, "s1").await;
        assert_eq!(core.snapshot().cards.len(), 1);
        assert_eq!(core.snapshot().escalations.len(), 1);
        effects.submit("pty-s1");
        core.on_session_hook(on_terminal(hook("s3", "SessionStart"), "pty-s1"))
            .await;
        assert_eq!(reply_of(held).await, HookReply::Empty);
        let snapshot = core.snapshot();
        assert!(snapshot.cards.is_empty());
        assert!(snapshot.escalations.is_empty());
        assert!(core.take_events().is_empty());
        assert!(!core.state.lock().sessions.contains_key("s1"));
        assert_eq!(effects.kinds(), vec![decision_kind::ESCALATED]);
        core.on_session_hook(on_terminal(stop("s3", "Który kolor?"), "pty-s1"))
            .await;
        assert_eq!(core.take_events().len(), 1);
    }

    fn pty_of(effects: &FakeEffects, session_id: &str) -> Option<String> {
        effects
            .session_info(session_id)
            .and_then(|info| info.pty_id)
    }

    #[tokio::test(start_paused = true)]
    async fn only_session_start_binds_a_terminal() {
        let (effects, core) = setup();
        core.on_session_hook(on_terminal(prompt("s3", "cześć"), "pty-s1"))
            .await;
        core.on_session_hook(on_terminal(stop("s3", "Gotowe."), "pty-s1"))
            .await;
        core.on_session_hook(on_terminal(bash("s3", "ls"), "pty-s1"))
            .await;
        assert_eq!(effects.session_info("s3"), None);
        assert_eq!(pty_of(&effects, "s1"), Some("pty-s1".to_string()));
    }

    #[tokio::test(start_paused = true)]
    async fn forged_session_start_cannot_move_a_session_onto_another_terminal() {
        let (effects, core) = setup();
        core.set_away(true);
        let held = spawn_menu(&core, "s2").await;
        assert_eq!(core.snapshot().cards.len(), 1);
        core.on_session_hook(on_terminal(hook("s1", "SessionStart"), "pty-s2"))
            .await;
        assert_eq!(pty_of(&effects, "s1"), Some("pty-s1".to_string()));
        assert_eq!(pty_of(&effects, "s2"), Some("pty-s2".to_string()));
        assert_eq!(core.snapshot().cards.len(), 1);
        assert_eq!(core.snapshot().cards[0].session_id, "s2");
        assert!(!held.is_finished());
        effects.submit("pty-s2");
        core.on_session_hook(on_terminal(prompt("s1", "git push origin main"), "pty-s2"))
            .await;
        assert_eq!(
            core.state.lock().provenance.origin("s1"),
            PromptOrigin::Agent
        );
        held.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn a_new_session_id_without_an_enter_cannot_take_a_live_terminal() {
        let (effects, core) = setup();
        core.set_away(true);
        let held = spawn_menu(&core, "s2").await;
        effects.submit("pty-s2");
        advance(SUBMIT_WINDOW + SECOND).await;
        effects.submit("pty-s1");
        core.on_session_hook(on_terminal(hook("y", "SessionStart"), "pty-s2"))
            .await;
        assert_eq!(effects.session_info("y"), None);
        assert_eq!(pty_of(&effects, "s2"), Some("pty-s2".to_string()));
        assert_eq!(core.snapshot().cards.len(), 1);
        assert_eq!(core.snapshot().cards[0].session_id, "s2");
        assert!(!held.is_finished());
        assert!(effects.rebounds.lock().is_empty());
        held.abort();
    }

    #[tokio::test(start_paused = true)]
    async fn clear_and_resume_in_the_same_terminal_rebind_it() {
        let (effects, core) = setup();
        effects.submit("pty-s1");
        core.on_session_hook(on_terminal(hook("s3", "SessionStart"), "pty-s1"))
            .await;
        assert_eq!(pty_of(&effects, "s3"), Some("pty-s1".to_string()));
        assert_eq!(pty_of(&effects, "s1"), None);
        advance(SUBMIT_WINDOW + SECOND).await;
        core.on_session_hook(on_terminal(hook("s1", "SessionStart"), "pty-s1"))
            .await;
        assert_eq!(pty_of(&effects, "s1"), None);
        effects.submit("pty-s1");
        core.on_session_hook(on_terminal(hook("s1", "SessionStart"), "pty-s1"))
            .await;
        assert_eq!(pty_of(&effects, "s1"), Some("pty-s1".to_string()));
        assert_eq!(pty_of(&effects, "s3"), None);
        assert_eq!(pty_of(&effects, "s2"), Some("pty-s2".to_string()));
    }

    #[tokio::test(start_paused = true)]
    async fn session_start_on_a_terminal_the_app_did_not_issue_is_ignored() {
        let (effects, core) = setup();
        effects.live_ptys.lock().insert("pty-shell".to_string());
        core.on_session_hook(on_terminal(hook("s3", "SessionStart"), "pty-shell"))
            .await;
        core.on_session_hook(on_terminal(hook("s4", "SessionStart"), "pty-ghost"))
            .await;
        assert_eq!(effects.session_info("s3"), None);
        assert_eq!(effects.session_info("s4"), None);
    }

    #[tokio::test(start_paused = true)]
    async fn a_rebound_terminal_is_announced_with_its_new_session() {
        let (effects, core) = setup();
        core.on_session_hook(on_terminal(hook("s1", "SessionStart"), "pty-s1"))
            .await;
        core.on_session_hook(on_terminal(hook("s1", "SessionStart"), "pty-s2"))
            .await;
        core.on_session_hook(on_terminal(prompt("s3", "cześć"), "pty-s1"))
            .await;
        core.on_session_hook(on_terminal(hook("s3", "SessionStart"), "pty-s1"))
            .await;
        assert!(effects.rebounds.lock().is_empty());
        effects.submit("pty-s1");
        core.on_session_hook(on_terminal(hook("s3", "SessionStart"), "pty-s1"))
            .await;
        core.on_session_hook(on_terminal(hook("s1", "SessionStart"), "pty-s1"))
            .await;
        let rebound = |session_id: &str| SessionRebound {
            pty_id: "pty-s1".into(),
            session_id: session_id.into(),
        };
        assert_eq!(*effects.rebounds.lock(), vec![rebound("s3"), rebound("s1")]);
    }

    #[tokio::test(start_paused = true)]
    async fn the_same_session_reporting_its_terminal_keeps_its_state() {
        let (effects, core) = setup();
        core.set_away(true);
        core.on_session_hook(on_terminal(stop("s1", "Czy kontynuować?"), "pty-s1"))
            .await;
        let question_id = only_question_id(core.take_events());
        core.answer_question(&question_id, Some("tak".into()), None, "x")
            .unwrap();
        core.tick();
        assert_eq!(
            effects.typed(),
            vec![("pty-s1".to_string(), "[agent sterujący] tak\r".to_string())]
        );
    }

    #[test]
    fn injections_are_capped_on_a_char_boundary() {
        let mut state = CoreState::default();
        let long = format!("[agent sterujący] {}", "ż".repeat(MAX_INITIAL_PROMPT_BYTES));
        assert!(state.queue_injection("s1", &long));
        let queued = &state.injections[0].text;
        assert!(queued.len() <= MAX_INITIAL_PROMPT_BYTES, "{}", queued.len());
        assert!(queued.len() > MAX_INITIAL_PROMPT_BYTES - 8);
        assert!(queued.starts_with("[agent sterujący] żż"));
        assert!(queued.ends_with('…'));
        let exact = "a".repeat(MAX_INITIAL_PROMPT_BYTES);
        assert!(state.queue_injection("s2", &exact));
        assert_eq!(state.injections[1].text, exact);
    }

    #[test]
    fn injections_are_flattened_to_one_line() {
        assert_eq!(
            single_line("  a\r\nb\tc\x1b\x03\x7fd\u{85}e\u{2028}f  "),
            "a b c d e f"
        );
        let mut state = CoreState::default();
        assert!(!state.queue_injection("s1", "\r\n\x1b\x03\t"));
        assert!(state.injections.is_empty());
        assert!(state.queue_injection("s1", "[agent sterujący] tak\rgit push"));
        assert_eq!(state.injections[0].text, "[agent sterujący] tak git push");
    }

    #[tokio::test(start_paused = true)]
    async fn answer_with_control_characters_is_typed_as_one_line() {
        let (effects, core) = setup();
        core.set_away(true);
        core.on_session_hook(stop("s1", "Czy kontynuować?")).await;
        let question_id = only_question_id(core.take_events());
        core.answer_question(
            &question_id,
            Some("tak\rgit push\x1b origin\x03main".into()),
            None,
            "x",
        )
        .unwrap();
        core.tick();
        core.tick();
        assert_eq!(
            effects.typed(),
            vec![(
                "pty-s1".to_string(),
                "[agent sterujący] tak git push origin main\r".to_string()
            )]
        );
        core.on_session_hook(prompt("s1", "[agent sterujący] tak git push origin main"))
            .await;
        assert_eq!(
            core.state.lock().provenance.origin("s1"),
            PromptOrigin::Supervisor
        );
    }

    #[tokio::test(start_paused = true)]
    async fn control_only_answer_is_refused() {
        let (effects, core) = setup();
        core.set_away(true);
        core.on_session_hook(stop("s1", "Czy kontynuować?")).await;
        let question_id = only_question_id(core.take_events());
        assert!(core
            .answer_question(&question_id, Some("\r\n\x1b\x03\u{7f}".into()), None, "x")
            .is_err());
        core.tick();
        assert!(effects.typed().is_empty());
        assert!(effects.kinds().is_empty());
        assert!(core
            .answer_question(&question_id, Some("tak".into()), None, "x")
            .is_ok());
    }

    const ROUTED_SUMMARY: &str = "Wariant wybiera użytkownik";

    async fn handed_question(core: &Arc<SupervisorCore>, session_id: &str) -> String {
        core.on_session_hook(stop(session_id, "Który wariant wybrać?"))
            .await;
        advance(61 * SECOND).await;
        core.tick();
        only_question_id(core.take_events())
    }

    async fn escalated_channel(core: &Arc<SupervisorCore>, session_id: &str) -> EscalationChannel {
        let question_id = handed_question(core, session_id).await;
        let outcome = core.escalate(&[question_id], ROUTED_SUMMARY).unwrap();
        assert!(outcome.skipped.is_empty());
        outcome.channel
    }

    fn escalation_channels(core: &SupervisorCore) -> Vec<EscalationChannel> {
        core.snapshot()
            .escalations
            .iter()
            .map(|escalation| escalation.channel)
            .collect()
    }

    fn forwarded_escalation(core: &SupervisorCore, session_id: &str) -> ForwardedEscalation {
        let question_id = core
            .snapshot()
            .escalations
            .iter()
            .find(|escalation| escalation.session_id == session_id)
            .map(|escalation| escalation.question_id.clone())
            .unwrap();
        ForwardedEscalation {
            session_id: session_id.into(),
            question_id,
            label: format!("projekt · {session_id}"),
            summary: ROUTED_SUMMARY.into(),
        }
    }

    fn guard_channels(events: &[SupervisorEvent]) -> Vec<(String, EscalationChannel)> {
        events
            .iter()
            .filter_map(|event| match event {
                SupervisorEvent::GuardBlocked {
                    session_id,
                    channel,
                    ..
                } => Some((session_id.clone(), *channel)),
                _ => None,
            })
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn escalation_keeps_the_question_id() {
        let (_effects, core) = setup();
        let question_id = handed_question(&core, "s1").await;
        core.escalate(&[question_id.clone()], ROUTED_SUMMARY)
            .unwrap();
        assert_eq!(core.snapshot().escalations[0].question_id, question_id);
    }

    #[tokio::test(start_paused = true)]
    async fn forwarded_escalations_carry_the_question_id() {
        let (_effects, core) = setup();
        core.set_discord_active(true);
        core.report_activity(None);
        let question_id = handed_question(&core, "s1").await;
        core.escalate(&[question_id.clone()], ROUTED_SUMMARY)
            .unwrap();
        assert!(core.take_events().is_empty());
        core.set_away(true);
        let events = core.take_events();
        let forwarded = match &events[0] {
            SupervisorEvent::Forwarded { escalations, .. } => escalations.clone(),
            other => panic!("unexpected event {other:?}"),
        };
        assert_eq!(forwarded[0].question_id, question_id);
    }

    #[tokio::test(start_paused = true)]
    async fn escalation_goes_to_discord_when_away_and_active() {
        let (effects, core) = setup();
        core.set_discord_active(true);
        assert!(effects.last_snapshot().unwrap().discord_active);
        core.set_away(true);
        assert_eq!(
            escalated_channel(&core, "s1").await,
            EscalationChannel::Discord
        );
        assert!(effects.notifications().is_empty());
        assert_eq!(
            effects.attentions(),
            vec![(
                "s1".to_string(),
                format!("Agent sterujący przekazał Ci pytanie: {ROUTED_SUMMARY}")
            )]
        );
        let snapshot = core.snapshot();
        assert!(snapshot.discord_active);
        assert_eq!(snapshot.escalations.len(), 1);
        assert_eq!(snapshot.escalations[0].channel, EscalationChannel::Discord);
        assert_eq!(effects.kinds(), vec![decision_kind::ESCALATED]);
        assert!(core.take_events().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn escalation_stays_in_app_when_present_and_muted() {
        let (effects, core) = setup();
        assert!(effects.settings.lock().discord_mute_when_present);
        core.set_discord_active(true);
        core.report_activity(None);
        assert_eq!(escalated_channel(&core, "s1").await, EscalationChannel::App);
        assert_eq!(effects.notifications().len(), 1);
        assert_eq!(effects.attentions().len(), 1);
        assert_eq!(escalation_channels(&core), vec![EscalationChannel::App]);
    }

    #[tokio::test(start_paused = true)]
    async fn escalation_goes_to_discord_when_present_but_not_muted() {
        let (effects, core) = setup();
        effects.settings.lock().discord_mute_when_present = false;
        core.set_discord_active(true);
        core.report_activity(None);
        assert_eq!(
            escalated_channel(&core, "s1").await,
            EscalationChannel::Discord
        );
        assert!(effects.notifications().is_empty());
        assert_eq!(effects.attentions().len(), 1);
        assert_eq!(escalation_channels(&core), vec![EscalationChannel::Discord]);
    }

    #[tokio::test(start_paused = true)]
    async fn escalation_stays_in_app_when_discord_inactive() {
        let (effects, core) = setup();
        core.set_away(true);
        assert_eq!(escalated_channel(&core, "s1").await, EscalationChannel::App);
        assert_eq!(effects.notifications().len(), 1);
        assert_eq!(effects.attentions().len(), 1);
        let snapshot = core.snapshot();
        assert!(!snapshot.discord_active);
        assert_eq!(snapshot.escalations[0].channel, EscalationChannel::App);
    }

    #[tokio::test(start_paused = true)]
    async fn guard_block_routes_like_escalations() {
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        core.set_discord_active(true);
        core.set_away(true);
        assert!(matches!(
            core.on_session_hook(bash("s1", "git push")).await,
            HookReply::Deny { .. }
        ));
        assert_eq!(
            guard_channels(&core.take_events()),
            vec![("s1".to_string(), EscalationChannel::Discord)]
        );
        assert!(effects.notifications().is_empty());
        let approvals = core.snapshot().approvals;
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].channel, EscalationChannel::Discord);
        core.set_away(false);
        core.report_activity(None);
        core.on_session_hook(bash("s2", "git push")).await;
        assert_eq!(
            guard_channels(&core.take_events()),
            vec![("s2".to_string(), EscalationChannel::App)]
        );
        assert_eq!(effects.notifications().len(), 1);
        assert_eq!(effects.notifications()[0].0, "s2");
        let approval = core
            .snapshot()
            .approvals
            .into_iter()
            .find(|approval| approval.session_id == "s2")
            .unwrap();
        assert_eq!(approval.channel, EscalationChannel::App);
    }

    #[tokio::test(start_paused = true)]
    async fn leaving_forwards_open_app_escalations_once() {
        let (effects, core) = setup();
        core.set_discord_active(true);
        core.report_activity(None);
        assert_eq!(escalated_channel(&core, "s1").await, EscalationChannel::App);
        assert!(core.take_events().is_empty());
        core.set_away(true);
        assert_eq!(
            core.take_events(),
            vec![SupervisorEvent::Forwarded {
                escalations: vec![forwarded_escalation(&core, "s1")],
                approvals: Vec::new(),
            }]
        );
        assert_eq!(escalation_channels(&core), vec![EscalationChannel::Discord]);
        assert_eq!(
            effects.last_snapshot().unwrap().escalations[0].channel,
            EscalationChannel::Discord
        );
        assert_eq!(effects.notifications().len(), 1);
        core.set_away(false);
        assert!(core.snapshot().present);
        core.set_away(true);
        assert!(core.take_events().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn leaving_forwards_only_pending_app_approvals() {
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        core.set_discord_active(true);
        core.report_activity(None);
        core.on_session_hook(bash("s1", "git push")).await;
        core.on_session_hook(bash("s2", "git push")).await;
        let approvals = core.snapshot().approvals;
        let pending = approvals
            .iter()
            .find(|approval| approval.session_id == "s1")
            .unwrap()
            .clone();
        let resolved = approvals
            .iter()
            .find(|approval| approval.session_id == "s2")
            .unwrap()
            .clone();
        core.resolve_approval(&resolved.id, true, ApprovalSource::App)
            .unwrap();
        core.take_events();
        core.set_away(true);
        assert_eq!(
            core.take_events(),
            vec![SupervisorEvent::Forwarded {
                escalations: Vec::new(),
                approvals: vec![ForwardedApproval {
                    approval_id: pending.id.clone(),
                    label: "projekt · s1".into(),
                    action: "git push → main".into(),
                    code: pending.code.clone(),
                }],
            }]
        );
        let approvals = core.snapshot().approvals;
        assert_eq!(approvals.len(), 1);
        assert_eq!(approvals[0].id, pending.id);
        assert_eq!(approvals[0].channel, EscalationChannel::Discord);
    }

    #[tokio::test(start_paused = true)]
    async fn leaving_without_discord_forwards_nothing() {
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        core.report_activity(None);
        assert_eq!(escalated_channel(&core, "s1").await, EscalationChannel::App);
        core.on_session_hook(bash("s2", "git push")).await;
        core.take_events();
        core.set_away(true);
        assert!(core.take_events().is_empty());
        let snapshot = core.snapshot();
        assert_eq!(snapshot.escalations[0].channel, EscalationChannel::App);
        assert_eq!(snapshot.approvals[0].channel, EscalationChannel::App);
        core.set_away(false);
        core.set_discord_active(true);
        assert!(core.take_events().is_empty());
        assert_eq!(escalation_channels(&core), vec![EscalationChannel::App]);
    }

    #[tokio::test(start_paused = true)]
    async fn activating_discord_while_away_forwards_open_app_items_once() {
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        core.set_away(true);
        assert_eq!(escalated_channel(&core, "s1").await, EscalationChannel::App);
        core.on_session_hook(bash("s2", "git push")).await;
        let approval = core.snapshot().approvals[0].clone();
        assert_eq!(approval.channel, EscalationChannel::App);
        core.take_events();
        core.set_discord_active(true);
        core.set_discord_active(true);
        assert_eq!(
            core.take_events(),
            vec![SupervisorEvent::Forwarded {
                escalations: vec![forwarded_escalation(&core, "s1")],
                approvals: vec![ForwardedApproval {
                    approval_id: approval.id.clone(),
                    label: "projekt · s2".into(),
                    action: "git push → main".into(),
                    code: approval.code.clone(),
                }],
            }]
        );
        let published = effects.last_snapshot().unwrap();
        assert_eq!(published.escalations[0].channel, EscalationChannel::Discord);
        assert_eq!(published.approvals[0].channel, EscalationChannel::Discord);
        core.set_discord_active(false);
        core.set_discord_active(true);
        assert!(core.take_events().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn activating_discord_while_present_and_muted_forwards_nothing() {
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        core.report_activity(None);
        assert_eq!(escalated_channel(&core, "s1").await, EscalationChannel::App);
        core.on_session_hook(bash("s2", "git push")).await;
        core.take_events();
        core.set_discord_active(true);
        assert!(core.take_events().is_empty());
        let snapshot = core.snapshot();
        assert_eq!(snapshot.escalations[0].channel, EscalationChannel::App);
        assert_eq!(snapshot.approvals[0].channel, EscalationChannel::App);
    }

    #[tokio::test(start_paused = true)]
    async fn escalations_answered_by_relay_are_not_forwarded() {
        let (effects, core) = setup();
        core.set_discord_active(true);
        core.report_activity(None);
        assert_eq!(escalated_channel(&core, "s1").await, EscalationChannel::App);
        core.send_to_session("s1", "Użytkownik wybrał wariant A")
            .unwrap();
        core.tick();
        assert_eq!(effects.typed().len(), 1);
        core.on_session_hook(prompt(
            "s1",
            "[agent sterujący] Użytkownik wybrał wariant A",
        ))
        .await;
        assert_eq!(escalation_channels(&core), vec![EscalationChannel::App]);
        core.take_events();
        core.set_away(true);
        assert!(core.take_events().is_empty());
        core.set_discord_active(false);
        core.set_discord_active(true);
        assert!(core.take_events().is_empty());
        assert_eq!(escalation_channels(&core), vec![EscalationChannel::App]);
    }

    #[tokio::test(start_paused = true)]
    async fn presence_timeout_forwards_on_tick() {
        let (effects, core) = setup();
        core.set_discord_active(true);
        core.report_activity(None);
        assert_eq!(escalated_channel(&core, "s1").await, EscalationChannel::App);
        let threshold = effects.settings.lock().presence;
        advance(threshold).await;
        assert!(core.take_events().is_empty());
        core.tick();
        assert!(!core.snapshot().present);
        assert_eq!(
            core.take_events(),
            vec![SupervisorEvent::Forwarded {
                escalations: vec![forwarded_escalation(&core, "s1")],
                approvals: Vec::new(),
            }]
        );
        assert_eq!(escalation_channels(&core), vec![EscalationChannel::Discord]);
        core.tick();
        assert!(core.take_events().is_empty());
    }

    fn forwarded_events(events: &[SupervisorEvent]) -> Vec<SupervisorEvent> {
        events
            .iter()
            .filter(|event| matches!(event, SupervisorEvent::Forwarded { .. }))
            .cloned()
            .collect()
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_menu_is_forwarded_when_away_and_active() {
        let (effects, core) = setup();
        core.set_discord_active(true);
        core.set_away(true);
        let handle = spawn_menu(&core, "s1").await;
        let question_id = only_question_id(core.take_events());
        advance(DECISION_WINDOW).await;
        core.tick();
        assert!(matches!(reply_of(handle).await, HookReply::Deny { .. }));
        assert_eq!(escalation_channels(&core), vec![EscalationChannel::Discord]);
        let events = core.take_events();
        assert_eq!(
            forwarded_events(&events),
            vec![SupervisorEvent::Forwarded {
                escalations: vec![ForwardedEscalation {
                    session_id: "s1".into(),
                    question_id,
                    label: "projekt · s1".into(),
                    summary: COLOR_QUESTION.into(),
                }],
                approvals: Vec::new(),
            }]
        );
        assert!(effects.notifications().is_empty());
        assert_eq!(effects.kinds(), vec![decision_kind::ESCALATED]);
    }

    #[tokio::test(start_paused = true)]
    async fn timed_out_menu_notifies_in_app_when_present_and_muted() {
        let (effects, core) = setup();
        assert!(effects.settings.lock().discord_mute_when_present);
        core.set_discord_active(true);
        core.report_activity(None);
        let handle = spawn_menu(&core, "s1").await;
        advance(60 * SECOND).await;
        core.tick();
        only_question_id(core.take_events());
        advance(DECISION_WINDOW).await;
        core.tick();
        assert!(matches!(reply_of(handle).await, HookReply::Deny { .. }));
        assert!(core.snapshot().present);
        assert_eq!(escalation_channels(&core), vec![EscalationChannel::App]);
        assert!(forwarded_events(&core.take_events()).is_empty());
        let notifications = effects.notifications();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].0, "s1");
    }

    #[tokio::test(start_paused = true)]
    async fn forwarded_event_wakes_the_supervisor() {
        let (effects, core) = setup();
        core.set_discord_active(true);
        core.report_activity(None);
        escalated_channel(&core, "s1").await;
        advance(WAKE_DEBOUNCE).await;
        core.tick();
        let before = effects.wakes();
        core.set_away(true);
        core.tick();
        assert_eq!(effects.wakes(), before);
        advance(WAKE_DEBOUNCE).await;
        core.tick();
        assert_eq!(effects.wakes(), before + 1);
        assert!(matches!(
            core.take_events().as_slice(),
            [SupervisorEvent::Forwarded { .. }]
        ));
    }

    fn session_settled(session_id: &str) -> DiscordSync {
        DiscordSync::SessionSettled {
            session_id: session_id.into(),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn human_prompt_settles_the_session_on_discord() {
        let (effects, core) = setup();
        effects.submit("pty-s1");
        core.on_session_hook(prompt("s1", "wybierz zielony")).await;
        assert_eq!(
            core.state.lock().provenance.origin("s1"),
            PromptOrigin::Human
        );
        assert_eq!(effects.discord_syncs(), vec![session_settled("s1")]);
    }

    #[tokio::test(start_paused = true)]
    async fn agent_prompt_does_not_settle_on_discord() {
        let (effects, core) = setup();
        core.on_session_hook(prompt("s1", "przygotuj wydanie"))
            .await;
        assert_eq!(
            core.state.lock().provenance.origin("s1"),
            PromptOrigin::Agent
        );
        assert!(effects.discord_syncs().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn dismissing_an_escalation_settles_its_question_on_discord() {
        let (effects, core) = setup();
        let question_id = handed_question(&core, "s1").await;
        core.escalate(&[question_id.clone()], ROUTED_SUMMARY)
            .unwrap();
        assert!(effects.discord_syncs().is_empty());
        core.dismiss_escalation("unknown");
        assert!(effects.discord_syncs().is_empty());
        let escalation_id = core.snapshot().escalations[0].id.clone();
        core.dismiss_escalation(&escalation_id);
        assert!(core.snapshot().escalations.is_empty());
        assert_eq!(
            effects.discord_syncs(),
            vec![DiscordSync::QuestionSettled { question_id }]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn rebind_settles_the_forgotten_session_on_discord() {
        let (effects, core) = setup();
        effects.submit("pty-s1");
        core.on_session_hook(on_terminal(hook("s3", "SessionStart"), "pty-s1"))
            .await;
        assert_eq!(pty_of(&effects, "s3"), Some("pty-s1".to_string()));
        assert_eq!(effects.discord_syncs(), vec![session_settled("s1")]);
    }

    fn clicked_option() -> ClickedOption {
        ClickedOption {
            question_id: "q1".into(),
            session_id: "s1".into(),
            label: "projekt · s1".into(),
            key: "S1".into(),
            question: "Specyfikacja etapu 2: akceptujesz?".into(),
            value: "tak".into(),
            open_keys: vec!["S2".into()],
        }
    }

    fn discord_answer_event() -> SupervisorEvent {
        SupervisorEvent::DiscordAnswer {
            question_id: "q1".into(),
            session_id: "s1".into(),
            label: "projekt · s1".into(),
            key: "S1".into(),
            question: "Specyfikacja etapu 2: akceptujesz?".into(),
            value: "tak".into(),
            open_keys: vec!["S2".into()],
        }
    }

    #[tokio::test(start_paused = true)]
    async fn accepts_discord_answers_is_false_when_off() {
        let (effects, core) = setup();
        assert!(!core.accepts_discord_answers());
        link_discord(&effects);
        assert!(core.accepts_discord_answers());
        effects.settings.lock().level = SupervisorLevel::Off;
        assert!(!core.accepts_discord_answers());
        effects.settings.lock().level = SupervisorLevel::Relay;
        assert!(core.accepts_discord_answers());
        effects.settings.lock().discord_enabled = false;
        assert!(!core.accepts_discord_answers());
        link_discord(&effects);
        effects.settings.lock().discord_chat_id = None;
        assert!(!core.accepts_discord_answers());
    }

    #[tokio::test(start_paused = true)]
    async fn accepts_discord_answers_while_the_supervisor_restarts() {
        let (effects, core) = setup();
        effects.settings.lock().level = SupervisorLevel::Assistant;
        link_discord(&effects);
        core.set_discord_active(true);
        core.set_discord_active(false);
        core.set_supervisor_state(false, false, None);
        assert!(core.accepts_discord_answers());
        core.record_discord_answer(clicked_option());
        core.set_supervisor_state(true, true, Some("pty-supervisor".into()));
        assert_eq!(core.take_events(), vec![discord_answer_event()]);
    }

    #[tokio::test(start_paused = true)]
    async fn record_discord_answer_queues_the_event() {
        let (effects, core) = setup();
        core.record_discord_answer(clicked_option());
        core.tick();
        assert_eq!(effects.wakes(), 0);
        advance(WAKE_DEBOUNCE).await;
        core.tick();
        assert_eq!(effects.wakes(), 1);
        assert_eq!(core.take_events(), vec![discord_answer_event()]);
    }
}

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::db::supervisor_decisions_repo::NewDecision;
use crate::domain::supervisor::{
    CardPhase, EscalationView, MenuQuestion, QuestionCardView, SupervisorLevel, SupervisorSnapshot,
};
use crate::sessions::reader::now_ms;
use crate::supervisor::effects::{Effects, SessionInfo};
use crate::supervisor::events::{QuestionKind, ResolvedBy, SupervisorEvent};
use crate::supervisor::hook_io::{menu_questions, HookInput, HookReply};
use crate::supervisor::presence::Presence;
use crate::supervisor::provenance::{PromptOrigin, ProvenanceTracker};
use crate::supervisor::settings::SupervisorSettings;

pub const ESCALATED_REASON: &str =
    "Pytanie przekazane użytkownikowi — poczekaj na jego odpowiedź w kolejnej wiadomości.";
pub const ANSWER_PREFIX: &str = "[agent sterujący] ";
pub const QUIET_WINDOW: Duration = Duration::from_secs(5);
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
const SUMMARY_CHARS: usize = 500;
const NOTIFICATION_CHARS: usize = 160;
const ESCALATION_TITLE: &str = "Agent sterujący: potrzebna Twoja decyzja";
const DECISION_ESCALATED: &str = "Przekazane użytkownikowi";
const DECISION_RELEASED: &str = "Pytanie oddane użytkownikowi";
const RATIONALE_DECISION_TIMEOUT: &str = "Agent nie podjął decyzji w ciągu 2 minut";
const RATIONALE_HOLD_CAP: &str = "Upłynął limit wstrzymania menu";
const RATIONALE_CARD_RELEASE: &str = "Użytkownik wybrał odpowiedź w terminalu";
const RATIONALE_HUMAN_PROMPT: &str = "Użytkownik odpowiedział w sesji";
const ERROR_UNKNOWN_QUESTION: &str = "Nie ma otwartego pytania o tym identyfikatorze";
const ERROR_IN_GRACE: &str = "Pytanie czeka jeszcze na odpowiedź użytkownika";
const ERROR_MISSING_ANSWERS: &str = "Odpowiedź na menu wymaga niepustego pola answers";
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
    provenance: ProvenanceTracker,
    sessions: HashMap<String, SessionState>,
    questions: Vec<Question>,
    injections: Vec<Injection>,
    next_injection: u64,
    escalations: Vec<EscalationView>,
    events: Vec<SupervisorEvent>,
    wake: WakeState,
    last_snapshot: Option<SupervisorSnapshot>,
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
        let (taken, kept) = std::mem::take(&mut self.questions)
            .into_iter()
            .partition(|question| question.session_id == session_id);
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
                    if let Some(question) = self.take_question(&question_id) {
                        self.withdraw_from_supervisor(&question);
                        let summary = question.summary();
                        self.escalate_question(
                            question,
                            summary,
                            RATIONALE_DECISION_TIMEOUT,
                            outbox,
                        );
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
        outbox: &mut Outbox,
    ) {
        question.reply(HookReply::Deny {
            reason: ESCALATED_REASON.to_string(),
        });
        self.session_mut(&question.session_id).awaiting_user = true;
        outbox.notifications.push((
            question.session_id.clone(),
            ESCALATION_TITLE.to_string(),
            format!(
                "{} — {}",
                question.label,
                excerpt(&summary, NOTIFICATION_CHARS)
            ),
        ));
        outbox.decisions.push(question.decision(
            decision_kind::ESCALATED,
            DECISION_ESCALATED.to_string(),
            rationale,
        ));
        self.escalations.push(EscalationView {
            id: Uuid::new_v4().to_string(),
            session_id: question.session_id,
            project_id: question.project_id,
            label: question.label,
            summary,
            created_at: now_ms(),
        });
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

    fn requeue_injection(&mut self, injection_id: u64, session_id: String, text: String) {
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
            escalations: self.escalations.clone(),
            approvals: Vec::new(),
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
        match input.hook_event_name.as_str() {
            "Stop" => {
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
            _ => HookReply::Empty,
        }
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
            );
        }
        self.publish_with(&settings);
    }

    fn on_user_prompt(&self, input: &HookInput) {
        let session_id = input.session_id.as_str();
        let prompt = input.prompt.as_deref().unwrap_or_default();
        let now = now();
        let mut outbox = Outbox::default();
        {
            let mut state = self.state.lock();
            let origin = state.provenance.on_user_prompt(session_id, prompt, now);
            let session = state.session_mut(session_id);
            session.at_prompt = false;
            if origin != PromptOrigin::Human {
                return;
            }
            session.awaiting_user = false;
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
        }
        self.flush(outbox);
        self.publish();
    }

    async fn on_menu(self: &Arc<Self>, input: HookInput) -> HookReply {
        let settings = self.effects.settings();
        let info = self.effects.session_info(&input.session_id);
        let tool_input = input.tool_input.unwrap_or_default();
        let questions = menu_questions(&tool_input);
        let original = tool_input.get("questions").cloned().unwrap_or_default();
        let (sender, receiver) = oneshot::channel();
        let now = now();
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
            state.open_question(&settings, info, &input.session_id, body, now)
        };
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
            state.advance_questions(&settings, now, &mut outbox);
        }
        self.flush(outbox);
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
                    .requeue_injection(injection_id, session_id, text);
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
        }
        self.publish_with(&settings);
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
        {
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
        }
        self.publish();
    }

    pub fn answer_question(
        &self,
        question_id: &str,
        text: Option<String>,
        answers: Option<HashMap<String, String>>,
        rationale: &str,
    ) -> Result<(), String> {
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
            if state.questions[index].is_menu() {
                let answers = answers
                    .filter(|answers| !answers.is_empty())
                    .ok_or_else(|| ERROR_MISSING_ANSWERS.to_string())?;
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
    use crate::supervisor::effects::SessionListing;
    use serde_json::json;
    use std::path::Path;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use tokio::task::JoinHandle;
    use tokio::time::advance;

    const SECOND: Duration = Duration::from_secs(1);
    const COLOR_QUESTION: &str = "Which color do you prefer?";

    struct FakeEffects {
        settings: Mutex<SupervisorSettings>,
        sessions: Mutex<HashMap<String, SessionInfo>>,
        quiet: AtomicBool,
        wake_accepts: AtomicBool,
        wakes: AtomicUsize,
        typed: Mutex<Vec<(String, String)>>,
        snapshots: Mutex<Vec<SupervisorSnapshot>>,
        notifications: Mutex<Vec<(String, String, String)>>,
        decisions: Mutex<Vec<NewDecision>>,
    }

    impl FakeEffects {
        fn new() -> Arc<FakeEffects> {
            let sessions = ["s1", "s2"]
                .iter()
                .enumerate()
                .map(|(index, id)| {
                    let info = SessionInfo {
                        label: format!("projekt · {id}"),
                        project_id: Some(index as i64 + 1),
                        project_path: Some(format!("/projects/{id}")),
                        pty_id: Some(format!("pty-{id}")),
                    };
                    (id.to_string(), info)
                })
                .collect();
            Arc::new(FakeEffects {
                settings: Mutex::new(SupervisorSettings {
                    level: SupervisorLevel::Assistant,
                    grace: Duration::from_secs(60),
                    presence: Duration::from_secs(300),
                    model_id: None,
                    extra_rules: Vec::new(),
                }),
                sessions: Mutex::new(sessions),
                quiet: AtomicBool::new(true),
                wake_accepts: AtomicBool::new(true),
                wakes: AtomicUsize::new(0),
                typed: Mutex::default(),
                snapshots: Mutex::default(),
                notifications: Mutex::default(),
                decisions: Mutex::default(),
            })
        }

        fn wakes(&self) -> usize {
            self.wakes.load(Ordering::SeqCst)
        }

        fn typed(&self) -> Vec<(String, String)> {
            self.typed.lock().clone()
        }

        fn kinds(&self) -> Vec<&'static str> {
            self.decisions
                .lock()
                .iter()
                .map(|entry| entry.kind)
                .collect()
        }

        fn notifications(&self) -> Vec<(String, String, String)> {
            self.notifications.lock().clone()
        }

        fn last_snapshot(&self) -> Option<SupervisorSnapshot> {
            self.snapshots.lock().last().cloned()
        }
    }

    impl Effects for FakeEffects {
        fn settings(&self) -> SupervisorSettings {
            self.settings.lock().clone()
        }

        fn session_info(&self, session_id: &str) -> Option<SessionInfo> {
            self.sessions.lock().get(session_id).cloned()
        }

        fn type_into_pty(&self, pty_id: &str, text: &str) -> Result<(), String> {
            self.typed
                .lock()
                .push((pty_id.to_string(), format!("{text}\r")));
            Ok(())
        }

        fn input_quiet(&self, _pty_id: &str, window: Duration) -> bool {
            assert_eq!(window, QUIET_WINDOW);
            self.quiet.load(Ordering::SeqCst)
        }

        fn current_branch(&self, _cwd: &Path) -> Option<String> {
            None
        }

        fn wake_supervisor(&self) -> bool {
            self.wakes.fetch_add(1, Ordering::SeqCst);
            self.wake_accepts.load(Ordering::SeqCst)
        }

        fn publish_snapshot(&self, snapshot: SupervisorSnapshot) {
            self.snapshots.lock().push(snapshot);
        }

        fn notify_desktop(&self, session_id: &str, title: &str, body: &str) {
            self.notifications.lock().push((
                session_id.to_string(),
                title.to_string(),
                body.to_string(),
            ));
        }

        fn log_decision(&self, entry: NewDecision) {
            self.decisions.lock().push(entry);
        }

        fn list_sessions(&self) -> Vec<SessionListing> {
            Vec::new()
        }

        fn read_session(&self, _session_id: &str, _max_blocks: usize) -> Option<String> {
            None
        }

        fn open_session(&self, _project_path: &str, _prompt: &str) -> Result<(), String> {
            Ok(())
        }
    }

    fn setup() -> (Arc<FakeEffects>, Arc<SupervisorCore>) {
        let effects = FakeEffects::new();
        let core = SupervisorCore::new(effects.clone());
        core.set_supervisor_state(true, true, Some("pty-supervisor".into()));
        (effects, core)
    }

    fn hook(session_id: &str, event: &str) -> HookInput {
        HookInput {
            session_id: session_id.to_string(),
            hook_event_name: event.to_string(),
            cwd: Some("/projects".into()),
            prompt: None,
            last_assistant_message: None,
            tool_name: None,
            tool_input: None,
            source: None,
        }
    }

    fn stop(session_id: &str, text: &str) -> HookInput {
        HookInput {
            last_assistant_message: Some(text.to_string()),
            ..hook(session_id, "Stop")
        }
    }

    fn prompt(session_id: &str, text: &str) -> HookInput {
        HookInput {
            prompt: Some(text.to_string()),
            ..hook(session_id, "UserPromptSubmit")
        }
    }

    fn menu_tool_input() -> Value {
        json!({"questions": [{
            "question": COLOR_QUESTION,
            "header": "Color",
            "multiSelect": false,
            "options": [{"label": "Red", "description": ""}, {"label": "Green", "description": ""}]
        }]})
    }

    fn menu(session_id: &str) -> HookInput {
        HookInput {
            tool_name: Some("AskUserQuestion".into()),
            tool_input: Some(menu_tool_input()),
            ..hook(session_id, "PreToolUse")
        }
    }

    async fn settle() {
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    async fn spawn_menu(core: &Arc<SupervisorCore>, session_id: &str) -> JoinHandle<HookReply> {
        let core = core.clone();
        let input = menu(session_id);
        let handle = tokio::spawn(async move { core.on_session_hook(input).await });
        settle().await;
        handle
    }

    async fn reply_of(handle: JoinHandle<HookReply>) -> HookReply {
        settle().await;
        assert!(handle.is_finished(), "the held hook has not been released");
        handle.await.unwrap()
    }

    fn only_card(core: &SupervisorCore) -> QuestionCardView {
        let cards = core.snapshot().cards;
        assert_eq!(cards.len(), 1, "expected exactly one card");
        cards.into_iter().next().unwrap()
    }

    fn only_question_id(events: Vec<SupervisorEvent>) -> String {
        match events.as_slice() {
            [SupervisorEvent::Question { question_id, .. }] => question_id.clone(),
            other => panic!("expected one question event, got {other:?}"),
        }
    }

    fn answer(question: &str, label: &str) -> HashMap<String, String> {
        HashMap::from([(question.to_string(), label.to_string())])
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
    async fn human_prompt_during_grace_cancels_question() {
        let (effects, core) = setup();
        core.report_activity(None);
        core.on_session_hook(stop("s1", "Czy mam kontynuować?"))
            .await;
        advance(30 * SECOND).await;
        core.tick();
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
        assert!(core.take_events().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn escalated_session_ignores_stop_until_human_prompt() {
        let (_effects, core) = setup();
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
}

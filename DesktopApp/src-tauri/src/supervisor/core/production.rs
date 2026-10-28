use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use super::{
    decision_kind, now, CoreState, HookInput, HookReply, Outbox, PromptOrigin, SupervisorCore,
    SupervisorEvent, SupervisorLevel, SupervisorSettings, ANSWER_PREFIX, GUARD_REASON,
};
use crate::db::supervisor_decisions_repo::NewDecision;
use crate::domain::supervisor::ApprovalView;
use crate::sessions::reader::now_ms;
use crate::supervisor::approvals::Approval;
use crate::supervisor::guard::{ProductionAction, ProductionRules};

const BASH_TOOL: &str = "Bash";
const RECORD_RETENTION: Duration = Duration::from_secs(7 * 24 * 3600);
const APPROVAL_TITLE: &str = "Zgoda na";
const ERROR_UNKNOWN_APPROVAL: &str = "Nie ma prośby o zgodę o tym identyfikatorze";
const ERROR_NOT_PENDING: &str = "Ta prośba o zgodę nie czeka już na decyzję";
const DECISION_BLOCKED: &str = "Wstrzymane do zgody użytkownika";
const DECISION_APPROVED: &str = "Użytkownik zatwierdził";
const DECISION_REJECTED: &str = "Użytkownik odrzucił";
const RATIONALE_SUPERVISOR_ORIGIN: &str = "Ostatni prompt sesji pochodził od agenta sterującego";
const RATIONALE_AGENT_ORIGIN: &str = "Sesja wystartowała z promptem od agenta";
const RATIONALE_USER_DECISION: &str = "Decyzja użytkownika";

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalState {
    Pending,
    Approved,
    Rejected,
    Expired,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ApprovalStatus {
    pub status: ApprovalState,
    pub code: String,
    pub action: String,
}

pub(super) struct ApprovalRecord {
    label: String,
    project_id: Option<i64>,
    action: String,
    code: String,
    created: Instant,
    outcome: Option<bool>,
}

fn approval_text(action: &str, approve: bool) -> String {
    if approve {
        format!("{ANSWER_PREFIX}Użytkownik zatwierdził: {action}. Wykonaj ją.")
    } else {
        format!("{ANSWER_PREFIX}Użytkownik nie zgodził się na: {action}.")
    }
}

impl CoreState {
    pub(super) fn approval_views(&self, now: Instant) -> Vec<ApprovalView> {
        self.approvals
            .pending(now)
            .into_iter()
            .map(|approval| {
                let record = self.approval_records.get(&approval.id);
                ApprovalView {
                    label: record
                        .map(|record| record.label.clone())
                        .unwrap_or_else(|| approval.session_id.clone()),
                    project_id: record.and_then(|record| record.project_id),
                    id: approval.id,
                    session_id: approval.session_id,
                    action: approval.action,
                    code: approval.code,
                    created_at: approval.created_at_ms,
                }
            })
            .collect()
    }

    fn block_production(
        &mut self,
        approval: Approval,
        label: String,
        project_id: Option<i64>,
        origin: PromptOrigin,
        now: Instant,
        outbox: &mut Outbox,
    ) {
        let rationale = match origin {
            PromptOrigin::Agent => RATIONALE_AGENT_ORIGIN,
            _ => RATIONALE_SUPERVISOR_ORIGIN,
        };
        outbox.notifications.push((
            approval.session_id.clone(),
            format!("{APPROVAL_TITLE}: {}", approval.action),
            format!(
                "{label} — kod {}. Zatwierdź lub odrzuć w panelu agenta sterującego.",
                approval.code
            ),
        ));
        outbox.decisions.push(NewDecision {
            created_at: approval.created_at_ms,
            session_id: Some(approval.session_id.clone()),
            kind: decision_kind::GUARD_BLOCKED,
            question: approval.action.clone(),
            decision: format!("{DECISION_BLOCKED} (kod {})", approval.code),
            rationale: rationale.to_string(),
        });
        self.push_event(
            SupervisorEvent::GuardBlocked {
                approval_id: approval.id.clone(),
                session_id: approval.session_id.clone(),
                label: label.clone(),
                action: approval.action.clone(),
                code: approval.code.clone(),
            },
            now,
        );
        self.approval_records
            .retain(|_, record| now.saturating_duration_since(record.created) < RECORD_RETENTION);
        self.approval_records.insert(
            approval.id,
            ApprovalRecord {
                label,
                project_id,
                action: approval.action,
                code: approval.code,
                created: now,
                outcome: None,
            },
        );
    }
}

impl SupervisorCore {
    pub(super) async fn on_guarded_tool(&self, input: &HookInput) -> HookReply {
        let Some(tool_name) = input.tool_name.as_deref() else {
            return HookReply::Empty;
        };
        let settings = self.effects.settings();
        if settings.level == SupervisorLevel::Off
            || self.origin(&input.session_id) == PromptOrigin::Human
        {
            return HookReply::Empty;
        }
        let tool_input = input.tool_input.clone().unwrap_or_default();
        let branch = match (tool_name, input.cwd.as_deref()) {
            (BASH_TOOL, Some(cwd)) => self.current_branch(PathBuf::from(cwd)).await,
            _ => None,
        };
        let rules = ProductionRules::new(&settings.extra_rules);
        match rules.classify(tool_name, &tool_input, branch.as_deref()) {
            Some(action) => self.hold_for_approval(&settings, &input.session_id, action),
            None => HookReply::Empty,
        }
    }

    fn origin(&self, session_id: &str) -> PromptOrigin {
        self.state.lock().provenance.origin(session_id)
    }

    async fn current_branch(&self, cwd: PathBuf) -> Option<String> {
        let effects = Arc::clone(&self.effects);
        tokio::task::spawn_blocking(move || effects.current_branch(&cwd))
            .await
            .ok()
            .flatten()
    }

    fn hold_for_approval(
        &self,
        settings: &SupervisorSettings,
        session_id: &str,
        action: ProductionAction,
    ) -> HookReply {
        let info = self.effects.session_info(session_id);
        let label = info
            .as_ref()
            .map_or_else(|| session_id.to_string(), |info| info.label.clone());
        let project_id = info.and_then(|info| info.project_id);
        let now = now();
        let mut outbox = Outbox::default();
        let created = {
            let mut state = self.state.lock();
            let origin = state.provenance.origin(session_id);
            if origin == PromptOrigin::Human
                || state
                    .approvals
                    .consume_token(session_id, &action.label, now)
            {
                return HookReply::Empty;
            }
            let (approval, created) =
                state
                    .approvals
                    .create(session_id, &action.label, now, now_ms());
            if created {
                state.block_production(approval, label, project_id, origin, now, &mut outbox);
            }
            created
        };
        if created {
            self.flush(outbox);
            self.publish_with(settings);
        }
        HookReply::Deny {
            reason: GUARD_REASON.to_string(),
        }
    }

    pub fn resolve_approval(&self, approval_id: &str, approve: bool) -> Result<(), String> {
        let now = now();
        let entry = {
            let mut state = self.state.lock();
            let Some(approval) = state.approvals.resolve(approval_id, approve, now) else {
                return Err(if state.approval_records.contains_key(approval_id) {
                    ERROR_NOT_PENDING
                } else {
                    ERROR_UNKNOWN_APPROVAL
                }
                .to_string());
            };
            if let Some(record) = state.approval_records.get_mut(approval_id) {
                record.outcome = Some(approve);
            }
            state.queue_injection(
                &approval.session_id,
                &approval_text(&approval.action, approve),
            );
            state.push_event(
                SupervisorEvent::ApprovalResolved {
                    approval_id: approval.id.clone(),
                    approved: approve,
                },
                now,
            );
            let (kind, decision) = if approve {
                (decision_kind::APPROVED, DECISION_APPROVED)
            } else {
                (decision_kind::REJECTED, DECISION_REJECTED)
            };
            NewDecision {
                created_at: now_ms(),
                session_id: Some(approval.session_id),
                kind,
                question: approval.action,
                decision: format!("{decision} (kod {})", approval.code),
                rationale: RATIONALE_USER_DECISION.to_string(),
            }
        };
        self.effects.log_decision(entry);
        self.publish();
        Ok(())
    }

    pub fn approval_status(&self, approval_id: &str) -> Result<ApprovalStatus, String> {
        let now = now();
        let state = self.state.lock();
        let record = state
            .approval_records
            .get(approval_id)
            .ok_or_else(|| ERROR_UNKNOWN_APPROVAL.to_string())?;
        let pending = state
            .approvals
            .pending(now)
            .iter()
            .any(|approval| approval.id == approval_id);
        let status = match record.outcome {
            Some(true) => ApprovalState::Approved,
            Some(false) => ApprovalState::Rejected,
            None if pending => ApprovalState::Pending,
            None => ApprovalState::Expired,
        };
        Ok(ApprovalStatus {
            status,
            code: record.code.clone(),
            action: record.action.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    use crate::domain::supervisor::ApprovalView;
    use crate::supervisor::test_support::*;
    use serde_json::json;
    use std::path::PathBuf;
    use std::sync::atomic::Ordering;
    use tokio::time::advance;

    const DAY: Duration = Duration::from_secs(24 * 3600);
    const PUSH_ACTION: &str = "git push → main";
    const APPROVED_TEXT: &str =
        "[agent sterujący] Użytkownik zatwierdził: git push → main. Wykonaj ją.";
    const REJECTED_TEXT: &str = "[agent sterujący] Użytkownik nie zgodził się na: git push → main.";

    fn guard_denial() -> HookReply {
        HookReply::Deny {
            reason: "Ta operacja wymaga zgody użytkownika. Nie ponawiaj jej — agent sterujący poprosił użytkownika o zgodę.".into(),
        }
    }

    fn on_main() -> (Arc<FakeEffects>, Arc<SupervisorCore>) {
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        (effects, core)
    }

    async fn answered_by_supervisor(effects: &FakeEffects, core: &Arc<SupervisorCore>) {
        core.set_away(true);
        core.on_session_hook(stop("s1", "Czy wypchnąć zmiany?"))
            .await;
        let question_id = only_question_id(core.take_events());
        core.answer_question(&question_id, Some("tak, wypchnij".into()), None, "plan")
            .unwrap();
        core.tick();
        assert_eq!(
            effects.typed().last().map(|(_, text)| text.as_str()),
            Some("[agent sterujący] tak, wypchnij\r")
        );
        core.on_session_hook(prompt("s1", "[agent sterujący] tak, wypchnij"))
            .await;
    }

    async fn agent_prompted(core: &Arc<SupervisorCore>, session_id: &str) {
        core.expect_cli_prompt(session_id, "przygotuj wydanie");
        core.on_session_hook(prompt(session_id, "przygotuj wydanie"))
            .await;
        assert_eq!(
            core.state.lock().provenance.origin(session_id),
            PromptOrigin::Agent
        );
    }

    fn only_approval(core: &SupervisorCore) -> ApprovalView {
        let approvals = core.snapshot().approvals;
        assert_eq!(approvals.len(), 1, "expected exactly one approval");
        approvals.into_iter().next().unwrap()
    }

    fn resolutions(events: &[SupervisorEvent]) -> Vec<(String, bool)> {
        events
            .iter()
            .filter_map(|event| match event {
                SupervisorEvent::ApprovalResolved {
                    approval_id,
                    approved,
                } => Some((approval_id.clone(), *approved)),
                _ => None,
            })
            .collect()
    }

    fn require_send<F: Send>(_future: &F) {}

    #[test]
    fn session_hook_future_is_send() {
        let (_effects, core) = setup();
        let future = core.on_session_hook(bash("s1", "git push"));
        require_send(&future);
    }

    #[tokio::test(start_paused = true)]
    async fn guard_ignores_human_origin() {
        let (effects, core) = on_main();
        core.on_session_hook(prompt("s1", "zrób push")).await;
        assert_eq!(
            core.on_session_hook(bash("s1", "git push")).await,
            HookReply::Empty
        );
        assert!(core.snapshot().approvals.is_empty());
        assert!(core.take_events().is_empty());
        assert!(effects.kinds().is_empty());
        assert!(effects.notifications().is_empty());
        assert!(effects.branch_lookups.lock().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn guard_blocks_after_supervisor_answer() {
        let (effects, core) = on_main();
        answered_by_supervisor(&effects, &core).await;
        assert_eq!(
            core.on_session_hook(bash("s1", "git push")).await,
            guard_denial()
        );
        assert_eq!(
            *effects.branch_lookups.lock(),
            vec![PathBuf::from("/projects")]
        );
        let approval = only_approval(&core);
        assert_eq!(approval.code.chars().count(), 4);
        assert_eq!(approval.action, PUSH_ACTION);
        assert_eq!(approval.session_id, "s1");
        assert_eq!(approval.label, "projekt · s1");
        assert_eq!(approval.project_id, Some(1));
        assert!(approval.created_at > 0);
        assert_eq!(
            effects.last_snapshot().unwrap().approvals,
            vec![approval.clone()]
        );
        assert_eq!(
            core.take_events(),
            vec![SupervisorEvent::GuardBlocked {
                approval_id: approval.id.clone(),
                session_id: "s1".into(),
                label: "projekt · s1".into(),
                action: PUSH_ACTION.into(),
                code: approval.code.clone(),
            }]
        );
        assert_eq!(
            effects.kinds(),
            vec![decision_kind::ANSWERED, decision_kind::GUARD_BLOCKED]
        );
        let notifications = effects.notifications();
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].0, "s1");
        assert_eq!(notifications[0].1, "Zgoda na: git push → main");
        assert!(notifications[0].2.contains("projekt · s1"));
        assert!(notifications[0].2.contains(&approval.code));

        assert_eq!(
            core.on_session_hook(bash("s1", "git push origin main"))
                .await,
            guard_denial()
        );
        assert_eq!(only_approval(&core).id, approval.id);
        assert!(core.take_events().is_empty());
        assert_eq!(effects.kinds().len(), 2);
        assert_eq!(effects.notifications().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn guard_blocks_after_supervisor_menu_answer() {
        let (_effects, core) = on_main();
        core.set_away(true);
        let handle = spawn_menu(&core, "s1").await;
        let question_id = only_question_id(core.take_events());
        core.answer_question(
            &question_id,
            None,
            Some(answer(COLOR_QUESTION, "Green")),
            "preferencje",
        )
        .unwrap();
        assert!(matches!(
            reply_of(handle).await,
            HookReply::AnswerMenu { .. }
        ));
        assert_eq!(
            core.on_session_hook(bash("s1", "git push")).await,
            guard_denial()
        );
        assert_eq!(only_approval(&core).action, PUSH_ACTION);
    }

    #[tokio::test(start_paused = true)]
    async fn guard_block_wakes_the_supervisor() {
        let (effects, core) = on_main();
        agent_prompted(&core, "s1").await;
        core.on_session_hook(bash("s1", "git push")).await;
        advance(WAKE_DEBOUNCE).await;
        core.tick();
        assert_eq!(effects.wakes(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn guard_blocks_cli_prompt_session() {
        let (effects, core) = on_main();
        agent_prompted(&core, "s1").await;
        assert_eq!(
            core.on_session_hook(bash("s1", "task release:patch --yes"))
                .await,
            guard_denial()
        );
        assert_eq!(only_approval(&core).action, "task release");
        assert_eq!(effects.kinds(), vec![decision_kind::GUARD_BLOCKED]);
        core.on_session_hook(prompt("s1", "tak, wydaj wersję"))
            .await;
        assert_eq!(
            core.on_session_hook(bash("s1", "task release:patch --yes"))
                .await,
            HookReply::Empty
        );
    }

    #[tokio::test(start_paused = true)]
    async fn guard_holds_without_supervisor_process_or_pty() {
        let (effects, core) = on_main();
        agent_prompted(&core, "s1").await;
        core.set_supervisor_state(false, false, None);
        effects.sessions.lock().get_mut("s1").unwrap().pty_id = None;
        assert_eq!(
            core.on_session_hook(bash("s1", "git push")).await,
            guard_denial()
        );
        assert_eq!(only_approval(&core).action, PUSH_ACTION);
        assert_eq!(effects.notifications().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn guard_is_inert_at_level_off() {
        let (effects, core) = on_main();
        agent_prompted(&core, "s1").await;
        effects.settings.lock().level = SupervisorLevel::Off;
        assert_eq!(
            core.on_session_hook(bash("s1", "git push")).await,
            HookReply::Empty
        );
        assert!(core.snapshot().approvals.is_empty());
        assert!(effects.branch_lookups.lock().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn guard_covers_mcp_tools_and_extra_rules() {
        let (effects, core) = on_main();
        effects.settings.lock().extra_rules = vec!["bash:^kubectl apply".into()];
        agent_prompted(&core, "s1").await;
        let deploy = HookInput {
            tool_name: Some("mcp__bandzior__deployment_deploy".into()),
            tool_input: Some(json!({"id": 3})),
            ..hook("s1", "PreToolUse")
        };
        assert_eq!(core.on_session_hook(deploy).await, guard_denial());
        let lookup = HookInput {
            tool_name: Some("mcp__bandzior__project_find".into()),
            tool_input: Some(json!({"query": "x"})),
            ..hook("s1", "PreToolUse")
        };
        assert_eq!(core.on_session_hook(lookup).await, HookReply::Empty);
        assert!(effects.branch_lookups.lock().is_empty());
        assert_eq!(
            core.on_session_hook(bash("s1", "kubectl apply -f prod.yaml"))
                .await,
            guard_denial()
        );
        assert_eq!(
            core.on_session_hook(bash("s1", "git status")).await,
            HookReply::Empty
        );
        let mut actions: Vec<String> = core
            .snapshot()
            .approvals
            .into_iter()
            .map(|approval| approval.action)
            .collect();
        actions.sort();
        assert_eq!(
            actions,
            vec![
                "kubectl apply -f prod.yaml",
                "mcp__bandzior__deployment_deploy"
            ]
        );
    }

    #[tokio::test(start_paused = true)]
    async fn guard_fails_safe_without_cwd() {
        let (effects, core) = on_main();
        agent_prompted(&core, "s1").await;
        let push = HookInput {
            cwd: None,
            ..bash("s1", "git push")
        };
        assert_eq!(core.on_session_hook(push).await, guard_denial());
        assert_eq!(only_approval(&core).action, "git push → ?");
        assert!(effects.branch_lookups.lock().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn approval_allows_exactly_once() {
        let (effects, core) = on_main();
        answered_by_supervisor(&effects, &core).await;
        assert_eq!(
            core.on_session_hook(bash("s1", "git push")).await,
            guard_denial()
        );
        let approval = only_approval(&core);
        core.on_session_hook(stop("s1", "Potrzebuję zgody na push."))
            .await;
        let typed_before = effects.typed().len();
        effects.quiet.store(false, Ordering::SeqCst);
        core.resolve_approval(&approval.id, true).unwrap();
        assert!(core.snapshot().approvals.is_empty());
        assert!(effects.last_snapshot().unwrap().approvals.is_empty());
        core.tick();
        advance(5 * SECOND).await;
        core.tick();
        assert_eq!(effects.typed().len(), typed_before);
        effects.quiet.store(true, Ordering::SeqCst);
        core.tick();
        assert_eq!(
            effects.typed().last(),
            Some(&("pty-s1".to_string(), format!("{APPROVED_TEXT}\r")))
        );
        assert_eq!(effects.typed().len(), typed_before + 1);
        assert_eq!(
            resolutions(&core.take_events()),
            vec![(approval.id.clone(), true)]
        );
        assert_eq!(
            effects.kinds().last().copied(),
            Some(decision_kind::APPROVED)
        );
        core.on_session_hook(prompt("s1", APPROVED_TEXT)).await;
        assert_eq!(
            core.state.lock().provenance.origin("s1"),
            PromptOrigin::Supervisor
        );
        assert_eq!(
            core.on_session_hook(bash("s1", "git push")).await,
            HookReply::Empty
        );
        assert_eq!(
            core.on_session_hook(bash("s1", "git push")).await,
            guard_denial()
        );
        assert_ne!(only_approval(&core).id, approval.id);
        assert!(core.resolve_approval(&approval.id, true).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn rejection_types_refusal_and_keeps_blocking() {
        let (effects, core) = on_main();
        answered_by_supervisor(&effects, &core).await;
        core.on_session_hook(bash("s1", "git push")).await;
        let approval = only_approval(&core);
        core.on_session_hook(stop("s1", "Potrzebuję zgody na push."))
            .await;
        core.resolve_approval(&approval.id, false).unwrap();
        core.tick();
        assert_eq!(
            effects.typed().last(),
            Some(&("pty-s1".to_string(), format!("{REJECTED_TEXT}\r")))
        );
        assert_eq!(
            resolutions(&core.take_events()),
            vec![(approval.id.clone(), false)]
        );
        assert_eq!(
            effects.kinds().last().copied(),
            Some(decision_kind::REJECTED)
        );
        core.on_session_hook(prompt("s1", REJECTED_TEXT)).await;
        assert_eq!(
            core.on_session_hook(bash("s1", "git push")).await,
            guard_denial()
        );
        let renewed = only_approval(&core);
        assert_ne!(renewed.id, approval.id);
        assert!(core.resolve_approval(&approval.id, false).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn approval_status_follows_the_lifecycle() {
        let (_effects, core) = on_main();
        agent_prompted(&core, "s1").await;
        agent_prompted(&core, "s2").await;
        core.on_session_hook(bash("s1", "git push")).await;
        core.on_session_hook(bash("s2", "git push")).await;
        let mut approvals = core.snapshot().approvals;
        approvals.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        let (first, second) = (approvals[0].clone(), approvals[1].clone());
        assert_eq!(
            core.approval_status(&first.id).unwrap(),
            ApprovalStatus {
                status: ApprovalState::Pending,
                code: first.code.clone(),
                action: PUSH_ACTION.into(),
            }
        );
        core.resolve_approval(&first.id, true).unwrap();
        assert_eq!(
            core.approval_status(&first.id).unwrap().status,
            ApprovalState::Approved
        );
        assert_eq!(
            core.on_session_hook(bash("s1", "git push --force")).await,
            HookReply::Empty
        );
        assert_eq!(
            core.approval_status(&first.id).unwrap().status,
            ApprovalState::Approved
        );
        core.resolve_approval(&second.id, false).unwrap();
        assert_eq!(
            core.approval_status(&second.id).unwrap(),
            ApprovalStatus {
                status: ApprovalState::Rejected,
                code: second.code.clone(),
                action: PUSH_ACTION.into(),
            }
        );
        core.on_session_hook(bash("s2", "git push")).await;
        let pending = only_approval(&core);
        advance(DAY + SECOND).await;
        assert_eq!(
            core.approval_status(&pending.id).unwrap().status,
            ApprovalState::Expired
        );
        assert!(core.snapshot().approvals.is_empty());
        assert!(core.resolve_approval(&pending.id, true).is_err());
        assert!(core.approval_status("missing").is_err());
    }
}

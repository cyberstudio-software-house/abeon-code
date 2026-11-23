use crate::db::{deploy_flows_repo, deploy_proposals_repo};
use crate::deploy::flows::{known_repo_path, normalize_flow, save_flow};
use crate::deploy::notify::{DiscordButton, DiscordNotice};
use crate::deploy::repos::repo_for_dir;
use crate::deploy::validate::validate_flow;
use crate::domain::deploy::{
    BuildProvider, DeployFlow, Delivery, FlowChange, FlowProposal, ProposalView,
};
use crate::error::{AppError, AppResult};
use crate::supervisor::discord::BUTTON_PREFIX;
use parking_lot::Mutex;
use rusqlite::{Connection, Transaction, TransactionBehavior};
use std::collections::{HashSet, VecDeque};
use std::path::Path;

pub const PROPOSAL_LIFETIME_MS: i64 = 24 * 60 * 60 * 1000;
pub const BUTTON_KIND: &str = "flow";
pub const APPROVE_ACTION: &str = "approve";
pub const REJECT_ACTION: &str = "reject";
pub const EXPIRED_TEXT: &str = "Propozycja wygasła";
const ID_LENGTH: usize = 8;
const EMPTY_VALUE: &str = "—";
const APPROVE_LABEL: &str = "Zatwierdź";
const REJECT_LABEL: &str = "Odrzuć";

const RECENT_APP_DECISIONS: usize = 50;

#[derive(Debug, Clone, PartialEq)]
pub enum Resolution {
    Approved(DeployFlow),
    Rejected(FlowProposal),
    Stale(FlowProposal),
}

impl Resolution {
    pub fn repo_path(&self) -> &str {
        match self {
            Resolution::Approved(flow) => &flow.repo_path,
            Resolution::Rejected(proposal) | Resolution::Stale(proposal) => &proposal.repo_path,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalBase {
    Stored,
    Rendered(Option<i64>),
}

#[derive(Default)]
pub struct ProposalNotices {
    announced: Mutex<HashSet<String>>,
    app_decisions: Mutex<VecDeque<(String, bool)>>,
}

impl ProposalNotices {
    pub fn take_new(&self, pending: &[FlowProposal]) -> Vec<FlowProposal> {
        let mut ids = self.announced.lock();
        ids.retain(|id| pending.iter().any(|proposal| &proposal.id == id));
        pending
            .iter()
            .filter(|proposal| ids.insert(proposal.id.clone()))
            .cloned()
            .collect()
    }

    pub fn record_app_decision(&self, proposal_id: &str, approved: bool) {
        let mut decisions = self.app_decisions.lock();
        decisions.retain(|(id, _)| id != proposal_id);
        decisions.push_back((proposal_id.to_string(), approved));
        while decisions.len() > RECENT_APP_DECISIONS {
            decisions.pop_front();
        }
    }

    pub fn app_decision(&self, proposal_id: &str) -> Option<bool> {
        self.app_decisions
            .lock()
            .iter()
            .find(|(id, _)| id == proposal_id)
            .map(|(_, approved)| *approved)
    }
}

pub fn is_proposal_id(value: &str) -> bool {
    value.len() == ID_LENGTH
        && value
            .chars()
            .all(|character| character.is_ascii_digit() || ('a'..='f').contains(&character))
}

fn random_id() -> String {
    uuid::Uuid::new_v4()
        .simple()
        .to_string()
        .chars()
        .take(ID_LENGTH)
        .collect()
}

pub fn button_id(proposal_id: &str, approve: bool) -> String {
    let action = if approve { APPROVE_ACTION } else { REJECT_ACTION };
    format!("{BUTTON_PREFIX}{BUTTON_KIND}:{proposal_id}:{action}")
}

fn immediate(conn: &Connection) -> AppResult<Transaction<'_>> {
    Ok(Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?)
}

fn canonical_repo(conn: &Connection, requested: &str) -> Result<String, String> {
    let repo_path = match known_repo_path(conn, requested) {
        Ok(path) => path,
        Err(AppError::InvalidPath { .. }) => {
            return Err(format!("{requested} is not a repository of an AbeonCode project"))
        }
        Err(error) => return Err(error.to_string()),
    };
    if repo_for_dir(Path::new(&repo_path)).as_deref() != Some(Path::new(&repo_path)) {
        return Err(format!("{requested} is not the root of a git repository"));
    }
    Ok(repo_path)
}

fn text(error: AppError) -> String {
    error.to_string()
}

fn store(conn: &Connection, flow: DeployFlow, now: i64) -> Result<FlowProposal, String> {
    let tx = immediate(conn).map_err(text)?;
    let current = deploy_flows_repo::get(&tx, &flow.repo_path).map_err(text)?;
    if current.is_some() && diff(current.as_ref(), &flow).is_empty() {
        return Err(format!("the flow of {} already has these values", flow.repo_path));
    }
    let base_updated_at = current.map(|current| current.updated_at);
    let existing = deploy_proposals_repo::get_for_repo(&tx, &flow.repo_path).map_err(text)?;
    if let Some(existing) = existing.filter(|existing| {
        existing.expires_at > now && existing.flow == flow && existing.base_updated_at == base_updated_at
    }) {
        return Ok(existing);
    }
    deploy_proposals_repo::delete_for_repo(&tx, &flow.repo_path).map_err(text)?;
    let id = loop {
        let candidate = random_id();
        if deploy_proposals_repo::get(&tx, &candidate).map_err(text)?.is_none() {
            break candidate;
        }
    };
    let proposal = FlowProposal {
        id,
        repo_path: flow.repo_path.clone(),
        flow,
        created_at: now,
        expires_at: now + PROPOSAL_LIFETIME_MS,
        base_updated_at,
    };
    deploy_proposals_repo::insert(&tx, &proposal).map_err(text)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(proposal)
}

pub fn create(conn: &Connection, flow: DeployFlow, now: i64) -> Result<FlowProposal, String> {
    let requested = flow.repo_path.trim().to_string();
    let repo_path = canonical_repo(conn, &requested)?;
    let flow = normalize_flow(DeployFlow {
        repo_path: repo_path.clone(),
        updated_at: 0,
        ..flow
    });
    validate_flow(&flow).map_err(|errors| {
        errors
            .iter()
            .map(|error| format!("{}: {}", error.field, error.message))
            .collect::<Vec<_>>()
            .join("\n")
    })?;
    store(conn, flow, now)
}

pub fn pending(conn: &Connection, now: i64) -> AppResult<Vec<FlowProposal>> {
    deploy_proposals_repo::delete_expired(conn, now)?;
    deploy_proposals_repo::list(conn)
}

pub fn resolve(
    conn: &Connection,
    id: &str,
    approve: bool,
    base: ApprovalBase,
    now: i64,
) -> AppResult<Option<Resolution>> {
    if !is_proposal_id(id) {
        return Ok(None);
    }
    let tx = immediate(conn)?;
    deploy_proposals_repo::delete_expired(&tx, now)?;
    let Some(proposal) = deploy_proposals_repo::get(&tx, id)? else {
        tx.commit()?;
        return Ok(None);
    };
    let resolution = if approve {
        let expected = match base {
            ApprovalBase::Stored => proposal.base_updated_at,
            ApprovalBase::Rendered(rendered) => rendered,
        };
        let current = deploy_flows_repo::get(&tx, &proposal.repo_path)?.map(|flow| flow.updated_at);
        if current != expected {
            tx.commit()?;
            return Ok(Some(Resolution::Stale(proposal)));
        }
        Resolution::Approved(save_flow(&tx, proposal.flow.clone())?)
    } else {
        Resolution::Rejected(proposal)
    };
    deploy_proposals_repo::delete(&tx, id)?;
    tx.commit()?;
    Ok(Some(resolution))
}

fn yes_no(value: bool) -> &'static str {
    if value {
        "tak"
    } else {
        "nie"
    }
}

fn build_name(build: BuildProvider) -> &'static str {
    match build {
        BuildProvider::Bitbucket => "Bitbucket Pipelines",
        BuildProvider::Github => "GitHub Actions",
        BuildProvider::None => "brak",
    }
}

fn delivery_name(delivery: Delivery) -> &'static str {
    match delivery {
        Delivery::Image => "Obraz + Bandzior/Argo",
        Delivery::Kubemeter => "Webhook Kubemeter",
        Delivery::None => "brak",
    }
}

fn shown(value: &str) -> String {
    if value.is_empty() {
        EMPTY_VALUE.to_string()
    } else {
        value.to_string()
    }
}

fn fields(flow: &DeployFlow) -> [(&'static str, &'static str, String); 9] {
    [
        ("enabled", "Śledź wdrożenia", yes_no(flow.enabled).to_string()),
        ("remote", "Zdalne repozytorium", shown(&flow.remote)),
        ("build", "Budowanie", build_name(flow.build).to_string()),
        ("buildRepo", "Repozytorium (CI)", shown(&flow.build_repo)),
        ("productionBranch", "Gałąź produkcyjna", shown(&flow.production_branch)),
        ("delivery", "Dostarczenie", delivery_name(flow.delivery).to_string()),
        ("namespace", "Namespace", shown(&flow.namespace)),
        ("workloads", "Zasoby", shown(&flow.workloads.join(", "))),
        (
            "kubeContext",
            "Kontekst kubectl",
            shown(flow.kube_context.as_deref().unwrap_or_default()),
        ),
    ]
}

pub fn diff(current: Option<&DeployFlow>, proposed: &DeployFlow) -> Vec<FlowChange> {
    let before = current.map(fields);
    fields(proposed)
        .into_iter()
        .enumerate()
        .filter_map(|(index, (field, label, after))| {
            let previous = before.as_ref().map(|values| values[index].2.clone());
            if previous.as_deref() == Some(after.as_str()) {
                return None;
            }
            Some(FlowChange {
                field: field.to_string(),
                label: label.to_string(),
                before: previous,
                after,
            })
        })
        .collect()
}

fn change_line(change: &FlowChange) -> String {
    match &change.before {
        Some(before) => format!("{}: `{before}` → `{}`", change.label, change.after),
        None => format!("{}: `{}`", change.label, change.after),
    }
}

pub fn notice_title(repo_label: &str) -> String {
    format!("Agent proponuje przepływ wdrożenia: {repo_label}")
}

pub fn discord_notice(view: &ProposalView) -> DiscordNotice {
    let mut lines = vec![format!("`{}`", view.proposal.repo_path)];
    lines.extend(view.changes.iter().map(change_line));
    DiscordNotice {
        title: notice_title(&view.repo_label),
        body: lines.join("\n"),
        link: None,
        buttons: vec![
            DiscordButton {
                label: APPROVE_LABEL.to_string(),
                custom_id: button_id(&view.proposal.id, true),
                primary: true,
            },
            DiscordButton {
                label: REJECT_LABEL.to_string(),
                custom_id: button_id(&view.proposal.id, false),
                primary: false,
            },
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::projects_repo;
    use crate::deploy::test_support::{conn, flow_at, init_repo, TestConn};
    use tempfile::{tempdir, TempDir};

    const DAY: i64 = 24 * 60 * 60 * 1000;

    struct Registered {
        _dir: TempDir,
        conn: TestConn,
        repo: String,
    }

    fn registered() -> Registered {
        let dir = tempdir().unwrap();
        init_repo(&dir.path().join("api"));
        let conn = conn();
        projects_repo::insert(&conn, "p", dir.path().to_str().unwrap(), "-p", None).unwrap();
        let repo = dir.path().join("api").canonicalize().unwrap().to_string_lossy().to_string();
        Registered { _dir: dir, conn, repo }
    }

    fn approved_namespace(resolution: Option<Resolution>) -> Option<String> {
        match resolution {
            Some(Resolution::Approved(flow)) => Some(flow.namespace),
            _ => None,
        }
    }

    #[test]
    fn a_proposal_changes_nothing_until_it_is_approved() {
        let Registered { _dir, conn, repo } = registered();
        let p = create(&conn, flow_at(&repo), 0).unwrap();
        assert!(is_proposal_id(&p.id), "{}", p.id);
        assert_eq!(p.expires_at, DAY);
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), None);
        assert_eq!(pending(&conn, 1).unwrap(), vec![p.clone()]);

        let resolved = resolve(&conn, &p.id, true, ApprovalBase::Stored, 1).unwrap();
        assert_eq!(approved_namespace(resolved), Some("cs-app-hs".into()));
        assert!(deploy_flows_repo::get(&conn, &repo).unwrap().is_some());
        assert!(pending(&conn, 2).unwrap().is_empty());
    }

    #[test]
    fn a_rejected_or_expired_proposal_leaves_the_flow_untouched() {
        let Registered { _dir, conn, repo } = registered();
        let rejected = create(&conn, flow_at(&repo), 0).unwrap();
        match resolve(&conn, &rejected.id, false, ApprovalBase::Stored, 1).unwrap() {
            Some(Resolution::Rejected(proposal)) => assert_eq!(proposal, rejected),
            other => panic!("expected a rejection, got {other:?}"),
        }
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), None);
        assert!(pending(&conn, 2).unwrap().is_empty());

        let expired = create(&conn, flow_at(&repo), 0).unwrap();
        assert!(resolve(&conn, &expired.id, true, ApprovalBase::Stored, DAY + 1).unwrap().is_none());
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), None);

        let at_the_limit = create(&conn, flow_at(&repo), 0).unwrap();
        assert!(resolve(&conn, &at_the_limit.id, true, ApprovalBase::Stored, DAY).unwrap().is_none());
        assert!(resolve(&conn, "deadbeef", true, ApprovalBase::Stored, 1).unwrap().is_none());
        assert!(resolve(&conn, "not-an-id", false, ApprovalBase::Stored, 1).unwrap().is_none());
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), None);
    }

    #[test]
    fn an_expired_proposal_is_dropped_from_the_pending_list() {
        let Registered { _dir, conn, repo } = registered();
        let p = create(&conn, flow_at(&repo), 0).unwrap();
        assert_eq!(pending(&conn, DAY - 1).unwrap(), vec![p]);
        assert!(pending(&conn, DAY).unwrap().is_empty());
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM deploy_flow_proposals", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn a_newer_proposal_replaces_the_older_one_for_the_same_repository() {
        let Registered { _dir, conn, repo } = registered();
        let first = create(&conn, flow_at(&repo), 0).unwrap();
        let mut other = flow_at(&repo);
        other.namespace = "cs-app-other".to_string();
        let second = create(&conn, other, 10).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(pending(&conn, 20).unwrap(), vec![second.clone()]);

        assert!(resolve(&conn, &first.id, true, ApprovalBase::Stored, 30).unwrap().is_none());
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), None);
        let resolved = resolve(&conn, &second.id, true, ApprovalBase::Stored, 40).unwrap();
        assert_eq!(approved_namespace(resolved), Some("cs-app-other".into()));
    }

    #[test]
    fn an_invalid_proposal_is_refused_with_the_field_names() {
        let Registered { _dir, conn, repo } = registered();
        let mut invalid = flow_at(&repo);
        invalid.namespace = "x; rm".to_string();
        invalid.production_branch = String::new();
        let error = create(&conn, invalid, 0).unwrap_err();
        let lines: Vec<&str> = error.lines().collect();
        assert!(lines.contains(&"namespace: Pole „Namespace” zawiera niedozwolone znaki"), "{error}");
        assert!(lines.contains(&"productionBranch: Pole „Gałąź produkcyjna” jest wymagane"), "{error}");
        assert!(pending(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn a_proposal_outside_registered_projects_or_off_a_repository_root_is_refused() {
        let Registered { _dir: dir, conn, .. } = registered();
        let outside = tempdir().unwrap();
        init_repo(outside.path());
        let path = outside.path().to_str().unwrap();
        let error = create(&conn, flow_at(path), 0).unwrap_err();
        assert_eq!(error, format!("{path} is not a repository of an AbeonCode project"));

        let docs = dir.path().join("docs");
        std::fs::create_dir_all(&docs).unwrap();
        let error = create(&conn, flow_at(docs.to_str().unwrap()), 0).unwrap_err();
        assert!(error.ends_with("is not the root of a git repository"), "{error}");
        assert!(pending(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn a_proposal_is_stored_normalized_under_the_canonical_path() {
        let Registered { _dir, conn, repo } = registered();
        let mut dirty = flow_at(&format!(" {repo}/ "));
        dirty.namespace = " cs-app-hs ".to_string();
        dirty.workloads = vec![" app ".to_string(), String::new()];
        dirty.kube_context = Some("  ".to_string());
        dirty.updated_at = 99;
        let p = create(&conn, dirty, 0).unwrap();
        assert_eq!(p.repo_path, repo);
        assert_eq!(p.flow, DeployFlow { updated_at: 0, ..flow_at(&repo) });
        assert_eq!(pending(&conn, 1).unwrap(), vec![p]);
    }

    #[test]
    fn a_proposal_equal_to_the_current_flow_is_refused() {
        let Registered { _dir, conn, repo } = registered();
        deploy_flows_repo::upsert(&conn, &flow_at(&repo)).unwrap();
        let error = create(&conn, flow_at(&repo), 0).unwrap_err();
        assert_eq!(error, format!("the flow of {repo} already has these values"));
        assert!(pending(&conn, 1).unwrap().is_empty());
    }

    #[test]
    fn the_stored_body_is_validated_again_on_approval() {
        let Registered { _dir, conn, repo } = registered();
        let p = create(&conn, flow_at(&repo), 0).unwrap();
        let mut tampered = flow_at(&repo);
        tampered.namespace = "x; rm -rf ~".to_string();
        conn.execute(
            "UPDATE deploy_flow_proposals SET body = ? WHERE id = ?",
            rusqlite::params![serde_json::to_string(&tampered).unwrap(), p.id],
        )
        .unwrap();

        assert!(resolve(&conn, &p.id, true, ApprovalBase::Stored, 1).is_err());
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), None);
        assert_eq!(pending(&conn, 2).unwrap().len(), 1);
        assert!(matches!(
            resolve(&conn, &p.id, false, ApprovalBase::Stored, 3).unwrap(),
            Some(Resolution::Rejected(_))
        ));
        assert!(pending(&conn, 4).unwrap().is_empty());
    }

    #[test]
    fn approval_writes_the_flow_through_the_settings_save_path() {
        let Registered { _dir, conn, repo } = registered();
        let p = create(&conn, flow_at(&repo), 0).unwrap();
        let Some(Resolution::Approved(saved)) = resolve(&conn, &p.id, true, ApprovalBase::Stored, 1).unwrap() else {
            panic!("expected an approval");
        };
        assert!(saved.updated_at > 0);
        assert_eq!(DeployFlow { updated_at: 0, ..saved.clone() }, p.flow);
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), Some(saved));
    }

    fn saved_later(conn: &Connection, flow: &DeployFlow) -> DeployFlow {
        std::thread::sleep(std::time::Duration::from_millis(5));
        deploy_flows_repo::upsert(conn, flow).unwrap()
    }

    fn with_namespace(repo: &str, namespace: &str) -> DeployFlow {
        DeployFlow { namespace: namespace.to_string(), ..flow_at(repo) }
    }

    fn is_stale(resolution: Option<Resolution>) -> bool {
        matches!(resolution, Some(Resolution::Stale(_)))
    }

    #[test]
    fn a_proposal_remembers_the_flow_it_was_compared_against() {
        let Registered { _dir, conn, repo } = registered();
        let fresh = create(&conn, with_namespace(&repo, "a"), 0).unwrap();
        assert_eq!(fresh.base_updated_at, None);
        resolve(&conn, &fresh.id, false, ApprovalBase::Stored, 1).unwrap();

        let current = deploy_flows_repo::upsert(&conn, &with_namespace(&repo, "a")).unwrap();
        let proposal = create(&conn, with_namespace(&repo, "b"), 2).unwrap();
        assert_eq!(proposal.base_updated_at, Some(current.updated_at));
        assert_eq!(pending(&conn, 3).unwrap()[0].base_updated_at, Some(current.updated_at));
    }

    #[test]
    fn approving_from_discord_after_the_user_saved_the_flow_is_refused_and_keeps_the_edit() {
        let Registered { _dir, conn, repo } = registered();
        deploy_flows_repo::upsert(&conn, &with_namespace(&repo, "a")).unwrap();
        let proposal = create(&conn, with_namespace(&repo, "b"), 0).unwrap();
        let edited = DeployFlow { production_branch: "release".to_string(), ..with_namespace(&repo, "a") };
        let saved = saved_later(&conn, &edited);

        assert!(is_stale(resolve(&conn, &proposal.id, true, ApprovalBase::Stored, 1).unwrap()));

        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), Some(saved));
        assert_eq!(pending(&conn, 2).unwrap(), vec![proposal]);
    }

    #[test]
    fn approving_after_the_flow_was_deleted_or_created_is_refused() {
        let Registered { _dir, conn, repo } = registered();
        deploy_flows_repo::upsert(&conn, &with_namespace(&repo, "a")).unwrap();
        let against_existing = create(&conn, with_namespace(&repo, "b"), 0).unwrap();
        deploy_flows_repo::delete(&conn, &repo).unwrap();
        assert!(is_stale(resolve(&conn, &against_existing.id, true, ApprovalBase::Stored, 1).unwrap()));
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), None);

        let against_nothing = create(&conn, with_namespace(&repo, "b"), 2).unwrap();
        let created = saved_later(&conn, &with_namespace(&repo, "c"));
        assert!(is_stale(resolve(&conn, &against_nothing.id, true, ApprovalBase::Stored, 3).unwrap()));
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), Some(created));
    }

    #[test]
    fn approving_with_an_unchanged_base_applies_the_proposal() {
        let Registered { _dir, conn, repo } = registered();
        deploy_flows_repo::upsert(&conn, &with_namespace(&repo, "a")).unwrap();
        let proposal = create(&conn, with_namespace(&repo, "b"), 0).unwrap();
        let resolved = resolve(&conn, &proposal.id, true, ApprovalBase::Stored, 1).unwrap();
        assert_eq!(approved_namespace(resolved), Some("b".into()));
        assert!(pending(&conn, 2).unwrap().is_empty());
    }

    #[test]
    fn the_app_approves_against_the_flow_its_card_was_rendered_from() {
        let Registered { _dir, conn, repo } = registered();
        let first = deploy_flows_repo::upsert(&conn, &with_namespace(&repo, "a")).unwrap();
        let proposal = create(&conn, with_namespace(&repo, "b"), 0).unwrap();
        let edited = DeployFlow { production_branch: "release".to_string(), ..with_namespace(&repo, "a") };
        let second = saved_later(&conn, &edited);

        let outdated = resolve(&conn, &proposal.id, true, ApprovalBase::Rendered(Some(first.updated_at)), 1);
        assert!(is_stale(outdated.unwrap()));
        assert!(is_stale(resolve(&conn, &proposal.id, true, ApprovalBase::Rendered(None), 2).unwrap()));
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), Some(second.clone()));

        let rerendered = resolve(&conn, &proposal.id, true, ApprovalBase::Rendered(Some(second.updated_at)), 3);
        assert_eq!(approved_namespace(rerendered.unwrap()), Some("b".into()));
        assert!(pending(&conn, 4).unwrap().is_empty());
    }

    #[test]
    fn a_rejection_is_never_refused_as_stale() {
        let Registered { _dir, conn, repo } = registered();
        deploy_flows_repo::upsert(&conn, &with_namespace(&repo, "a")).unwrap();
        let proposal = create(&conn, with_namespace(&repo, "b"), 0).unwrap();
        let saved = saved_later(&conn, &with_namespace(&repo, "c"));
        assert!(matches!(
            resolve(&conn, &proposal.id, false, ApprovalBase::Rendered(Some(-1)), 1).unwrap(),
            Some(Resolution::Rejected(_))
        ));
        assert_eq!(deploy_flows_repo::get(&conn, &repo).unwrap(), Some(saved));
        assert!(pending(&conn, 2).unwrap().is_empty());
    }

    #[test]
    fn proposing_the_same_flow_again_keeps_the_pending_proposal() {
        let Registered { _dir, conn, repo } = registered();
        deploy_flows_repo::upsert(&conn, &with_namespace(&repo, "a")).unwrap();
        let first = create(&conn, with_namespace(&repo, "b"), 0).unwrap();
        let mut spaced = with_namespace(&repo, " b ");
        spaced.updated_at = 77;
        assert_eq!(create(&conn, spaced, 10).unwrap(), first);
        assert_eq!(pending(&conn, 11).unwrap(), vec![first.clone()]);

        let other = create(&conn, with_namespace(&repo, "c"), 20).unwrap();
        assert_ne!(other.id, first.id);

        saved_later(&conn, &with_namespace(&repo, "a2"));
        let rebased = create(&conn, with_namespace(&repo, "c"), 30).unwrap();
        assert_ne!(rebased.id, other.id);
        assert_eq!(pending(&conn, 31).unwrap(), vec![rebased]);
    }

    #[test]
    fn an_expired_proposal_is_replaced_by_the_same_flow() {
        let Registered { _dir, conn, repo } = registered();
        let first = create(&conn, flow_at(&repo), 0).unwrap();
        let again = create(&conn, flow_at(&repo), DAY).unwrap();
        assert_ne!(again.id, first.id);
        assert_eq!(again.expires_at, 2 * DAY);
    }

    fn change(field: &str, label: &str, before: Option<&str>, after: &str) -> FlowChange {
        FlowChange {
            field: field.to_string(),
            label: label.to_string(),
            before: before.map(str::to_string),
            after: after.to_string(),
        }
    }

    #[test]
    fn the_diff_lists_only_changed_fields() {
        let current = flow_at("/r/a");
        let mut proposed = flow_at("/r/a");
        proposed.production_branch = "main".to_string();
        proposed.updated_at = 1234;
        assert_eq!(
            diff(Some(&current), &proposed),
            vec![change("productionBranch", "Gałąź produkcyjna", Some("master"), "main")]
        );
        assert!(diff(Some(&current), &current).is_empty());
    }

    #[test]
    fn the_diff_names_values_the_way_the_form_does() {
        let current = flow_at("/r/a");
        let mut proposed = flow_at("/r/a");
        proposed.enabled = false;
        proposed.build = BuildProvider::Github;
        proposed.delivery = Delivery::Kubemeter;
        proposed.workloads = vec!["app".to_string(), "worker".to_string()];
        proposed.kube_context = Some("prod".to_string());
        assert_eq!(
            diff(Some(&current), &proposed),
            vec![
                change("enabled", "Śledź wdrożenia", Some("tak"), "nie"),
                change("build", "Budowanie", Some("Bitbucket Pipelines"), "GitHub Actions"),
                change("delivery", "Dostarczenie", Some("Obraz + Bandzior/Argo"), "Webhook Kubemeter"),
                change("workloads", "Zasoby", Some("app"), "app, worker"),
                change("kubeContext", "Kontekst kubectl", Some("—"), "prod"),
            ]
        );

        let mut off = flow_at("/r/a");
        off.build = BuildProvider::None;
        off.build_repo = String::new();
        off.delivery = Delivery::None;
        off.namespace = String::new();
        off.workloads = Vec::new();
        assert_eq!(
            diff(Some(&current), &off),
            vec![
                change("build", "Budowanie", Some("Bitbucket Pipelines"), "brak"),
                change("buildRepo", "Repozytorium (CI)", Some("cybercode/hr-management"), "—"),
                change("delivery", "Dostarczenie", Some("Obraz + Bandzior/Argo"), "brak"),
                change("namespace", "Namespace", Some("cs-app-hs"), "—"),
                change("workloads", "Zasoby", Some("app"), "—"),
            ]
        );
    }

    #[test]
    fn the_diff_of_a_repository_without_a_flow_lists_every_field() {
        assert_eq!(
            diff(None, &flow_at("/r/a")),
            vec![
                change("enabled", "Śledź wdrożenia", None, "tak"),
                change("remote", "Zdalne repozytorium", None, "origin"),
                change("build", "Budowanie", None, "Bitbucket Pipelines"),
                change("buildRepo", "Repozytorium (CI)", None, "cybercode/hr-management"),
                change("productionBranch", "Gałąź produkcyjna", None, "master"),
                change("delivery", "Dostarczenie", None, "Obraz + Bandzior/Argo"),
                change("namespace", "Namespace", None, "cs-app-hs"),
                change("workloads", "Zasoby", None, "app"),
                change("kubeContext", "Kontekst kubectl", None, "—"),
            ]
        );
    }

    #[test]
    fn proposal_ids_are_eight_lowercase_hex_characters() {
        assert!(is_proposal_id("ab12cd34"));
        for invalid in ["AB12CD34", "ab12cd3", "ab12cd345", "ab12cd3g", "", "ab12:d34"] {
            assert!(!is_proposal_id(invalid), "{invalid:?}");
        }
        for _ in 0..50 {
            assert!(is_proposal_id(&random_id()));
        }
    }

    fn proposal(id: &str) -> FlowProposal {
        FlowProposal {
            id: id.to_string(),
            repo_path: "/r/a".to_string(),
            flow: flow_at("/r/a"),
            created_at: 0,
            expires_at: DAY,
            base_updated_at: None,
        }
    }

    #[test]
    fn decisions_taken_in_the_app_are_remembered_for_the_last_fifty_proposals() {
        let notices = ProposalNotices::default();
        assert_eq!(notices.app_decision("aaaaaaaa"), None);
        notices.record_app_decision("aaaaaaaa", true);
        notices.record_app_decision("bbbbbbbb", false);
        assert_eq!(notices.app_decision("aaaaaaaa"), Some(true));
        assert_eq!(notices.app_decision("bbbbbbbb"), Some(false));

        for index in 0..49 {
            notices.record_app_decision(&format!("{index:08x}"), true);
        }
        assert_eq!(notices.app_decision("aaaaaaaa"), None);
        assert_eq!(notices.app_decision("bbbbbbbb"), Some(false));
        assert_eq!(notices.app_decision(&format!("{:08x}", 48)), Some(true));
    }

    #[test]
    fn each_pending_proposal_is_announced_once() {
        let announced = ProposalNotices::default();
        let (first, second) = (proposal("aaaaaaaa"), proposal("bbbbbbbb"));
        assert_eq!(announced.take_new(&[first.clone()]), vec![first.clone()]);
        assert!(announced.take_new(&[first.clone()]).is_empty());
        assert_eq!(
            announced.take_new(&[first.clone(), second.clone()]),
            vec![second.clone()]
        );
        assert!(announced.take_new(&[second.clone()]).is_empty());
        assert!(announced.take_new(&[]).is_empty());
        assert_eq!(announced.take_new(&[second.clone()]), vec![second]);
    }

    #[test]
    fn the_discord_notice_lists_the_changes_with_two_buttons() {
        let view = ProposalView {
            proposal: proposal("ab12cd34"),
            repo_label: "api".to_string(),
            project_ids: vec![1],
            changes: vec![
                change("productionBranch", "Gałąź produkcyjna", Some("master"), "main"),
                change("namespace", "Namespace", None, "cs_app"),
            ],
            current_updated_at: None,
        };
        let notice = discord_notice(&view);
        assert_eq!(notice.title, "Agent proponuje przepływ wdrożenia: api");
        assert_eq!(
            notice.body,
            "`/r/a`\nGałąź produkcyjna: `master` → `main`\nNamespace: `cs_app`"
        );
        assert_eq!(notice.link, None);
        assert_eq!(
            notice.buttons,
            vec![
                DiscordButton {
                    label: "Zatwierdź".to_string(),
                    custom_id: "abeon:flow:ab12cd34:approve".to_string(),
                    primary: true,
                },
                DiscordButton {
                    label: "Odrzuć".to_string(),
                    custom_id: "abeon:flow:ab12cd34:reject".to_string(),
                    primary: false,
                },
            ]
        );
    }
}

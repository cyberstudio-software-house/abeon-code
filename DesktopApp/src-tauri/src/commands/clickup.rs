use std::io::Write;
use tauri::State;
use crate::clickup::{classify_query, parse_task_input, ClickUpClient, QueryKind};
use crate::db::{clickup_config_repo, clickup_links_repo, projects_repo, settings_repo};
use crate::domain::clickup::{
    ClickUpConnectionStatus, ClickUpLink, ClickUpList, ClickUpProjectConfig, ClickUpSpace,
    ClickUpTaskDetail, ClickUpTaskRef, ClickUpWorkspace,
};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

const TOKEN_KEY: &str = "clickupApiToken";

fn status_from_token(token: &Option<String>) -> ClickUpConnectionStatus {
    match token {
        Some(t) if !t.trim().is_empty() => ClickUpConnectionStatus::Configured,
        _ => ClickUpConnectionStatus::Absent,
    }
}

pub fn load_client(state: &AppState) -> AppResult<ClickUpClient> {
    let c = state.db.get()?;
    let token = settings_repo::get(&c, TOKEN_KEY)?
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| AppError::Other("ClickUp: brak tokenu".into()))?;
    Ok(ClickUpClient::new(token))
}

#[tauri::command]
pub fn clickup_set_token(state: State<AppState>, token: String) -> AppResult<()> {
    let c = state.db.get()?;
    settings_repo::set(&c, TOKEN_KEY, token.trim())?;
    Ok(())
}

#[tauri::command]
pub fn clickup_clear_token(state: State<AppState>) -> AppResult<()> {
    let c = state.db.get()?;
    settings_repo::delete(&c, TOKEN_KEY)?;
    Ok(())
}

#[tauri::command]
pub async fn clickup_connection_status(state: State<'_, AppState>) -> AppResult<ClickUpConnectionStatus> {
    let token = {
        let c = state.db.get()?;
        settings_repo::get(&c, TOKEN_KEY)?
    };
    if status_from_token(&token) == ClickUpConnectionStatus::Absent {
        return Ok(ClickUpConnectionStatus::Absent);
    }
    let client = ClickUpClient::new(token.unwrap());
    match client.get_user().await {
        Ok(()) => Ok(ClickUpConnectionStatus::Configured),
        Err(crate::clickup::ClickUpError::InvalidToken) => Ok(ClickUpConnectionStatus::Invalid),
        Err(e) => Err(AppError::Other(e.to_string())),
    }
}

#[tauri::command]
pub async fn clickup_list_workspaces(state: State<'_, AppState>) -> AppResult<Vec<ClickUpWorkspace>> {
    let client = load_client(&state)?;
    client.list_workspaces().await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub async fn clickup_list_spaces(state: State<'_, AppState>, workspace_id: String)
    -> AppResult<Vec<ClickUpSpace>>
{
    load_client(&state)?.list_spaces(&workspace_id).await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub async fn clickup_list_lists(state: State<'_, AppState>, space_id: String)
    -> AppResult<Vec<ClickUpList>>
{
    load_client(&state)?.list_lists(&space_id).await.map_err(|e| AppError::Other(e.to_string()))
}

#[tauri::command]
pub fn clickup_get_config(state: State<AppState>, project_id: i64)
    -> AppResult<Option<ClickUpProjectConfig>>
{
    let c = state.db.get()?;
    clickup_config_repo::get(&c, project_id)
}

#[tauri::command]
pub fn clickup_set_config(
    state: State<AppState>, project_id: i64,
    workspace_id: String, space_id: Option<String>, list_id: Option<String>,
) -> AppResult<()> {
    let c = state.db.get()?;
    clickup_config_repo::set(&c, project_id, &workspace_id, space_id.as_deref(), list_id.as_deref())
}

#[tauri::command]
pub fn clickup_list_links(state: State<AppState>, project_id: i64) -> AppResult<Vec<ClickUpLink>> {
    let c = state.db.get()?;
    clickup_links_repo::list(&c, project_id)
}

#[tauri::command]
pub fn clickup_unlink_task(state: State<AppState>, project_id: i64, task_id: String) -> AppResult<()> {
    let c = state.db.get()?;
    clickup_links_repo::delete(&c, project_id, &task_id)
}

#[tauri::command]
pub async fn clickup_get_task(state: State<'_, AppState>, task_id: String) -> AppResult<ClickUpTaskDetail> {
    load_client(&state)?
        .get_task_detail(&task_id, false, None).await
        .map_err(|e| AppError::Other(e.to_string()))
}

async fn search_tasks_by_name(
    client: &ClickUpClient,
    config: &ClickUpProjectConfig,
    query: &str,
) -> AppResult<Vec<ClickUpTaskRef>> {
    let mut tasks = if let Some(list_id) = &config.list_id {
        client.list_tasks_in_list(list_id).await
    } else if let Some(space_id) = &config.space_id {
        client.list_tasks_in_space(&config.workspace_id, space_id).await
    } else {
        return Err(AppError::Other("ClickUp: ustaw Space lub Listę dla wyszukiwania po nazwie".into()));
    }.map_err(|e| AppError::Other(e.to_string()))?;
    let needle = query.to_lowercase();
    tasks.retain(|t| t.name.to_lowercase().contains(&needle));
    tasks.truncate(50);
    Ok(tasks)
}

#[tauri::command]
pub async fn clickup_search_tasks(state: State<'_, AppState>, project_id: i64, query: String)
    -> AppResult<Vec<ClickUpTaskRef>>
{
    let config = {
        let c = state.db.get()?;
        clickup_config_repo::get(&c, project_id)?
            .ok_or_else(|| AppError::Other("ClickUp: brak skonfigurowanego zakresu projektu".into()))?
    };
    let client = load_client(&state)?;
    match classify_query(&query) {
        QueryKind::Id => {
            let r = parse_task_input(&query);
            match client.get_task_detail(&r.id, r.custom, Some(&config.workspace_id)).await {
                Ok(detail) => Ok(vec![ClickUpTaskRef {
                    id: detail.id,
                    custom_id: detail.custom_id,
                    name: detail.name,
                    status: detail.status,
                    url: detail.url,
                    list_name: None,
                }]),
                Err(_) => search_tasks_by_name(&client, &config, &query).await,
            }
        }
        QueryKind::Name => search_tasks_by_name(&client, &config, &query).await,
    }
}

#[tauri::command]
pub async fn clickup_link_task(state: State<'_, AppState>, project_id: i64, task_id: String)
    -> AppResult<ClickUpLink>
{
    let detail = load_client(&state)?
        .get_task_detail(&task_id, false, None).await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let link = ClickUpLink {
        project_id,
        task_id: detail.id.clone(),
        custom_id: detail.custom_id.clone(),
        name: detail.name.clone(),
        status: detail.status.clone(),
        url: detail.url.clone(),
        linked_at: now_ms(),
    };
    let c = state.db.get()?;
    clickup_links_repo::upsert(&c, &link)?;
    Ok(link)
}

fn validate_task_id(task_id: &str) -> AppResult<()> {
    if !task_id.is_empty()
        && task_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        Ok(())
    } else {
        Err(AppError::Other("ClickUp: nieprawidłowy identyfikator zadania".into()))
    }
}

fn render_task_markdown(d: &ClickUpTaskDetail) -> String {
    let title = match &d.custom_id {
        Some(c) => format!("{c} {}", d.name),
        None => d.name.clone(),
    };
    let mut out = format!("# {title}\n\n");
    if let Some(s) = &d.status {
        out.push_str(&format!("**Status:** {s}\n\n"));
    }
    out.push_str(&format!("**URL:** {}\n\n## Opis\n\n{}\n\n", d.url, d.description));
    if !d.attachments.is_empty() {
        out.push_str("## Załączniki\n\n");
        for a in &d.attachments {
            out.push_str(&format!("- [{}]({})\n", a.title, a.url));
        }
        out.push('\n');
    }
    if !d.comments.is_empty() {
        out.push_str("## Komentarze\n\n");
        for c in &d.comments {
            out.push_str(&format!("**{}:** {}\n\n", c.user, c.text));
        }
    }
    out
}

fn ensure_gitignore(project_path: &str) -> std::io::Result<()> {
    let path = std::path::Path::new(project_path).join(".gitignore");
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    if existing.lines().any(|l| l.trim() == ".abeon/") {
        return Ok(());
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
    let prefix = if existing.is_empty() || existing.ends_with('\n') { "" } else { "\n" };
    write!(f, "{prefix}.abeon/\n")?;
    Ok(())
}

#[tauri::command]
pub async fn clickup_write_task_file(state: State<'_, AppState>, project_id: i64, task_id: String)
    -> AppResult<String>
{
    validate_task_id(&task_id)?;
    let project_path = {
        let c = state.db.get()?;
        projects_repo::get(&c, project_id)?.path
    };
    let detail = load_client(&state)?
        .get_task_detail(&task_id, false, None).await
        .map_err(|e| AppError::Other(e.to_string()))?;
    let base = std::fs::canonicalize(&project_path)?;
    let target_dir = base.join(".abeon/clickup");
    std::fs::create_dir_all(&target_dir)?;
    let canon_dir = std::fs::canonicalize(&target_dir)?;
    if !canon_dir.starts_with(&base) {
        return Err(AppError::Other("ClickUp: ścieżka poza projektem".into()));
    }
    let abs = target_dir.join(format!("{task_id}.md"));
    std::fs::write(&abs, render_task_markdown(&detail))?;
    ensure_gitignore(&project_path)?;
    Ok(format!(".abeon/clickup/{task_id}.md"))
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, settings_repo};
    use tempfile::NamedTempFile;

    #[test]
    fn status_reflects_token_presence() {
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let c = pool.get().unwrap();
        assert_eq!(status_from_token(&token_in(&c)), ClickUpConnectionStatus::Absent);
        settings_repo::set(&c, TOKEN_KEY, "pk_x").unwrap();
        assert_eq!(status_from_token(&token_in(&c)), ClickUpConnectionStatus::Configured);
    }

    fn token_in(c: &rusqlite::Connection) -> Option<String> {
        settings_repo::get(c, TOKEN_KEY).unwrap()
    }

    #[test]
    fn config_command_helpers_round_trip() {
        use crate::db::clickup_config_repo;
        let f = NamedTempFile::new().unwrap();
        let pool = init_pool(&f.path().to_path_buf()).unwrap();
        let c = pool.get().unwrap();
        let p = crate::db::projects_repo::insert(&c, "X", "/x", "-x", None).unwrap();
        clickup_config_repo::set(&c, p.id, "ws1", Some("sp1"), None).unwrap();
        assert_eq!(clickup_config_repo::get(&c, p.id).unwrap().unwrap().workspace_id, "ws1");
    }

    #[test]
    fn validate_task_id_rejects_traversal_and_accepts_ids() {
        assert!(validate_task_id("868abc12").is_ok());
        assert!(validate_task_id("CU-123").is_ok());
        assert!(validate_task_id("a_b-9").is_ok());
        assert!(validate_task_id("../../etc/passwd").is_err());
        assert!(validate_task_id("/etc/passwd").is_err());
        assert!(validate_task_id("a/b").is_err());
        assert!(validate_task_id("..").is_err());
        assert!(validate_task_id("").is_err());
    }

    #[test]
    fn render_task_markdown_includes_name_description_comments() {
        use crate::domain::clickup::{ClickUpAttachment, ClickUpComment, ClickUpTaskDetail};
        let d = ClickUpTaskDetail {
            id: "t1".into(),
            custom_id: Some("CU-1".into()),
            name: "Fix".into(),
            description: "Body".into(),
            status: Some("open".into()),
            url: "https://app.clickup.com/t/t1".into(),
            attachments: vec![ClickUpAttachment {
                id: "a".into(),
                title: "log".into(),
                url: "https://f/a".into(),
            }],
            comments: vec![ClickUpComment {
                id: "c".into(),
                user: "ann".into(),
                text: "hi".into(),
                date: 0,
            }],
        };
        let md = render_task_markdown(&d);
        assert!(md.contains("# CU-1 Fix"));
        assert!(md.contains("Body"));
        assert!(md.contains("ann"));
        assert!(md.contains("log"));
    }
}

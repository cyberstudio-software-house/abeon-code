use crate::db::notes_repo as repo;
use crate::domain::Note;
use crate::error::AppResult;
use crate::state::AppState;
use tauri::State;

#[tauri::command]
pub fn list_notes(state: State<AppState>, project_id: Option<i64>) -> AppResult<Vec<Note>> {
    let conn = state.db.get()?;
    repo::list(&conn, project_id)
}

#[tauri::command]
pub fn create_note(
    state: State<AppState>,
    project_id: Option<i64>,
    title: String,
    content: String,
) -> AppResult<Note> {
    let conn = state.db.get()?;
    repo::create(&conn, project_id, &title, &content)
}

#[tauri::command]
pub fn update_note(
    state: State<AppState>,
    id: i64,
    title: String,
    content: String,
) -> AppResult<Note> {
    let conn = state.db.get()?;
    repo::update(&conn, id, &title, &content)
}

#[tauri::command]
pub fn delete_note(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = state.db.get()?;
    repo::delete(&conn, id)
}

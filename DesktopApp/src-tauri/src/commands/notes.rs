use crate::db::notes_repo as repo;
use crate::domain::Note;
use crate::error::AppResult;
use crate::state::AppState;
use tauri::State;

#[tauri::command(async)]
pub fn list_notes(state: State<AppState>, project_id: Option<i64>) -> AppResult<Vec<Note>> {
    let conn = state.db.get()?;
    repo::list(&conn, project_id)
}

#[tauri::command(async)]
pub fn get_note(state: State<AppState>, id: i64) -> AppResult<Note> {
    let conn = state.db.get()?;
    repo::get(&conn, id)
}

#[tauri::command(async)]
pub fn create_note(
    state: State<AppState>,
    project_id: Option<i64>,
    content: String,
) -> AppResult<Note> {
    let conn = state.db.get()?;
    repo::create(&conn, project_id, &content)
}

#[tauri::command(async)]
pub fn update_note(state: State<AppState>, id: i64, content: String) -> AppResult<Note> {
    let conn = state.db.get()?;
    repo::update(&conn, id, &content)
}

#[tauri::command(async)]
pub fn delete_note(state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = state.db.get()?;
    repo::delete(&conn, id)
}

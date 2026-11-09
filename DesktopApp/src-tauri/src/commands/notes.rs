use crate::db::notes_repo as repo;
use crate::domain::note::NOTES_CHANGED_EVENT;
use crate::domain::{Note, NotesChangedEvent};
use crate::error::AppResult;
use crate::state::AppState;
use tauri::{Emitter, State, WebviewWindow};

fn announce_change(window: &WebviewWindow) {
    let event = NotesChangedEvent {
        created_note_id: None,
        external: false,
        source_window: Some(window.label().to_string()),
    };
    if let Err(error) = window.emit(NOTES_CHANGED_EVENT, event) {
        eprintln!("notes: change event failed: {error}");
    }
}

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
    window: WebviewWindow,
    state: State<AppState>,
    project_id: Option<i64>,
    content: String,
) -> AppResult<Note> {
    let conn = state.db.get()?;
    let note = repo::create(&conn, project_id, &content)?;
    announce_change(&window);
    Ok(note)
}

#[tauri::command(async)]
pub fn update_note(
    window: WebviewWindow,
    state: State<AppState>,
    id: i64,
    content: String,
) -> AppResult<Note> {
    let conn = state.db.get()?;
    let note = repo::update(&conn, id, &content)?;
    announce_change(&window);
    Ok(note)
}

#[tauri::command(async)]
pub fn delete_note(window: WebviewWindow, state: State<AppState>, id: i64) -> AppResult<()> {
    let conn = state.db.get()?;
    repo::delete(&conn, id)?;
    announce_change(&window);
    Ok(())
}

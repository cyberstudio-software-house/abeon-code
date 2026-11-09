use std::io::{IsTerminal, Read};
use std::path::{Path, PathBuf};

use chrono::{Local, TimeZone};
use rusqlite::Connection;

use crate::db::{db_path, init_pool, notes_repo, projects_repo};
use crate::domain::{Note, Project};
#[cfg(unix)]
use crate::supervisor::ipc::{request_blocking, socket_path, IpcRequest};

pub const MAX_NOTE_BYTES: usize = 64 * 1024;

pub const USAGE: &str = "usage: abeon-code note add [--global] <<'ABEON_NOTE_<hex>' … | abeon-code note list [--global] [--limit N]";

#[derive(Debug, PartialEq)]
pub enum NoteAction {
    Add,
    List,
}

#[derive(Debug, PartialEq)]
pub struct NoteCommand {
    pub action: NoteAction,
    pub global: bool,
    pub cwd: Option<PathBuf>,
    pub limit: Option<usize>,
}

pub fn parse(args: &[String]) -> Option<Result<NoteCommand, String>> {
    if args.get(1).map(String::as_str) != Some("note") {
        return None;
    }
    Some(parse_note_args(&args[2..]))
}

fn parse_note_args(args: &[String]) -> Result<NoteCommand, String> {
    let usage = || USAGE.to_string();
    let action = match args.first().map(String::as_str) {
        Some("add") => NoteAction::Add,
        Some("list") => NoteAction::List,
        _ => return Err(usage()),
    };
    let mut global = false;
    let mut cwd = None;
    let mut limit = None;
    let mut rest = args[1..].iter();
    while let Some(flag) = rest.next() {
        match flag.as_str() {
            "--global" => global = true,
            "--cwd" => cwd = Some(PathBuf::from(rest.next().ok_or_else(usage)?)),
            "--limit" if action == NoteAction::List => {
                let value = rest.next().ok_or_else(usage)?;
                match value.parse::<usize>() {
                    Ok(parsed) if parsed >= 1 => limit = Some(parsed),
                    _ => return Err(usage()),
                }
            }
            _ => return Err(usage()),
        }
    }
    if !global && cwd.is_none() {
        return Err(usage());
    }
    Ok(NoteCommand {
        action,
        global,
        cwd,
        limit,
    })
}

fn canonical_or_same(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn resolve_project<'a>(projects: &'a [Project], cwd: &Path) -> Option<&'a Project> {
    let canonical_cwd = canonical_or_same(cwd);
    projects
        .iter()
        .map(|project| (canonical_or_same(Path::new(&project.path)), project))
        .filter(|(path, _)| canonical_cwd.starts_with(path))
        .max_by_key(|(path, _)| path.components().count())
        .map(|(_, project)| project)
}

fn target_project(conn: &Connection, cmd: &NoteCommand) -> Result<Option<Project>, String> {
    if cmd.global {
        return Ok(None);
    }
    let cwd = cmd.cwd.as_deref().ok_or_else(|| USAGE.to_string())?;
    let projects = projects_repo::list(conn).map_err(|e| e.to_string())?;
    match resolve_project(&projects, cwd) {
        Some(project) => Ok(Some(project.clone())),
        None => Err(format!(
            "{} is not inside an AbeonCode project (use --global for a global note)",
            cwd.display()
        )),
    }
}

pub fn add(conn: &Connection, cmd: &NoteCommand, input: &str) -> Result<(Note, String), String> {
    let content = input.trim();
    if content.is_empty() {
        return Err("empty note".to_string());
    }
    if content.len() > MAX_NOTE_BYTES {
        return Err(format!(
            "note too long ({} bytes, max {MAX_NOTE_BYTES})",
            content.len()
        ));
    }
    let project = target_project(conn, cmd)?;
    let note = notes_repo::create(conn, project.as_ref().map(|p| p.id), content)
        .map_err(|e| e.to_string())?;
    let message = match &project {
        Some(project) => format!("note added (id {}) to project {}", note.id, project.name),
        None => format!("note added (id {}) as a global note", note.id),
    };
    Ok((note, message))
}

pub fn list(conn: &Connection, cmd: &NoteCommand) -> Result<String, String> {
    let project = target_project(conn, cmd)?;
    let mut notes = notes_repo::list(conn, project.as_ref().map(|p| p.id)).map_err(|e| e.to_string())?;
    if let Some(limit) = cmd.limit {
        notes.truncate(limit);
    }
    if notes.is_empty() {
        return Ok(match &project {
            Some(project) => format!("no notes in project {}", project.name),
            None => "no global notes".to_string(),
        });
    }
    Ok(format_notes(&notes))
}

fn format_timestamp(millis: i64) -> String {
    Local
        .timestamp_millis_opt(millis)
        .single()
        .map(|time| time.format("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_else(|| "unknown date".to_string())
}

pub fn format_notes(notes: &[Note]) -> String {
    notes
        .iter()
        .map(|note| {
            format!(
                "--- note {} · {} ---\n{}\n",
                note.id,
                format_timestamp(note.updated_at),
                note.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn run_command(cmd: &NoteCommand) -> Result<(), String> {
    let input = match cmd.action {
        NoteAction::Add => {
            if std::io::stdin().is_terminal() {
                return Err("expected the note on stdin (use a heredoc)".to_string());
            }
            let mut input = String::new();
            std::io::stdin()
                .read_to_string(&mut input)
                .map_err(|e| format!("cannot read the note from stdin: {e}"))?;
            Some(input)
        }
        NoteAction::List => None,
    };
    let path = db_path().map_err(|e| e.to_string())?;
    let pool = init_pool(&path).map_err(|e| e.to_string())?;
    let conn = pool.get().map_err(|e| e.to_string())?;
    match input {
        Some(input) => {
            let (note, message) = add(&conn, cmd, &input)?;
            println!("abeon-code: {message}");
            notify_app(note.id);
        }
        None => println!("{}", list(&conn, cmd)?.trim_end_matches('\n')),
    }
    Ok(())
}

#[cfg(unix)]
fn notify_app(note_id: i64) {
    let _ = request_blocking(
        &socket_path(),
        &IpcRequest::NotesChanged {
            created_note_id: Some(note_id),
        },
        std::time::Duration::from_secs(2),
    );
}

#[cfg(not(unix))]
fn notify_app(_note_id: i64) {}

pub fn try_run(args: &[String]) -> Option<i32> {
    let parsed = parse(args)?;
    let outcome = parsed.and_then(|cmd| run_command(&cmd));
    match outcome {
        Ok(()) => Some(0),
        Err(message) => {
            eprintln!("abeon-code: {message}");
            Some(2)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{init_pool, notes_repo, projects_repo, DbPool};
    use tempfile::{tempdir, NamedTempFile};

    fn args(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|p| p.to_string()).collect()
    }

    fn pool() -> DbPool {
        let file = NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        std::mem::forget(file);
        init_pool(&path).unwrap()
    }

    fn command(action: NoteAction, global: bool, cwd: Option<&Path>) -> NoteCommand {
        NoteCommand {
            action,
            global,
            cwd: cwd.map(Path::to_path_buf),
            limit: None,
        }
    }

    fn project(id: i64, path: &Path) -> Project {
        Project {
            id,
            name: format!("p{id}"),
            path: path.to_string_lossy().to_string(),
            claude_dir: String::new(),
            color: None,
            sort_order: 0,
            created_at: 0,
        }
    }

    #[test]
    fn parses_add_and_list_flags() {
        let list = parse(&args(&["abeoncode", "note", "list", "--limit", "3", "--cwd", "/p"]))
            .unwrap()
            .unwrap();
        assert_eq!(
            list,
            NoteCommand {
                action: NoteAction::List,
                global: false,
                cwd: Some(PathBuf::from("/p")),
                limit: Some(3),
            }
        );
        let add = parse(&args(&["abeoncode", "note", "add", "--global"])).unwrap().unwrap();
        assert_eq!(add.action, NoteAction::Add);
        assert!(add.global);
        assert_eq!(add.cwd, None);
    }

    #[test]
    fn rejects_unknown_flags_and_actions() {
        assert_eq!(parse(&args(&["abeoncode", "note", "edit"])), Some(Err(USAGE.to_string())));
        assert_eq!(
            parse(&args(&["abeoncode", "note", "add", "--force"])),
            Some(Err(USAGE.to_string()))
        );
        assert_eq!(
            parse(&args(&["abeoncode", "note", "add", "--limit", "2", "--global"])),
            Some(Err(USAGE.to_string()))
        );
        assert_eq!(
            parse(&args(&["abeoncode", "note", "list", "--limit", "0", "--global"])),
            Some(Err(USAGE.to_string()))
        );
        assert_eq!(
            parse(&args(&["abeoncode", "note", "list", "--cwd"])),
            Some(Err(USAGE.to_string()))
        );
        assert_eq!(parse(&args(&["abeoncode", "note", "add"])), Some(Err(USAGE.to_string())));
        assert_eq!(parse(&args(&["abeoncode", "/proj"])), None);
        assert_eq!(parse(&args(&["abeoncode"])), None);
    }

    #[test]
    fn resolves_the_closest_ancestor_project() {
        let root = tempdir().unwrap();
        let a = root.path().join("a");
        let b = a.join("b");
        let c = b.join("c");
        let x = a.join("x");
        let z = root.path().join("z");
        for dir in [&c, &x, &z] {
            std::fs::create_dir_all(dir).unwrap();
        }
        let projects = vec![project(1, &a), project(2, &b)];
        assert_eq!(resolve_project(&projects, &c).unwrap().id, 2);
        assert_eq!(resolve_project(&projects, &x).unwrap().id, 1);
        assert!(resolve_project(&projects, &z).is_none());
    }

    #[cfg(unix)]
    #[test]
    fn resolves_through_symlinks() {
        let root = tempdir().unwrap();
        let real = root.path().join("real");
        std::fs::create_dir_all(real.join("sub")).unwrap();
        let link = root.path().join("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let projects = vec![project(7, &real)];
        assert_eq!(resolve_project(&projects, &link.join("sub")).unwrap().id, 7);
    }

    #[test]
    fn add_trims_only_the_ends_and_keeps_unicode() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let cmd = command(NoteAction::Add, true, None);
        let (note, _) = add(&conn, &cmd, "  \nZadzwonić do klienta – żółć\n\nABEON_NOTE_x\n\n").unwrap();
        assert_eq!(note.content, "Zadzwonić do klienta – żółć\n\nABEON_NOTE_x");
        assert_eq!(notes_repo::get(&conn, note.id).unwrap().content, note.content);
    }

    #[test]
    fn add_rejects_empty_and_oversized_notes() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let cmd = command(NoteAction::Add, true, None);
        assert_eq!(add(&conn, &cmd, "  \n").unwrap_err(), "empty note");
        let oversized = "a".repeat(MAX_NOTE_BYTES + 1);
        assert_eq!(
            add(&conn, &cmd, &oversized).unwrap_err(),
            "note too long (65537 bytes, max 65536)"
        );
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM notes", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn add_outside_a_project_fails_unless_global() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let outside = tempdir().unwrap();
        let inside = tempdir().unwrap();
        projects_repo::insert(&conn, "Demo", &inside.path().to_string_lossy(), "-demo", None).unwrap();
        let err = add(&conn, &command(NoteAction::Add, false, Some(outside.path())), "x").unwrap_err();
        assert!(err.contains("is not inside an AbeonCode project"), "{err}");
        let (note, message) = add(&conn, &command(NoteAction::Add, true, None), "x").unwrap();
        assert_eq!(note.project_id, None);
        assert_eq!(message, "note added (id 1) as a global note");
        let (project_note, project_message) =
            add(&conn, &command(NoteAction::Add, false, Some(inside.path())), "y").unwrap();
        assert!(project_note.project_id.is_some());
        assert_eq!(project_message, "note added (id 2) to project Demo");
    }

    #[test]
    fn list_prints_newest_first_with_limit() {
        let pool = pool();
        let conn = pool.get().unwrap();
        let dir = tempdir().unwrap();
        let project = projects_repo::insert(&conn, "Demo", &dir.path().to_string_lossy(), "-demo", None).unwrap();
        let mut cmd = command(NoteAction::List, false, Some(dir.path()));
        cmd.limit = Some(2);
        assert_eq!(list(&conn, &cmd).unwrap(), "no notes in project Demo");
        for text in ["first", "second", "third"] {
            notes_repo::create(&conn, Some(project.id), text).unwrap();
        }
        let output = list(&conn, &cmd).unwrap();
        assert_eq!(output.matches("--- note").count(), 2);
        assert!(output.find("third").unwrap() < output.find("second").unwrap());
        assert!(!output.contains("first"));
        assert!(output.contains("\n\n--- note"));
        let global = command(NoteAction::List, true, None);
        assert_eq!(list(&conn, &global).unwrap(), "no global notes");
    }
}

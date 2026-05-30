use serde::Serialize;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum AppError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("invalid path {path}: {reason}")]
    InvalidPath { path: String, reason: String },
    #[error("claude project directory missing: {path}")]
    ClaudeDirMissing { path: String },
    #[error("parse error in {file} line {line}: {message}")]
    Parse { file: String, line: usize, message: String },
    #[error("pty error: {0}")]
    Pty(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("git: {0}")]
    Git(#[from] git2::Error),
    #[error("db: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("db pool: {0}")]
    DbPool(#[from] r2d2::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Other(String),
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Wire<'a> {
            code: &'a str,
            message: String,
        }
        let code = match self {
            AppError::NotFound(_) => "not_found",
            AppError::InvalidPath { .. } => "invalid_path",
            AppError::ClaudeDirMissing { .. } => "claude_dir_missing",
            AppError::Parse { .. } => "parse",
            AppError::Pty(_) => "pty",
            AppError::Io(_) => "io",
            AppError::Git(_) => "git",
            AppError::Db(_) | AppError::DbPool(_) => "db",
            AppError::Json(_) => "json",
            AppError::Other(_) => "other",
        };
        Wire {
            code,
            message: self.to_string(),
        }
        .serialize(s)
    }
}

pub type AppResult<T> = Result<T, AppError>;

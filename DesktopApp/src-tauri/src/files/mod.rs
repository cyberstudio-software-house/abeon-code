pub mod content;
pub mod listing;
pub mod paths;
pub mod search;
pub mod watch;
pub mod write;

pub const MAX_TEXT_BYTES: u64 = 1_048_576;
pub const MAX_IMAGE_BYTES: u64 = 10 * 1_048_576;
pub const SEARCH_LIMIT: usize = 200;
pub const SEARCH_VISIT_CAP: usize = 200_000;
pub const FALLBACK_SKIP_DIRS: &[&str] = &[
    "node_modules",
    "vendor",
    "target",
    "dist",
    "build",
    ".venv",
    "__pycache__",
];
pub const MARKDOWN_EXTENSIONS: &[&str] = &["md", "markdown", "mdx"];
pub const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];
pub const IMAGE_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
];
pub const NOT_REGULAR_FILE: &str = "to nie jest zwykły plik";

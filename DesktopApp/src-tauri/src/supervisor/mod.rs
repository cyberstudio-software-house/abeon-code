pub mod approvals;
pub mod claude_md;
pub mod core;
pub mod discord;
pub mod effects;
#[cfg(unix)]
pub mod entry;
pub mod events;
pub mod guard;
pub mod hook_io;
#[cfg(unix)]
pub mod ipc;
#[cfg(unix)]
pub mod mcp;
pub mod presence;
pub mod process;
pub mod provenance;
pub mod runtime;
pub mod settings;
#[cfg(test)]
pub(crate) mod test_support;
pub mod tools;
pub mod transcript;
pub mod workdir;

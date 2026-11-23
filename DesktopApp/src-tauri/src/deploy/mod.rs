pub mod ci;
pub mod cluster;
pub mod detect;
pub mod excerpt;
pub mod reflog;
pub mod repos;
pub mod runner;
pub mod validate;
pub mod vpn;

#[cfg(test)]
pub mod test_support;

pub const DEPLOY_CHANGED_EVENT: &str = "deploy://changed";

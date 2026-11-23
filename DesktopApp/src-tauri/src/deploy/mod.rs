pub mod ci;
pub mod detect;
pub mod excerpt;
pub mod repos;
pub mod runner;
pub mod validate;

#[cfg(test)]
pub mod test_support;

pub const DEPLOY_CHANGED_EVENT: &str = "deploy://changed";

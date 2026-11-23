pub mod ci;
pub mod cluster;
pub mod detect;
pub mod excerpt;
pub mod machine;
pub mod reflog;
pub mod repos;
pub mod runner;
pub mod tracker;
pub mod validate;
pub mod vpn;

#[cfg(test)]
pub mod test_support;

use std::time::Duration;

pub const DEPLOY_CHANGED_EVENT: &str = "deploy://changed";
pub const VPN_SETTING_KEY: &str = "deployVpnConnection";
pub const TRACKING_HISTORY: usize = 10;

pub const RUN_APPEAR_LIMIT: Duration = Duration::from_secs(5 * 60);
pub const ROLLOUT_LIMIT: Duration = Duration::from_secs(15 * 60);
pub const PAUSE_LIMIT: Duration = Duration::from_secs(24 * 60 * 60);
pub const BUILD_POLL: Duration = Duration::from_secs(15);
pub const CLUSTER_POLL: Duration = Duration::from_secs(10);
pub const BLOCKED_POLL: Duration = Duration::from_secs(60);
pub const PUSH_POLL: Duration = Duration::from_secs(3);

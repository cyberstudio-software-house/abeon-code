//! Centrifugo channel-name builders, shared so the desktop bridge (which
//! subscribes to `cmd` and publishes to `dev`/`sess`) and CloudService (which
//! publishes to `cmd`) cannot disagree on the `abeon-cloud-*` prefixes.

/// Up: authorized commands. Published by CloudService, subscribed by the desktop.
pub fn cmd_channel(device_id: &str) -> String { format!("abeon-cloud-cmd:{device_id}") }

/// Down: command results / device presence. Published by the desktop.
pub fn result_channel(device_id: &str) -> String { format!("abeon-cloud-dev:{device_id}") }

/// Down: per-session mirror events. Published by the desktop.
pub fn session_channel(session_id: &str) -> String { format!("abeon-cloud-sess:{session_id}") }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_prefixes_are_stable() {
        assert_eq!(cmd_channel("d1"), "abeon-cloud-cmd:d1");
        assert_eq!(result_channel("d1"), "abeon-cloud-dev:d1");
        assert_eq!(session_channel("s1"), "abeon-cloud-sess:s1");
    }
}

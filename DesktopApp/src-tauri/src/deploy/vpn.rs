use crate::deploy::runner::CommandRunner;
use std::time::Duration;

const NMCLI_TIMEOUT: Duration = Duration::from_secs(30);

pub fn supported() -> bool {
    cfg!(target_os = "linux")
}

pub async fn connect(runner: &dyn CommandRunner, connection: &str) -> bool {
    if !supported() {
        return false;
    }
    let args = ["connection", "up", "id", connection].map(str::to_string).to_vec();
    match runner.run("nmcli", &args, NMCLI_TIMEOUT).await {
        Ok(output) => output.status == Some(0),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::runner::{ok, CommandOutput, FakeRunner, RunError};

    fn exit(code: i32) -> Result<CommandOutput, RunError> {
        Ok(CommandOutput { status: Some(code), stdout: String::new(), stderr: "boom".to_string() })
    }

    #[test]
    fn support_follows_the_target_os() {
        assert_eq!(supported(), cfg!(target_os = "linux"));
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_zero_exit_status_means_connected_and_the_name_is_one_argument() {
        let runner = FakeRunner::new().on("nmcli", &["connection", "up"], ok("Connection activated"));
        assert!(connect(&runner, "Office VPN").await);
        assert_eq!(
            runner.calls(),
            vec![(
                "nmcli".to_string(),
                ["connection", "up", "id", "Office VPN"].map(str::to_string).to_vec()
            )]
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_name_that_is_an_nmcli_keyword_is_still_passed_as_the_connection_id() {
        let runner = FakeRunner::new().on("nmcli", &["connection", "up", "id"], ok(""));
        assert!(connect(&runner, "help").await);
        assert_eq!(runner.calls()[0].1, ["connection", "up", "id", "help"].map(str::to_string).to_vec());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn any_other_outcome_means_not_connected() {
        for reply in [exit(4), exit(10), Err(RunError::NotFound), Err(RunError::TimedOut)] {
            let runner = FakeRunner::new().on("nmcli", &["connection", "up"], reply);
            assert!(!connect(&runner, "Office VPN").await);
        }
        let killed = FakeRunner::new().on(
            "nmcli",
            &["connection", "up"],
            Ok(CommandOutput { status: None, stdout: String::new(), stderr: String::new() }),
        );
        assert!(!connect(&killed, "Office VPN").await);
    }

    #[cfg(not(target_os = "linux"))]
    #[tokio::test]
    async fn nothing_is_run_on_unsupported_systems() {
        let runner = FakeRunner::new().on("nmcli", &["connection", "up"], ok(""));
        assert!(!connect(&runner, "Office VPN").await);
        assert!(runner.calls().is_empty());
    }
}

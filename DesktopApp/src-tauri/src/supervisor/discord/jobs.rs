use std::sync::mpsc;
use std::time::Duration;

use tokio::sync::mpsc::UnboundedSender;

use super::registry::{KeyAnswer, PostRequest, PostResult};
use crate::supervisor::effects::DiscordSync;

pub const REPLY_TIMEOUT: Duration = Duration::from_secs(30);
pub const ERROR_BUTTONS_OFFLINE: &str =
    "Przyciski Discorda nie działają — wyślij wiadomość przez reply";

pub enum ButtonJob {
    Post {
        request: PostRequest,
        reply: mpsc::Sender<Result<PostResult, String>>,
    },
    Answered {
        answers: Vec<KeyAnswer>,
        reply: mpsc::Sender<Vec<String>>,
    },
    Sync(DiscordSync),
    Reconfigure,
}

#[derive(Clone)]
pub struct ButtonsHandle {
    jobs: UnboundedSender<ButtonJob>,
}

fn offline() -> String {
    ERROR_BUTTONS_OFFLINE.to_string()
}

impl ButtonsHandle {
    pub fn new(jobs: UnboundedSender<ButtonJob>) -> Self {
        ButtonsHandle { jobs }
    }

    pub fn sync(&self, change: DiscordSync) {
        let _ = self.jobs.send(ButtonJob::Sync(change));
    }

    pub fn reconfigure(&self) {
        let _ = self.jobs.send(ButtonJob::Reconfigure);
    }

    pub fn post(&self, request: PostRequest) -> Result<PostResult, String> {
        self.post_with_timeout(request, REPLY_TIMEOUT)
    }

    pub fn post_with_timeout(
        &self,
        request: PostRequest,
        timeout: Duration,
    ) -> Result<PostResult, String> {
        let (reply, receiver) = mpsc::channel();
        self.jobs
            .send(ButtonJob::Post { request, reply })
            .map_err(|_| offline())?;
        receiver.recv_timeout(timeout).map_err(|_| offline())?
    }

    pub fn answered(&self, answers: Vec<KeyAnswer>) -> Result<Vec<String>, String> {
        let (reply, receiver) = mpsc::channel();
        self.jobs
            .send(ButtonJob::Answered { answers, reply })
            .map_err(|_| offline())?;
        receiver.recv_timeout(REPLY_TIMEOUT).map_err(|_| offline())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn request() -> PostRequest {
        PostRequest { blocks: Vec::new() }
    }

    #[test]
    fn post_times_out_into_the_offline_error() {
        let (sender, _jobs) = tokio::sync::mpsc::unbounded_channel();
        let handle = ButtonsHandle::new(sender);
        assert_eq!(
            handle.post_with_timeout(request(), Duration::from_millis(50)),
            Err(ERROR_BUTTONS_OFFLINE.to_string())
        );
    }

    #[test]
    fn post_without_a_consumer_fails_at_once() {
        let (sender, jobs) = tokio::sync::mpsc::unbounded_channel();
        drop(jobs);
        let handle = ButtonsHandle::new(sender);
        let started = Instant::now();
        assert_eq!(
            handle.post(request()),
            Err(ERROR_BUTTONS_OFFLINE.to_string())
        );
        assert_eq!(
            handle.answered(Vec::new()),
            Err(ERROR_BUTTONS_OFFLINE.to_string())
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}

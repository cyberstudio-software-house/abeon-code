use std::time::Duration;

use crate::supervisor::core::{ApprovalSource, SupervisorCore};
use crate::supervisor::discord::client::{DiscordClient, DiscordError};
use crate::supervisor::discord::replies::{match_replies, snowflake_at};

pub const POLL_INTERVAL: Duration = Duration::from_secs(10);

const REACTION_APPROVED: &str = "✅";
const REACTION_REJECTED: &str = "❌";

pub async fn poll_approvals(
    client: &DiscordClient,
    chat_id: &str,
    allow_from: &[String],
    core: &SupervisorCore,
) -> Result<usize, DiscordError> {
    let pending = core.pending_approval_codes();
    let Some(oldest) = pending.iter().map(|entry| entry.created_at_ms).min() else {
        return Ok(0);
    };
    let after = snowflake_at(oldest - 1);
    let messages = client.messages_after(chat_id, &after).await?;
    let mut resolved = 0;
    for reply in match_replies(&messages, allow_from, &pending) {
        if core
            .resolve_approval(&reply.approval_id, reply.approve, ApprovalSource::Discord)
            .is_err()
        {
            continue;
        }
        resolved += 1;
        let emoji = if reply.approve {
            REACTION_APPROVED
        } else {
            REACTION_REJECTED
        };
        let _ = client.react(chat_id, &reply.message_id, emoji).await;
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::supervisor::ApprovalView;
    use crate::supervisor::core::ApprovalState;
    use crate::supervisor::test_support::*;
    use serde_json::json;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const CHAT: &str = "d1";
    const USER: &str = "u1";

    async fn blocked_core() -> (Arc<FakeEffects>, Arc<SupervisorCore>, ApprovalView) {
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        effects.quiet.store(true, Ordering::SeqCst);
        core.expect_cli_prompt("s1", "przygotuj wydanie");
        core.on_session_hook(prompt("s1", "przygotuj wydanie"))
            .await;
        core.on_session_hook(bash("s1", "git push")).await;
        let approval = core.snapshot().approvals.into_iter().next().unwrap();
        (effects, core, approval)
    }

    fn allow() -> Vec<String> {
        vec![USER.to_string()]
    }

    async fn serve_messages(server: &MockServer, messages: serde_json::Value) {
        Mock::given(method("GET"))
            .and(path(format!("/channels/{CHAT}/messages")))
            .respond_with(ResponseTemplate::new(200).set_body_json(messages))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn poll_resolves_a_coded_reply_and_reacts() {
        let (_effects, core, approval) = blocked_core().await;
        let message_id = snowflake_at(approval.created_at + 1000);
        let server = MockServer::start().await;
        serve_messages(
            &server,
            json!([{
                "id": message_id,
                "author": { "id": USER },
                "content": format!("zatwierdzam {}", approval.code)
            }]),
        )
        .await;
        Mock::given(method("PUT"))
            .and(path(format!(
                "/channels/{CHAT}/messages/{message_id}/reactions/%E2%9C%85/@me"
            )))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        let resolved = poll_approvals(&client, CHAT, &allow(), &core)
            .await
            .unwrap();
        assert_eq!(resolved, 1);
        assert_eq!(
            core.approval_status(&approval.id).unwrap().status,
            ApprovalState::Approved
        );
    }

    #[tokio::test]
    async fn poll_rejects_and_reacts_with_a_cross() {
        let (_effects, core, approval) = blocked_core().await;
        let message_id = snowflake_at(approval.created_at + 1000);
        let server = MockServer::start().await;
        serve_messages(
            &server,
            json!([{
                "id": message_id,
                "author": { "id": USER },
                "content": format!("odrzucam {}", approval.code)
            }]),
        )
        .await;
        Mock::given(method("PUT"))
            .and(path(format!(
                "/channels/{CHAT}/messages/{message_id}/reactions/%E2%9D%8C/@me"
            )))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        let resolved = poll_approvals(&client, CHAT, &allow(), &core)
            .await
            .unwrap();
        assert_eq!(resolved, 1);
        assert_eq!(
            core.approval_status(&approval.id).unwrap().status,
            ApprovalState::Rejected
        );
    }

    #[tokio::test]
    async fn poll_ignores_the_bots_own_message() {
        let (_effects, core, approval) = blocked_core().await;
        let message_id = snowflake_at(approval.created_at + 1000);
        let server = MockServer::start().await;
        serve_messages(
            &server,
            json!([{
                "id": message_id,
                "author": { "id": USER, "bot": true },
                "content": format!("zatwierdzam {}", approval.code)
            }]),
        )
        .await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(204))
            .expect(0)
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        let resolved = poll_approvals(&client, CHAT, &allow(), &core)
            .await
            .unwrap();
        assert_eq!(resolved, 0);
        assert_eq!(
            core.approval_status(&approval.id).unwrap().status,
            ApprovalState::Pending
        );
    }

    #[tokio::test]
    async fn poll_makes_no_request_without_pending_approvals() {
        let (_effects, core) = setup();
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .expect(0)
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        let resolved = poll_approvals(&client, CHAT, &allow(), &core)
            .await
            .unwrap();
        assert_eq!(resolved, 0);
    }

    #[tokio::test]
    async fn poll_asks_for_messages_after_the_oldest_request() {
        let (_effects, core, approval) = blocked_core().await;
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path(format!("/channels/{CHAT}/messages")))
            .and(wiremock::matchers::query_param(
                "after",
                snowflake_at(approval.created_at - 1),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!([])))
            .expect(1)
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        poll_approvals(&client, CHAT, &allow(), &core)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn poll_survives_a_failed_reaction() {
        let (_effects, core, approval) = blocked_core().await;
        let message_id = snowflake_at(approval.created_at + 1000);
        let server = MockServer::start().await;
        serve_messages(
            &server,
            json!([{
                "id": message_id,
                "author": { "id": USER },
                "content": format!("zatwierdzam {}", approval.code)
            }]),
        )
        .await;
        Mock::given(method("PUT"))
            .respond_with(ResponseTemplate::new(403))
            .mount(&server)
            .await;
        let client = DiscordClient::with_base("tok", server.uri());
        let resolved = poll_approvals(&client, CHAT, &allow(), &core)
            .await
            .unwrap();
        assert_eq!(resolved, 1);
    }
}

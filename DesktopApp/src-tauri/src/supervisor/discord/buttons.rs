use std::collections::BTreeSet;
use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::Value;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{interval_at, sleep, timeout, Instant, MissedTickBehavior};

use super::client::{DiscordClient, DiscordError};
use super::gateway::{run_gateway, GatewayStatus, Interaction};
use super::interactions::{callback_payload, decide};
use super::jobs::{ButtonJob, ButtonsHandle, ERROR_BUTTONS_OFFLINE};
use super::registry::{ButtonRegistry, KeyAnswer, PostRequest, PostResult};
use super::render::{render, ApprovalMark};
use crate::supervisor::core::{ApprovalState, SupervisorCore};
use crate::supervisor::effects::DiscordSync;

const CONFIG_REFRESH: Duration = Duration::from_secs(60);
const MAX_RETRY_WAIT: Duration = Duration::from_secs(5);
const GATEWAY_STOP_TIMEOUT: Duration = Duration::from_secs(5);
const POST_DEADLINE: Duration = Duration::from_secs(25);
const MAX_FOLLOW_UP_PATCHES: usize = 2;

pub type ConfigSource = Arc<dyn Fn() -> Result<ButtonsConfig, String> + Send + Sync>;

#[derive(Clone, PartialEq)]
pub struct ButtonsConfig {
    pub token: String,
    pub chat_id: String,
    pub allow_from: Vec<String>,
}

impl fmt::Debug for ButtonsConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ButtonsConfig")
            .field("token", &"<redacted>")
            .field("chat_id", &self.chat_id)
            .field("allow_from", &self.allow_from)
            .finish()
    }
}

#[derive(Clone, Debug)]
pub struct Endpoints {
    pub api_base: String,
    pub gateway_url: String,
}

struct Live {
    config: ButtonsConfig,
    client: DiscordClient,
}

type Current = Result<Arc<Live>, String>;

struct Shared {
    core: Arc<SupervisorCore>,
    registry: Mutex<ButtonRegistry>,
    current: Mutex<Current>,
}

impl Shared {
    fn current(&self) -> Current {
        self.current.lock().clone()
    }
}

struct Gateway {
    token: String,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}

struct Service {
    shared: Arc<Shared>,
    config: ConfigSource,
    endpoints: Endpoints,
    status: watch::Sender<GatewayStatus>,
    interactions: mpsc::UnboundedSender<Interaction>,
    gateway: Option<Gateway>,
    dirty: BTreeSet<u64>,
}

fn log_error(error: &dyn fmt::Display) {
    eprintln!("supervisor: discord buttons: {error}");
}

fn callback_error(error: &DiscordError) -> String {
    match error {
        DiscordError::Unauthorized => "interaction callback failed: HTTP 401".to_string(),
        other => format!("interaction callback failed: {other}"),
    }
}

async fn with_retry<T, F, Fut>(mut call: F) -> Result<T, DiscordError>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, DiscordError>>,
{
    match call().await {
        Err(DiscordError::RateLimited(wait)) => {
            sleep(wait.min(MAX_RETRY_WAIT)).await;
            call().await
        }
        outcome => outcome,
    }
}

fn approval_mark(state: ApprovalState) -> Option<ApprovalMark> {
    match state {
        ApprovalState::Pending => None,
        ApprovalState::Approved => Some(ApprovalMark::Approved),
        ApprovalState::Rejected => Some(ApprovalMark::Rejected),
        ApprovalState::Expired => Some(ApprovalMark::Expired),
    }
}

fn apply_sync(registry: &mut ButtonRegistry, change: DiscordSync) -> Vec<u64> {
    match change {
        DiscordSync::SessionSettled { session_id } => registry.settle_session(&session_id),
        DiscordSync::QuestionSettled { question_id } => registry.settle_question(&question_id),
        DiscordSync::ApprovalSettled { approval_id, state } => approval_mark(state)
            .and_then(|mark| registry.mark_approval(&approval_id, mark))
            .into_iter()
            .collect(),
    }
}

fn rendered(shared: &Shared, message: u64) -> Option<(String, Value)> {
    let registry = shared.registry.lock();
    let discord_id = registry.discord_id(message)?;
    let view = registry.view(message)?;
    Some((discord_id, render(&view)))
}

async fn edit_latest(
    shared: &Shared,
    live: &Live,
    message: u64,
) -> Result<Option<Value>, DiscordError> {
    let Some((discord_id, payload)) = rendered(shared, message) else {
        return Ok(None);
    };
    live.client
        .edit_message(&live.config.chat_id, &discord_id, &payload)
        .await?;
    Ok(Some(payload))
}

async fn patch_message(shared: &Shared, live: &Live, message: u64) {
    for _ in 0..=MAX_FOLLOW_UP_PATCHES {
        let sent = match with_retry(|| edit_latest(shared, live, message)).await {
            Ok(Some(sent)) => sent,
            Ok(None) => return,
            Err(error) => {
                log_error(&error);
                return;
            }
        };
        let latest = rendered(shared, message).map(|(_, payload)| payload);
        if latest.is_none_or(|latest| latest == sent) {
            return;
        }
    }
}

async fn patch(shared: &Shared, live: &Live, messages: impl IntoIterator<Item = u64>) {
    let mut patched = BTreeSet::new();
    for message in messages {
        if patched.insert(message) {
            patch_message(shared, live, message).await;
        }
    }
}

enum SendFailure {
    Discord(DiscordError),
    Deadline,
}

async fn send_message(
    live: &Live,
    payload: &Value,
    deadline: Instant,
) -> Result<String, SendFailure> {
    let mut retried = false;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(SendFailure::Deadline);
        }
        let sent = timeout(
            remaining,
            live.client.post_message(&live.config.chat_id, payload),
        )
        .await;
        match sent {
            Err(_) => return Err(SendFailure::Deadline),
            Ok(Ok(discord_id)) => return Ok(discord_id),
            Ok(Err(DiscordError::RateLimited(wait))) if !retried => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(SendFailure::Deadline);
                }
                retried = true;
                sleep(wait.min(MAX_RETRY_WAIT).min(remaining)).await;
            }
            Ok(Err(error)) => return Err(SendFailure::Discord(error)),
        }
    }
}

async fn post(
    shared: &Shared,
    live: &Live,
    request: PostRequest,
    deadline: Instant,
) -> Result<PostResult, String> {
    let (planned, result) = {
        let mut registry = shared.registry.lock();
        let planned = registry.plan_post(request);
        let rendered: Vec<(u64, Value)> = planned
            .messages
            .iter()
            .filter_map(|message| {
                registry
                    .view(*message)
                    .map(|view| (*message, render(&view)))
            })
            .collect();
        (rendered, planned.result)
    };
    for (index, (message, payload)) in planned.iter().enumerate() {
        match send_message(live, payload, deadline).await {
            Ok(discord_id) => shared.registry.lock().confirm_posted(*message, discord_id),
            Err(failure) => {
                let reply = match failure {
                    SendFailure::Discord(error) => {
                        log_error(&error);
                        error.to_string()
                    }
                    SendFailure::Deadline => {
                        log_error(&"post did not finish before its deadline");
                        ERROR_BUTTONS_OFFLINE.to_string()
                    }
                };
                let mut registry = shared.registry.lock();
                for (unsent, _) in &planned[index..] {
                    registry.discard(*unsent);
                }
                return Err(reply);
            }
        }
    }
    Ok(result)
}

async fn answer(shared: &Shared, live: &Live, answers: &[KeyAnswer]) -> Vec<String> {
    let outcome = shared.registry.lock().answer_keys(answers);
    patch(shared, live, outcome.changed).await;
    outcome.skipped
}

async fn handle_interaction(shared: Arc<Shared>, interaction: Interaction) {
    let Ok(live) = shared.current() else {
        return;
    };
    let decided = {
        let shared = shared.clone();
        let live = live.clone();
        let interaction = interaction.clone();
        tokio::task::spawn_blocking(move || {
            let mut registry = shared.registry.lock();
            decide(
                &interaction,
                &live.config.allow_from,
                &mut registry,
                &shared.core,
            )
        })
        .await
    };
    let outcome = match decided {
        Ok(outcome) => outcome,
        Err(error) => {
            log_error(&error);
            return;
        }
    };
    let payload = callback_payload(&outcome.reply);
    if let Err(error) = live
        .client
        .interaction_callback(&interaction.id, &interaction.token, &payload)
        .await
    {
        log_error(&callback_error(&error));
    }
    if let Some(answer) = outcome.answer {
        shared.core.record_discord_answer(answer);
    }
}

async fn dispatch_interactions(
    shared: Arc<Shared>,
    mut interactions: mpsc::UnboundedReceiver<Interaction>,
) {
    while let Some(interaction) = interactions.recv().await {
        tokio::spawn(handle_interaction(shared.clone(), interaction));
    }
}

impl Service {
    async fn run(mut self, mut jobs: mpsc::UnboundedReceiver<ButtonJob>) {
        self.refresh().await;
        let mut refresh = interval_at(Instant::now() + CONFIG_REFRESH, CONFIG_REFRESH);
        refresh.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                job = jobs.recv() => match job {
                    Some(job) => self.handle(job).await,
                    None => break,
                },
                _ = refresh.tick() => self.refresh().await,
            }
        }
        self.stop_gateway().await;
    }

    async fn handle(&mut self, job: ButtonJob) {
        let current = self.shared.current();
        match job {
            ButtonJob::Reconfigure => self.refresh().await,
            ButtonJob::Post { request, reply } => {
                let outcome = match &current {
                    Ok(live) => {
                        let deadline = Instant::now() + POST_DEADLINE;
                        post(&self.shared, live, request, deadline).await
                    }
                    Err(reason) => Err(reason.clone()),
                };
                let _ = reply.send(outcome);
            }
            ButtonJob::Answered { answers, reply } => {
                let outcome = match &current {
                    Ok(live) => Ok(answer(&self.shared, live, &answers).await),
                    Err(reason) => Err(reason.clone()),
                };
                let _ = reply.send(outcome);
            }
            ButtonJob::Sync(change) => {
                let changed = apply_sync(&mut self.shared.registry.lock(), change);
                match &current {
                    Ok(live) => patch(&self.shared, live, changed).await,
                    Err(_) => self.dirty.extend(changed),
                }
            }
        }
    }

    async fn refresh(&mut self) {
        let source = self.config.clone();
        let read = tokio::task::spawn_blocking(move || source())
            .await
            .unwrap_or_else(|error| Err(error.to_string()));
        match read {
            Err(reason) => {
                self.stop_gateway().await;
                *self.shared.current.lock() = Err(reason.clone());
                let off = GatewayStatus::Off(reason);
                self.status.send_if_modified(|status| {
                    if *status == off {
                        return false;
                    }
                    *status = off;
                    true
                });
            }
            Ok(config) => {
                let unchanged =
                    matches!(&*self.shared.current.lock(), Ok(live) if live.config == config);
                if !unchanged {
                    let client = DiscordClient::with_base(
                        config.token.clone(),
                        self.endpoints.api_base.clone(),
                    );
                    *self.shared.current.lock() = Ok(Arc::new(Live {
                        config: config.clone(),
                        client,
                    }));
                }
                let restart = self
                    .gateway
                    .as_ref()
                    .is_none_or(|gateway| gateway.token != config.token);
                if restart {
                    self.stop_gateway().await;
                    self.start_gateway(config.token);
                }
                self.flush_dirty().await;
            }
        }
    }

    async fn flush_dirty(&mut self) {
        if self.dirty.is_empty() {
            return;
        }
        let Ok(live) = self.shared.current() else {
            return;
        };
        let dirty = std::mem::take(&mut self.dirty);
        patch(&self.shared, &live, dirty).await;
    }

    fn start_gateway(&mut self, token: String) {
        let (stop, stop_receiver) = watch::channel(false);
        let task = tokio::spawn(run_gateway(
            self.endpoints.gateway_url.clone(),
            token.clone(),
            self.interactions.clone(),
            self.status.clone(),
            stop_receiver,
        ));
        self.gateway = Some(Gateway { token, stop, task });
    }

    async fn stop_gateway(&mut self) {
        let Some(mut gateway) = self.gateway.take() else {
            return;
        };
        let _ = gateway.stop.send(true);
        if timeout(GATEWAY_STOP_TIMEOUT, &mut gateway.task)
            .await
            .is_err()
        {
            gateway.task.abort();
        }
    }
}

pub fn start(
    core: Arc<SupervisorCore>,
    config: Arc<dyn Fn() -> Result<ButtonsConfig, String> + Send + Sync>,
    endpoints: Endpoints,
) -> (ButtonsHandle, watch::Receiver<GatewayStatus>) {
    let (jobs, job_receiver) = mpsc::unbounded_channel();
    let (interactions, interaction_receiver) = mpsc::unbounded_channel();
    let (status, status_receiver) = watch::channel(GatewayStatus::Connecting);
    let shared = Arc::new(Shared {
        core,
        registry: Mutex::new(ButtonRegistry::default()),
        current: Mutex::new(Err(String::new())),
    });
    tokio::spawn(dispatch_interactions(shared.clone(), interaction_receiver));
    let service = Service {
        shared,
        config,
        endpoints,
        status,
        interactions,
        gateway: None,
        dirty: BTreeSet::new(),
    };
    tokio::spawn(service.run(job_receiver));
    (ButtonsHandle::new(jobs), status_receiver)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::json;
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::WebSocketStream;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Request, ResponseTemplate};

    use crate::supervisor::discord::registry::{PostApproval, PostBlock, PostItem, PostedKey};
    use crate::supervisor::events::SupervisorEvent;
    use crate::supervisor::test_support::{bash, link_discord, setup};

    const TEST_TIMEOUT: Duration = Duration::from_secs(10);
    const POLL_STEP: Duration = Duration::from_millis(20);
    const SILENCE: Duration = Duration::from_millis(300);
    const CALLBACK_DELAY: Duration = Duration::from_millis(500);
    const OWNER: &str = "user-1";
    const CHAT: &str = "chat-1";
    const BOT_TOKEN: &str = "bot-token";
    const INTERACTION_TOKEN: &str = "interaction-token";
    const MESSAGES_PATH: &str = "/channels/chat-1/messages";
    const LABEL: &str = "projekt · s1";
    const NO_TOKEN: &str = "brak tokenu bota";

    type ServerSocket = WebSocketStream<TcpStream>;
    type SharedConfig = Arc<Mutex<Result<ButtonsConfig, String>>>;

    struct Harness {
        server: MockServer,
        listener: TcpListener,
        config: SharedConfig,
        handle: ButtonsHandle,
        status: watch::Receiver<GatewayStatus>,
        core: Arc<SupervisorCore>,
    }

    fn config_with(token: &str) -> ButtonsConfig {
        ButtonsConfig {
            token: token.into(),
            chat_id: CHAT.into(),
            allow_from: vec![OWNER.into()],
        }
    }

    async fn harness(initial: Result<ButtonsConfig, String>) -> Harness {
        let server = MockServer::start().await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let gateway_url = format!("ws://127.0.0.1:{}/", listener.local_addr().unwrap().port());
        let (effects, core) = setup();
        *effects.branch.lock() = Some("main".into());
        link_discord(&effects);
        core.set_discord_active(true);
        core.set_away(true);
        let config: SharedConfig = Arc::new(Mutex::new(initial));
        let source = config.clone();
        let (handle, status) = start(
            core.clone(),
            Arc::new(move || source.lock().clone()),
            Endpoints {
                api_base: server.uri(),
                gateway_url,
            },
        );
        Harness {
            server,
            listener,
            config,
            handle,
            status,
            core,
        }
    }

    async fn post(handle: &ButtonsHandle, request: PostRequest) -> Result<PostResult, String> {
        let handle = handle.clone();
        tokio::task::spawn_blocking(move || handle.post(request))
            .await
            .unwrap()
    }

    async fn answered(
        handle: &ButtonsHandle,
        answers: Vec<KeyAnswer>,
    ) -> Result<Vec<String>, String> {
        let handle = handle.clone();
        tokio::task::spawn_blocking(move || handle.answered(answers))
            .await
            .unwrap()
    }

    fn item(question_id: &str, options: &[&str]) -> PostItem {
        PostItem {
            question_id: question_id.into(),
            question: format!("Pytanie {question_id}?"),
            options: options.iter().map(|option| option.to_string()).collect(),
            text_options: vec![],
            context: None,
        }
    }

    fn block(items: Vec<PostItem>, approvals: Vec<PostApproval>) -> PostRequest {
        PostRequest {
            blocks: vec![PostBlock {
                session_id: "s1".into(),
                label: LABEL.into(),
                items,
                approvals,
            }],
        }
    }

    fn key_answer(key: &str, value: &str) -> KeyAnswer {
        KeyAnswer {
            key: key.into(),
            value: value.into(),
        }
    }

    fn message_path(discord_id: &str) -> String {
        format!("{MESSAGES_PATH}/{discord_id}")
    }

    fn callback_path(interaction_id: &str) -> String {
        format!("/interactions/{interaction_id}/{INTERACTION_TOKEN}/callback")
    }

    fn posted_reply(discord_id: &str) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(json!({ "id": discord_id }))
    }

    async fn respond_to_posts(server: &MockServer, discord_id: &str) {
        Mock::given(method("POST"))
            .and(path(MESSAGES_PATH))
            .respond_with(posted_reply(discord_id))
            .mount(server)
            .await;
    }

    async fn respond_to_edits(server: &MockServer, discord_id: &str) {
        Mock::given(method("PATCH"))
            .and(path(message_path(discord_id)))
            .respond_with(posted_reply(discord_id))
            .mount(server)
            .await;
    }

    async fn respond_to_callback(
        server: &MockServer,
        interaction_id: &str,
        response: ResponseTemplate,
    ) {
        Mock::given(method("POST"))
            .and(path(callback_path(interaction_id)))
            .respond_with(response)
            .expect(1)
            .mount(server)
            .await;
    }

    async fn rate_limit_once(server: &MockServer, verb: &str, url_path: &str, seconds: f64) {
        Mock::given(method(verb))
            .and(path(url_path))
            .respond_with(
                ResponseTemplate::new(429).set_body_json(json!({ "retry_after": seconds })),
            )
            .up_to_n_times(1)
            .with_priority(1)
            .mount(server)
            .await;
    }

    fn take_discord_answer(core: &SupervisorCore) -> Option<(String, String, String)> {
        core.take_events()
            .into_iter()
            .find_map(|event| match event {
                SupervisorEvent::DiscordAnswer {
                    question_id,
                    key,
                    value,
                    ..
                } => Some((question_id, key, value)),
                _ => None,
            })
    }

    fn live_for(server: &MockServer) -> Live {
        Live {
            config: config_with(BOT_TOKEN),
            client: DiscordClient::with_base(BOT_TOKEN, server.uri()),
        }
    }

    fn shared_for(core: Arc<SupervisorCore>) -> Shared {
        Shared {
            core,
            registry: Mutex::new(ButtonRegistry::default()),
            current: Mutex::new(Err(String::new())),
        }
    }

    async fn requests(server: &MockServer, verb: &str, url_path: &str) -> Vec<Request> {
        server
            .received_requests()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|request| request.method.as_str() == verb && request.url.path() == url_path)
            .collect()
    }

    async fn wait_for_requests(
        server: &MockServer,
        verb: &str,
        url_path: &str,
        count: usize,
    ) -> Vec<Request> {
        loop {
            let found = requests(server, verb, url_path).await;
            if found.len() >= count {
                return found;
            }
            sleep(POLL_STEP).await;
        }
    }

    fn body(request: &Request) -> Value {
        request.body_json().unwrap()
    }

    fn strings(value: &Value, field: &str) -> Vec<String> {
        let mut found = Vec::new();
        collect(value, field, &mut found);
        found
    }

    fn collect(value: &Value, field: &str, found: &mut Vec<String>) {
        match value {
            Value::Array(list) => list.iter().for_each(|entry| collect(entry, field, found)),
            Value::Object(map) => {
                if let Some(text) = map.get(field).and_then(Value::as_str) {
                    found.push(text.to_string());
                }
                map.values().for_each(|entry| collect(entry, field, found));
            }
            _ => {}
        }
    }

    async fn accept(listener: &TcpListener) -> ServerSocket {
        let (stream, _) = listener.accept().await.unwrap();
        tokio_tungstenite::accept_async(stream).await.unwrap()
    }

    async fn send(socket: &mut ServerSocket, payload: Value) -> bool {
        socket
            .send(Message::from(payload.to_string()))
            .await
            .is_ok()
    }

    async fn read_frame(socket: &mut ServerSocket) -> Option<Value> {
        loop {
            match socket.next().await? {
                Ok(Message::Text(text)) => {
                    return Some(serde_json::from_str(text.as_str()).unwrap())
                }
                Ok(Message::Close(_)) | Err(_) => return None,
                Ok(_) => {}
            }
        }
    }

    async fn handshake(socket: &mut ServerSocket) -> Value {
        send(
            socket,
            json!({ "op": 10, "d": { "heartbeat_interval": 600_000 } }),
        )
        .await;
        let identify = read_frame(socket).await.unwrap();
        send(
            socket,
            json!({ "op": 0, "t": "READY", "s": 1, "d": { "session_id": "abc" } }),
        )
        .await;
        identify
    }

    async fn drain(socket: &mut ServerSocket) {
        while let Some(frame) = read_frame(socket).await {
            if frame["op"] == 1 && !send(socket, json!({ "op": 11 })).await {
                return;
            }
        }
    }

    fn click(interaction_id: &str, custom_id: &str) -> Value {
        json!({
            "op": 0,
            "t": "INTERACTION_CREATE",
            "s": 2,
            "d": {
                "id": interaction_id,
                "token": INTERACTION_TOKEN,
                "type": 3,
                "user": { "id": OWNER },
                "data": { "custom_id": custom_id },
                "message": { "id": "d-1", "components": [] }
            }
        })
    }

    fn serve_clicks(
        listener: TcpListener,
        mut clicks: mpsc::UnboundedReceiver<Value>,
    ) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut socket = accept(&listener).await;
            handshake(&mut socket).await;
            while let Some(frame) = clicks.recv().await {
                if !send(&mut socket, frame).await {
                    return;
                }
            }
            drain(&mut socket).await;
        })
    }

    fn approval_row(approval: &crate::domain::supervisor::ApprovalView) -> PostApproval {
        PostApproval {
            approval_id: approval.id.clone(),
            action: approval.action.clone(),
            code: approval.code.clone(),
        }
    }

    async fn connected(status: &mut watch::Receiver<GatewayStatus>) {
        status
            .wait_for(|value| *value == GatewayStatus::Connected)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn post_job_posts_rendered_messages_and_returns_keys() {
        timeout(TEST_TIMEOUT, async {
            let Harness { server, handle, .. } = harness(Ok(config_with(BOT_TOKEN))).await;
            Mock::given(method("POST"))
                .and(path(MESSAGES_PATH))
                .and(header("Authorization", "Bot bot-token"))
                .respond_with(posted_reply("d-1"))
                .expect(1)
                .mount(&server)
                .await;
            let request = block(vec![item("q1", &["tak", "nie"])], vec![]);
            let result = post(&handle, request.clone()).await.unwrap();
            assert_eq!(
                result,
                PostResult {
                    posted: 1,
                    keys: vec![PostedKey {
                        question_id: "q1".into(),
                        question: "Pytanie q1?".into(),
                        key: "P1".into(),
                    }],
                    skipped: vec![],
                }
            );
            let posted = requests(&server, "POST", MESSAGES_PATH).await;
            assert_eq!(posted.len(), 1);
            let payload = body(&posted[0]);
            assert_eq!(payload["flags"], 32768);
            assert_eq!(payload["allowed_mentions"], json!({ "parse": [] }));
            assert!(payload.get("content").is_none());
            assert!(strings(&payload, "content")
                .iter()
                .any(|text| text.contains("Pytanie q1?")));
            let custom_ids = strings(&payload, "custom_id");
            assert_eq!(custom_ids.len(), 2);
            assert!(custom_ids.iter().all(|id| id.starts_with("abeon:q:")));

            let again = post(&handle, request).await.unwrap();
            assert_eq!(again.posted, 0);
            assert_eq!(again.skipped, vec!["q1".to_string()]);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_rate_limited_post_is_retried_once() {
        timeout(TEST_TIMEOUT, async {
            let Harness { server, handle, .. } = harness(Ok(config_with(BOT_TOKEN))).await;
            rate_limit_once(&server, "POST", MESSAGES_PATH, 0.05).await;
            respond_to_posts(&server, "d-1").await;
            let result = post(&handle, block(vec![item("q1", &["tak"])], vec![]))
                .await
                .unwrap();
            assert_eq!(result.posted, 1);
            assert_eq!(requests(&server, "POST", MESSAGES_PATH).await.len(), 2);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn failed_post_discards_items_so_they_can_be_posted_again() {
        timeout(TEST_TIMEOUT, async {
            let Harness { server, handle, .. } = harness(Ok(config_with(BOT_TOKEN))).await;
            Mock::given(method("POST"))
                .and(path(MESSAGES_PATH))
                .respond_with(posted_reply("d-1"))
                .up_to_n_times(1)
                .with_priority(1)
                .mount(&server)
                .await;
            Mock::given(method("POST"))
                .and(path(MESSAGES_PATH))
                .respond_with(ResponseTemplate::new(500))
                .with_priority(2)
                .mount(&server)
                .await;
            let items: Vec<PostItem> = (0..12)
                .map(|index| item(&format!("q{index}"), &["a", "b", "c", "d", "e"]))
                .collect();
            let request = block(items, vec![]);
            assert_eq!(
                post(&handle, request.clone()).await,
                Err("Discord zwrócił błąd HTTP 500".to_string())
            );
            assert_eq!(requests(&server, "POST", MESSAGES_PATH).await.len(), 2);

            Mock::given(method("POST"))
                .and(path(MESSAGES_PATH))
                .respond_with(posted_reply("d-2"))
                .with_priority(1)
                .mount(&server)
                .await;
            let again = post(&handle, request).await.unwrap();
            assert!(again.posted >= 1);
            assert!(!again.skipped.is_empty());
            assert!(!again.keys.is_empty());
            assert_eq!(again.skipped.len() + again.keys.len(), 12);
            let mut questions: Vec<String> = again
                .keys
                .iter()
                .map(|posted| posted.question_id.clone())
                .chain(again.skipped.iter().cloned())
                .collect();
            questions.sort();
            questions.dedup();
            assert_eq!(questions.len(), 12);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn sync_job_patches_the_changed_message() {
        timeout(TEST_TIMEOUT, async {
            let Harness { server, handle, .. } = harness(Ok(config_with(BOT_TOKEN))).await;
            respond_to_posts(&server, "d-1").await;
            respond_to_edits(&server, "d-1").await;
            let request = block(
                vec![item("q1", &["tak", "nie"])],
                vec![PostApproval {
                    approval_id: "ap1".into(),
                    action: "task release".into(),
                    code: "K7QX".into(),
                }],
            );
            assert_eq!(post(&handle, request).await.unwrap().posted, 1);

            handle.sync(DiscordSync::ApprovalSettled {
                approval_id: "ap1".into(),
                state: ApprovalState::Pending,
            });
            handle.sync(DiscordSync::QuestionSettled {
                question_id: "q1".into(),
            });
            handle.sync(DiscordSync::QuestionSettled {
                question_id: "q1".into(),
            });
            handle.sync(DiscordSync::ApprovalSettled {
                approval_id: "ap1".into(),
                state: ApprovalState::Rejected,
            });
            let edits = wait_for_requests(&server, "PATCH", &message_path("d-1"), 2).await;
            let settled = body(&edits[0]);
            assert_eq!(settled["flags"], 32768);
            assert!(strings(&settled, "content").contains(&"✅ P1: rozstrzygnięte".to_string()));
            assert!(!strings(&settled, "custom_id")
                .iter()
                .any(|id| id.starts_with("abeon:q:")));
            assert!(strings(&settled, "custom_id").contains(&"abeon:a:ap1:y".to_string()));
            let rejected = body(&edits[1]);
            assert!(strings(&rejected, "content").contains(&"❌ Odrzucono".to_string()));
            assert!(strings(&rejected, "custom_id").is_empty());

            sleep(SILENCE).await;
            assert_eq!(
                requests(&server, "PATCH", &message_path("d-1")).await.len(),
                2
            );
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn answered_job_patches_and_returns_skipped() {
        timeout(TEST_TIMEOUT, async {
            let Harness { server, handle, .. } = harness(Ok(config_with(BOT_TOKEN))).await;
            respond_to_posts(&server, "d-1").await;
            respond_to_edits(&server, "d-1").await;
            assert_eq!(
                post(&handle, block(vec![item("q1", &["tak", "nie"])], vec![]))
                    .await
                    .unwrap()
                    .posted,
                1
            );
            let skipped = answered(
                &handle,
                vec![key_answer("p1", "tak"), key_answer("P9", "nie")],
            )
            .await
            .unwrap();
            assert_eq!(skipped, vec!["P9".to_string()]);
            let edits = requests(&server, "PATCH", &message_path("d-1")).await;
            assert_eq!(edits.len(), 1);
            let payload = body(&edits[0]);
            assert!(strings(&payload, "content").contains(&"✅ P1: tak".to_string()));
            assert!(strings(&payload, "custom_id").is_empty());

            assert_eq!(
                answered(&handle, vec![key_answer("P1", "nie")]).await,
                Ok(vec!["P1".to_string()])
            );
            assert_eq!(
                requests(&server, "PATCH", &message_path("d-1")).await.len(),
                1
            );
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn gateway_click_resolves_an_approval_end_to_end() {
        timeout(TEST_TIMEOUT, async {
            let Harness {
                server,
                listener,
                handle,
                mut status,
                core,
                ..
            } = harness(Ok(config_with(BOT_TOKEN))).await;
            core.on_session_hook(bash("s1", "git push origin main"))
                .await;
            let approval = core.snapshot().approvals.into_iter().next().unwrap();
            respond_to_posts(&server, "d-1").await;
            respond_to_callback(&server, "i-1", ResponseTemplate::new(204)).await;
            let (clicks, pending_clicks) = mpsc::unbounded_channel();
            let gateway = serve_clicks(listener, pending_clicks);
            connected(&mut status).await;

            let request = block(vec![], vec![approval_row(&approval)]);
            assert_eq!(post(&handle, request).await.unwrap().posted, 1);
            clicks
                .send(click("i-1", &format!("abeon:a:{}:y", approval.id)))
                .unwrap();

            let callbacks = wait_for_requests(&server, "POST", &callback_path("i-1"), 1).await;
            assert!(callbacks[0].headers.get("authorization").is_none());
            let payload = body(&callbacks[0]);
            assert_eq!(payload["type"], 7);
            assert_eq!(payload["data"]["flags"], 32768);
            assert!(strings(&payload, "content").contains(&"✅ Zatwierdzono".to_string()));
            assert!(strings(&payload, "custom_id").is_empty());
            assert_eq!(
                core.approval_status(&approval.id).unwrap().status,
                ApprovalState::Approved
            );
            assert_eq!(*status.borrow(), GatewayStatus::Connected);
            gateway.abort();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn gateway_option_click_records_the_answer_after_the_callback() {
        timeout(TEST_TIMEOUT, async {
            let Harness {
                server,
                listener,
                handle,
                mut status,
                core,
                ..
            } = harness(Ok(config_with(BOT_TOKEN))).await;
            respond_to_posts(&server, "d-1").await;
            respond_to_callback(
                &server,
                "i-2",
                ResponseTemplate::new(204).set_delay(CALLBACK_DELAY),
            )
            .await;
            let (clicks, pending_clicks) = mpsc::unbounded_channel();
            let gateway = serve_clicks(listener, pending_clicks);
            connected(&mut status).await;

            let request = block(vec![item("q1", &["tak", "nie"])], vec![]);
            assert_eq!(post(&handle, request).await.unwrap().posted, 1);
            let posted = requests(&server, "POST", MESSAGES_PATH).await;
            let custom_id = strings(&body(&posted[0]), "custom_id")
                .into_iter()
                .find(|id| id.ends_with(":0"))
                .unwrap();
            clicks.send(click("i-2", &custom_id)).unwrap();

            let callbacks = wait_for_requests(&server, "POST", &callback_path("i-2"), 1).await;
            assert_eq!(take_discord_answer(&core), None);
            let payload = body(&callbacks[0]);
            assert_eq!(payload["type"], 7);
            assert!(strings(&payload, "content").contains(&"✅ P1: tak".to_string()));
            let answer = loop {
                if let Some(answer) = take_discord_answer(&core) {
                    break answer;
                }
                sleep(POLL_STEP).await;
            };
            assert_eq!(
                answer,
                ("q1".to_string(), "P1".to_string(), "tak".to_string())
            );
            gateway.abort();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_rejected_interaction_callback_keeps_the_gateway_connected() {
        timeout(TEST_TIMEOUT, async {
            let Harness {
                server,
                listener,
                handle,
                mut status,
                ..
            } = harness(Ok(config_with(BOT_TOKEN))).await;
            respond_to_posts(&server, "d-1").await;
            respond_to_callback(&server, "i-1", ResponseTemplate::new(401)).await;
            respond_to_callback(&server, "i-2", ResponseTemplate::new(401)).await;
            let (clicks, pending_clicks) = mpsc::unbounded_channel();
            let gateway = serve_clicks(listener, pending_clicks);
            connected(&mut status).await;

            let request = block(vec![item("q1", &["tak", "nie"])], vec![]);
            assert_eq!(post(&handle, request).await.unwrap().posted, 1);
            let posted = requests(&server, "POST", MESSAGES_PATH).await;
            let custom_ids = strings(&body(&posted[0]), "custom_id");
            clicks.send(click("i-1", &custom_ids[0])).unwrap();
            wait_for_requests(&server, "POST", &callback_path("i-1"), 1).await;
            sleep(SILENCE).await;
            assert_eq!(*status.borrow(), GatewayStatus::Connected);

            clicks.send(click("i-2", &custom_ids[1])).unwrap();
            wait_for_requests(&server, "POST", &callback_path("i-2"), 1).await;
            assert_eq!(*status.borrow(), GatewayStatus::Connected);
            assert!(!gateway.is_finished());
            gateway.abort();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_click_during_a_rate_limited_patch_is_not_overwritten() {
        timeout(TEST_TIMEOUT, async {
            let Harness {
                server,
                listener,
                handle,
                mut status,
                core,
                ..
            } = harness(Ok(config_with(BOT_TOKEN))).await;
            core.on_session_hook(bash("s1", "git push origin main"))
                .await;
            let approval = core.snapshot().approvals.into_iter().next().unwrap();
            let approve = format!("abeon:a:{}:y", approval.id);
            respond_to_posts(&server, "d-1").await;
            respond_to_callback(&server, "i-1", ResponseTemplate::new(204)).await;
            rate_limit_once(&server, "PATCH", &message_path("d-1"), 1.0).await;
            respond_to_edits(&server, "d-1").await;
            let (clicks, pending_clicks) = mpsc::unbounded_channel();
            let gateway = serve_clicks(listener, pending_clicks);
            connected(&mut status).await;

            let request = block(
                vec![item("q1", &["tak", "nie"])],
                vec![approval_row(&approval)],
            );
            assert_eq!(post(&handle, request).await.unwrap().posted, 1);
            handle.sync(DiscordSync::QuestionSettled {
                question_id: "q1".into(),
            });
            let limited = wait_for_requests(&server, "PATCH", &message_path("d-1"), 1).await;
            assert!(strings(&body(&limited[0]), "custom_id").contains(&approve));

            clicks.send(click("i-1", &approve)).unwrap();
            let callbacks = wait_for_requests(&server, "POST", &callback_path("i-1"), 1).await;
            let current = body(&callbacks[0])["data"].clone();
            assert!(strings(&current, "content").contains(&"✅ Zatwierdzono".to_string()));
            assert!(strings(&current, "content").contains(&"✅ P1: rozstrzygnięte".to_string()));

            loop {
                let edits = requests(&server, "PATCH", &message_path("d-1")).await;
                if edits.len() >= 2 && body(edits.last().unwrap()) == current {
                    break;
                }
                sleep(POLL_STEP).await;
            }
            sleep(SILENCE).await;
            let edits = requests(&server, "PATCH", &message_path("d-1")).await;
            let last = body(edits.last().unwrap());
            assert_eq!(last, current);
            assert!(!strings(&last, "custom_id").contains(&approve));
            gateway.abort();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_sync_while_unconfigured_is_patched_once_configured() {
        timeout(TEST_TIMEOUT, async {
            let Harness {
                server,
                config,
                handle,
                mut status,
                ..
            } = harness(Ok(config_with(BOT_TOKEN))).await;
            respond_to_posts(&server, "d-1").await;
            respond_to_edits(&server, "d-1").await;
            let request = block(vec![item("q1", &["tak", "nie"])], vec![]);
            assert_eq!(post(&handle, request).await.unwrap().posted, 1);

            *config.lock() = Err("Discord wyłączony".into());
            handle.reconfigure();
            status
                .wait_for(|value| *value == GatewayStatus::Off("Discord wyłączony".into()))
                .await
                .unwrap();
            handle.sync(DiscordSync::QuestionSettled {
                question_id: "q1".into(),
            });
            sleep(SILENCE).await;
            assert!(requests(&server, "PATCH", &message_path("d-1"))
                .await
                .is_empty());

            *config.lock() = Ok(config_with(BOT_TOKEN));
            handle.reconfigure();
            let edits = wait_for_requests(&server, "PATCH", &message_path("d-1"), 1).await;
            assert!(
                strings(&body(&edits[0]), "content").contains(&"✅ P1: rozstrzygnięte".to_string())
            );
            assert!(strings(&body(&edits[0]), "custom_id").is_empty());

            handle.reconfigure();
            sleep(SILENCE).await;
            assert_eq!(
                requests(&server, "PATCH", &message_path("d-1")).await.len(),
                1
            );
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_post_that_outlasts_its_deadline_is_discarded() {
        timeout(TEST_TIMEOUT, async {
            let server = MockServer::start().await;
            Mock::given(method("POST"))
                .and(path(MESSAGES_PATH))
                .respond_with(posted_reply("d-1").set_delay(Duration::from_secs(5)))
                .mount(&server)
                .await;
            let (_, core) = setup();
            let shared = shared_for(core);
            let live = live_for(&server);
            let request = block(vec![item("q1", &["tak"])], vec![]);

            let started = Instant::now();
            assert_eq!(
                super::post(&shared, &live, request.clone(), started + SILENCE).await,
                Err(ERROR_BUTTONS_OFFLINE.to_string())
            );
            assert!(started.elapsed() < Duration::from_secs(2));
            assert_eq!(requests(&server, "POST", MESSAGES_PATH).await.len(), 1);

            assert_eq!(
                super::post(&shared, &live, request.clone(), Instant::now()).await,
                Err(ERROR_BUTTONS_OFFLINE.to_string())
            );
            assert_eq!(requests(&server, "POST", MESSAGES_PATH).await.len(), 1);

            let planned = shared.registry.lock().plan_post(request);
            assert!(planned.result.skipped.is_empty());
            assert_eq!(planned.messages.len(), 1);
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_rate_limit_wait_does_not_outlast_the_post_deadline() {
        timeout(TEST_TIMEOUT, async {
            let server = MockServer::start().await;
            rate_limit_once(&server, "POST", MESSAGES_PATH, 3.0).await;
            respond_to_posts(&server, "d-1").await;
            let (_, core) = setup();
            let shared = shared_for(core);
            let live = live_for(&server);
            let request = block(vec![item("q1", &["tak"])], vec![]);

            let started = Instant::now();
            assert_eq!(
                super::post(&shared, &live, request.clone(), started + SILENCE).await,
                Err(ERROR_BUTTONS_OFFLINE.to_string())
            );
            assert!(started.elapsed() < Duration::from_secs(2));
            assert_eq!(requests(&server, "POST", MESSAGES_PATH).await.len(), 1);
            let planned = shared.registry.lock().plan_post(request);
            assert!(planned.result.skipped.is_empty());
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn config_error_keeps_the_gateway_off() {
        timeout(TEST_TIMEOUT, async {
            let Harness {
                listener,
                handle,
                mut status,
                ..
            } = harness(Err(NO_TOKEN.into())).await;
            status
                .wait_for(|value| *value == GatewayStatus::Off(NO_TOKEN.into()))
                .await
                .unwrap();
            handle.reconfigure();
            assert_eq!(
                post(&handle, block(vec![item("q1", &["tak"])], vec![])).await,
                Err(NO_TOKEN.to_string())
            );
            assert!(!status.has_changed().unwrap());
            assert_eq!(
                answered(&handle, vec![key_answer("P1", "tak")]).await,
                Err(NO_TOKEN.to_string())
            );
            assert!(timeout(SILENCE, listener.accept()).await.is_err());
            assert_eq!(*status.borrow(), GatewayStatus::Off(NO_TOKEN.into()));
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_config_error_closes_the_running_gateway() {
        timeout(TEST_TIMEOUT, async {
            let Harness {
                listener,
                config,
                handle,
                mut status,
                ..
            } = harness(Ok(config_with(BOT_TOKEN))).await;
            let mut socket = accept(&listener).await;
            handshake(&mut socket).await;
            connected(&mut status).await;
            *config.lock() = Err("Discord wyłączony".into());
            handle.reconfigure();
            drain(&mut socket).await;
            status
                .wait_for(|value| *value == GatewayStatus::Off("Discord wyłączony".into()))
                .await
                .unwrap();
            assert!(timeout(SILENCE, listener.accept()).await.is_err());
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn reconfigure_with_a_new_token_reconnects() {
        timeout(TEST_TIMEOUT, async {
            let Harness {
                listener,
                config,
                handle,
                mut status,
                ..
            } = harness(Ok(config_with("first-token"))).await;
            let mut first = accept(&listener).await;
            let identify = handshake(&mut first).await;
            assert_eq!(identify["op"], 2);
            assert_eq!(identify["d"]["token"], "first-token");
            connected(&mut status).await;

            handle.reconfigure();
            assert!(timeout(SILENCE, listener.accept()).await.is_err());

            *config.lock() = Ok(config_with("second-token"));
            handle.reconfigure();
            drain(&mut first).await;
            let mut second = accept(&listener).await;
            let identify = handshake(&mut second).await;
            assert_eq!(identify["op"], 2);
            assert_eq!(identify["d"]["token"], "second-token");
            connected(&mut status).await;
        })
        .await
        .unwrap();
    }

    #[test]
    fn debug_output_redacts_the_bot_token() {
        let rendered = format!("{:?}", config_with("secret-bot-token"));
        assert!(!rendered.contains("secret-bot-token"));
        assert!(rendered.contains("<redacted>"));
        assert!(rendered.contains(CHAT));
    }
}

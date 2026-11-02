use std::fmt;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};
use tokio::time::{sleep, sleep_until, timeout, Instant};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

use super::BUTTON_PREFIX;

pub const GATEWAY_URL: &str = "wss://gateway.discord.gg/?v=10&encoding=json";

const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(60);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const DEFAULT_HEARTBEAT_MS: u64 = 41_250;
const COMPONENT_INTERACTION_TYPE: u64 = 3;

#[derive(Clone, PartialEq)]
pub struct Interaction {
    pub id: String,
    pub token: String,
    pub user_id: String,
    pub custom_id: String,
    pub message_id: String,
    pub message_components: Value,
}

impl fmt::Debug for Interaction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Interaction")
            .field("id", &self.id)
            .field("token", &"<redacted>")
            .field("user_id", &self.user_id)
            .field("custom_id", &self.custom_id)
            .field("message_id", &self.message_id)
            .field("message_components", &self.message_components)
            .finish()
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum GatewayStatus {
    Off(String),
    Connecting,
    Connected,
    Failed(String),
}

enum Outcome {
    Stop,
    Fatal(String),
    ReconnectNow,
    ReconnectAfter(Duration),
    Backoff,
}

type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

static CRYPTO_INIT: std::sync::Once = std::sync::Once::new();

fn ensure_crypto_provider() {
    CRYPTO_INIT.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn jitter() -> f64 {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let value = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
    f64::from(value) / (f64::from(u32::MAX) + 1.0)
}

async fn stopped(stop: &mut watch::Receiver<bool>) {
    let _ = stop.wait_for(|value| *value).await;
}

async fn sleep_or_stop(duration: Duration, stop: &mut watch::Receiver<bool>) -> bool {
    tokio::select! {
        _ = stopped(stop) => false,
        _ = sleep(duration) => true,
    }
}

fn invalid_session_delay(jitter: f64) -> Duration {
    Duration::from_millis(1000) + Duration::from_millis(4000).mul_f64(jitter)
}

fn next_backoff(current: Duration) -> Duration {
    (current * 2).min(BACKOFF_MAX)
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    current.as_str().map(str::to_string)
}

fn parse_interaction(data: &Value) -> Option<Interaction> {
    if data.get("type").and_then(Value::as_u64) != Some(COMPONENT_INTERACTION_TYPE) {
        return None;
    }
    let custom_id = string_at(data, &["data", "custom_id"])
        .filter(|custom_id| custom_id.starts_with(BUTTON_PREFIX))?;
    let user_id =
        string_at(data, &["user", "id"]).or_else(|| string_at(data, &["member", "user", "id"]))?;
    Some(Interaction {
        id: string_at(data, &["id"])?,
        token: string_at(data, &["token"])?,
        user_id,
        custom_id,
        message_id: string_at(data, &["message", "id"])?,
        message_components: data
            .get("message")
            .and_then(|message| message.get("components"))
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    })
}

async fn send_json(socket: &mut Socket, payload: Value) -> bool {
    socket
        .send(Message::from(payload.to_string()))
        .await
        .is_ok()
}

async fn send_heartbeat(socket: &mut Socket, sequence: Option<i64>) -> bool {
    send_json(socket, json!({ "op": 1, "d": sequence })).await
}

async fn send_identify(socket: &mut Socket, token: &str) -> bool {
    send_json(
        socket,
        json!({
            "op": 2,
            "d": {
                "token": token,
                "intents": 0,
                "properties": {
                    "os": std::env::consts::OS,
                    "browser": "abeoncode",
                    "device": "abeoncode",
                },
            },
        }),
    )
    .await
}

fn classify_close(code: Option<u16>) -> Outcome {
    match code {
        Some(4004) => Outcome::Fatal("Discord odrzucił token bota".to_string()),
        Some(code @ 4010..=4014) => {
            Outcome::Fatal(format!("Discord odrzucił połączenie bramki (kod {code})"))
        }
        _ => Outcome::Backoff,
    }
}

async fn run_session(
    socket: &mut Socket,
    token: &str,
    interactions: &mpsc::UnboundedSender<Interaction>,
    status: &watch::Sender<GatewayStatus>,
    stop: &mut watch::Receiver<bool>,
    became_ready: &mut bool,
) -> Outcome {
    let mut sequence: Option<i64> = None;
    let mut interval = Duration::from_millis(DEFAULT_HEARTBEAT_MS);
    let mut heartbeat_at: Option<Instant> = None;
    let mut ack_received = true;
    let mut identified = false;
    let hello_deadline = Instant::now() + HANDSHAKE_TIMEOUT;

    loop {
        let due = heartbeat_at.unwrap_or_else(|| Instant::now() + Duration::from_secs(3600));
        let step: Option<Outcome> = tokio::select! {
            biased;
            message = socket.next() => match message {
                None | Some(Err(_)) => Some(Outcome::Backoff),
                Some(Ok(Message::Close(frame))) => {
                    Some(classify_close(frame.map(|frame| u16::from(frame.code))))
                }
                Some(Ok(Message::Text(text))) => {
                    match serde_json::from_str::<Value>(text.as_str()) {
                        Err(_) => None,
                        Ok(frame) => {
                            let op = frame.get("op").and_then(Value::as_u64);
                            let data = frame.get("d").cloned().unwrap_or(Value::Null);
                            match op {
                                Some(10) if !identified => {
                                    let millis = data
                                        .get("heartbeat_interval")
                                        .and_then(Value::as_u64)
                                        .unwrap_or(DEFAULT_HEARTBEAT_MS)
                                        .max(1);
                                    interval = Duration::from_millis(millis);
                                    heartbeat_at =
                                        Some(Instant::now() + interval.mul_f64(jitter()));
                                    identified = true;
                                    if send_identify(socket, token).await {
                                        None
                                    } else {
                                        Some(Outcome::Backoff)
                                    }
                                }
                                Some(11) => {
                                    ack_received = true;
                                    None
                                }
                                Some(1) => {
                                    if send_heartbeat(socket, sequence).await {
                                        ack_received = false;
                                        None
                                    } else {
                                        Some(Outcome::Backoff)
                                    }
                                }
                                Some(7) => Some(Outcome::ReconnectNow),
                                Some(9) => Some(Outcome::ReconnectAfter(
                                    invalid_session_delay(jitter()),
                                )),
                                Some(0) => {
                                    if let Some(value) = frame.get("s").and_then(Value::as_i64) {
                                        sequence = Some(value);
                                    }
                                    match frame.get("t").and_then(Value::as_str) {
                                        Some("READY") => {
                                            *became_ready = true;
                                            let _ = status.send(GatewayStatus::Connected);
                                        }
                                        Some("INTERACTION_CREATE") => {
                                            if let Some(interaction) = parse_interaction(&data) {
                                                let _ = interactions.send(interaction);
                                            }
                                        }
                                        _ => {}
                                    }
                                    None
                                }
                                _ => None,
                            }
                        }
                    }
                }
                Some(Ok(_)) => None,
            },
            _ = stopped(stop) => Some(Outcome::Stop),
            _ = sleep_until(hello_deadline), if !identified => Some(Outcome::Backoff),
            _ = sleep_until(due), if heartbeat_at.is_some() => {
                if !ack_received {
                    Some(Outcome::ReconnectNow)
                } else if !send_heartbeat(socket, sequence).await {
                    Some(Outcome::Backoff)
                } else {
                    ack_received = false;
                    heartbeat_at = Some(Instant::now() + interval);
                    None
                }
            }
        };
        if let Some(outcome) = step {
            return outcome;
        }
    }
}

pub async fn run_gateway(
    url: String,
    token: String,
    interactions: mpsc::UnboundedSender<Interaction>,
    status: watch::Sender<GatewayStatus>,
    mut stop: watch::Receiver<bool>,
) {
    ensure_crypto_provider();
    let mut backoff = BACKOFF_START;

    loop {
        if *stop.borrow() {
            return;
        }
        let _ = status.send(GatewayStatus::Connecting);

        let connected = tokio::select! {
            _ = stopped(&mut stop) => return,
            result = timeout(HANDSHAKE_TIMEOUT, tokio_tungstenite::connect_async(url.as_str())) => result,
        };
        let mut socket = match connected {
            Ok(Ok((socket, _))) => socket,
            Ok(Err(_)) | Err(_) => {
                if !sleep_or_stop(backoff, &mut stop).await {
                    return;
                }
                backoff = next_backoff(backoff);
                continue;
            }
        };

        let mut became_ready = false;
        let outcome = run_session(
            &mut socket,
            &token,
            &interactions,
            &status,
            &mut stop,
            &mut became_ready,
        )
        .await;
        let _ = timeout(CLOSE_TIMEOUT, socket.close(None)).await;
        if became_ready {
            backoff = BACKOFF_START;
        }

        match outcome {
            Outcome::Stop => return,
            Outcome::Fatal(message) => {
                let _ = status.send(GatewayStatus::Failed(message));
                return;
            }
            Outcome::ReconnectNow => {}
            Outcome::ReconnectAfter(delay) => {
                let _ = status.send(GatewayStatus::Connecting);
                if !sleep_or_stop(delay, &mut stop).await {
                    return;
                }
            }
            Outcome::Backoff => {
                let _ = status.send(GatewayStatus::Connecting);
                if !sleep_or_stop(backoff, &mut stop).await {
                    return;
                }
                backoff = next_backoff(backoff);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;

    type ServerSocket = WebSocketStream<TcpStream>;

    const TEST_TIMEOUT: Duration = Duration::from_secs(5);

    async fn bind() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://127.0.0.1:{}/", listener.local_addr().unwrap().port());
        (listener, url)
    }

    async fn accept(listener: &TcpListener) -> ServerSocket {
        let (stream, _) = listener.accept().await.unwrap();
        tokio_tungstenite::accept_async(stream).await.unwrap()
    }

    async fn send(socket: &mut ServerSocket, payload: Value) {
        socket
            .send(Message::from(payload.to_string()))
            .await
            .unwrap();
    }

    async fn send_hello(socket: &mut ServerSocket, interval_ms: u64) {
        send(
            socket,
            json!({ "op": 10, "d": { "heartbeat_interval": interval_ms } }),
        )
        .await;
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

    async fn read_non_heartbeat(socket: &mut ServerSocket) -> Option<Value> {
        loop {
            let frame = read_frame(socket).await?;
            if frame["op"] == 1 {
                send(socket, json!({ "op": 11 })).await;
                continue;
            }
            return Some(frame);
        }
    }

    async fn drain(socket: &mut ServerSocket) {
        while read_non_heartbeat(socket).await.is_some() {}
    }

    async fn send_ready(socket: &mut ServerSocket) {
        send(
            socket,
            json!({ "op": 0, "t": "READY", "s": 1, "d": { "session_id": "abc" } }),
        )
        .await;
    }

    struct Harness {
        interactions: mpsc::UnboundedReceiver<Interaction>,
        status: watch::Receiver<GatewayStatus>,
        stop: watch::Sender<bool>,
        task: tokio::task::JoinHandle<()>,
    }

    fn start_client(url: String) -> Harness {
        let (interaction_tx, interactions) = mpsc::unbounded_channel();
        let (status_tx, status) = watch::channel(GatewayStatus::Off("test".to_string()));
        let (stop, stop_rx) = watch::channel(false);
        let task = tokio::spawn(run_gateway(
            url,
            "bot-token".to_string(),
            interaction_tx,
            status_tx,
            stop_rx,
        ));
        Harness {
            interactions,
            status,
            stop,
            task,
        }
    }

    impl Harness {
        async fn shutdown(self) {
            self.stop.send(true).unwrap();
            timeout(TEST_TIMEOUT, self.task).await.unwrap().unwrap();
        }
    }

    fn component_interaction(kind: u64) -> Value {
        json!({
            "op": 0,
            "t": "INTERACTION_CREATE",
            "s": 2,
            "d": {
                "id": "int-1",
                "token": "int-token",
                "type": kind,
                "user": { "id": "user-1" },
                "data": { "custom_id": "abeon:q:item-1:2" },
                "message": { "id": "msg-1", "components": [{ "type": 17 }] }
            }
        })
    }

    #[tokio::test]
    async fn identifies_with_zero_intents_after_hello() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let harness = start_client(url);
            let mut socket = accept(&listener).await;
            send_hello(&mut socket, 50).await;
            let identify = read_non_heartbeat(&mut socket).await.unwrap();
            assert_eq!(identify["op"], 2);
            assert_eq!(identify["d"]["token"], "bot-token");
            assert_eq!(identify["d"]["intents"], 0);
            assert_eq!(identify["d"]["properties"]["browser"], "abeoncode");
            assert_eq!(identify["d"]["properties"]["device"], "abeoncode");
            assert_eq!(identify["d"]["properties"]["os"], std::env::consts::OS);
            send_ready(&mut socket).await;
            let mut status = harness.status.clone();
            status
                .wait_for(|value| *value == GatewayStatus::Connected)
                .await
                .unwrap();
            harness.shutdown().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn forwards_component_interactions() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let mut harness = start_client(url);
            let server = tokio::spawn(async move {
                let mut socket = accept(&listener).await;
                send_hello(&mut socket, 50).await;
                read_non_heartbeat(&mut socket).await.unwrap();
                send_ready(&mut socket).await;
                send(&mut socket, component_interaction(3)).await;
                drain(&mut socket).await;
            });
            let interaction = harness.interactions.recv().await.unwrap();
            assert_eq!(interaction.id, "int-1");
            assert_eq!(interaction.token, "int-token");
            assert_eq!(interaction.user_id, "user-1");
            assert_eq!(interaction.custom_id, "abeon:q:item-1:2");
            assert_eq!(interaction.message_id, "msg-1");
            assert_eq!(interaction.message_components, json!([{ "type": 17 }]));
            harness.shutdown().await;
            server.abort();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn reads_user_from_member_when_absent_at_top_level() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let mut harness = start_client(url);
            let server = tokio::spawn(async move {
                let mut socket = accept(&listener).await;
                send_hello(&mut socket, 50).await;
                read_non_heartbeat(&mut socket).await.unwrap();
                let mut payload = component_interaction(3);
                payload["d"]["member"] = json!({ "user": { "id": "member-1" } });
                payload["d"].as_object_mut().unwrap().remove("user");
                send(&mut socket, payload).await;
                drain(&mut socket).await;
            });
            let interaction = harness.interactions.recv().await.unwrap();
            assert_eq!(interaction.user_id, "member-1");
            harness.shutdown().await;
            server.abort();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn ignores_non_component_interactions() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let mut harness = start_client(url);
            let server = tokio::spawn(async move {
                let mut socket = accept(&listener).await;
                send_hello(&mut socket, 50).await;
                read_non_heartbeat(&mut socket).await.unwrap();
                send_ready(&mut socket).await;
                send(&mut socket, component_interaction(2)).await;
                drain(&mut socket).await;
            });
            let received = timeout(Duration::from_millis(200), harness.interactions.recv()).await;
            assert!(received.is_err());
            harness.shutdown().await;
            server.abort();
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn ignores_buttons_of_other_components() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let mut harness = start_client(url);
            let mut socket = accept(&listener).await;
            send_hello(&mut socket, 600_000).await;
            read_non_heartbeat(&mut socket).await.unwrap();
            send_ready(&mut socket).await;
            let mut foreign = component_interaction(3);
            foreign["d"]["data"]["custom_id"] = json!("perm:allow:abcde");
            send(&mut socket, foreign).await;
            let received = timeout(Duration::from_millis(200), harness.interactions.recv()).await;
            assert!(received.is_err());
            send(&mut socket, component_interaction(3)).await;
            let interaction = harness.interactions.recv().await.unwrap();
            assert_eq!(interaction.custom_id, "abeon:q:item-1:2");
            harness.shutdown().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn answers_heartbeat_requests_immediately() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let harness = start_client(url);
            let mut socket = accept(&listener).await;
            send_hello(&mut socket, 600_000).await;
            read_non_heartbeat(&mut socket).await.unwrap();
            send_ready(&mut socket).await;
            send(&mut socket, json!({ "op": 1, "d": null })).await;
            let heartbeat = timeout(Duration::from_secs(2), read_frame(&mut socket))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(heartbeat, json!({ "op": 1, "d": 1 }));
            harness.shutdown().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn sends_periodic_heartbeats_with_last_sequence() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let harness = start_client(url);
            let mut socket = accept(&listener).await;
            send_hello(&mut socket, 50).await;
            read_non_heartbeat(&mut socket).await.unwrap();
            send_ready(&mut socket).await;
            let heartbeat = loop {
                let frame = read_frame(&mut socket).await.unwrap();
                assert_eq!(frame["op"], 1);
                send(&mut socket, json!({ "op": 11 })).await;
                if frame["d"] == 1 {
                    break frame;
                }
            };
            assert_eq!(heartbeat["d"], 1);
            harness.shutdown().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn reconnects_when_heartbeat_is_not_acknowledged() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let harness = start_client(url);
            let mut first = accept(&listener).await;
            send_hello(&mut first, 50).await;
            let mut identifies = 0;
            while let Some(frame) = read_frame(&mut first).await {
                if frame["op"] == 2 {
                    identifies += 1;
                }
            }
            assert_eq!(identifies, 1);
            let mut second = accept(&listener).await;
            send_hello(&mut second, 600_000).await;
            let identify = read_non_heartbeat(&mut second).await.unwrap();
            assert_eq!(identify["op"], 2);
            harness.shutdown().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn reconnects_after_op_7() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let harness = start_client(url);
            let mut first = accept(&listener).await;
            send_hello(&mut first, 600_000).await;
            read_non_heartbeat(&mut first).await.unwrap();
            send(&mut first, json!({ "op": 7, "d": null })).await;
            let mut second = accept(&listener).await;
            send_hello(&mut second, 600_000).await;
            let identify = read_non_heartbeat(&mut second).await.unwrap();
            assert_eq!(identify["op"], 2);
            assert_eq!(identify["d"]["intents"], 0);
            harness.shutdown().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn stops_on_auth_failure() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let harness = start_client(url);
            let mut socket = accept(&listener).await;
            send_hello(&mut socket, 600_000).await;
            read_non_heartbeat(&mut socket).await.unwrap();
            socket
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::from(4004),
                    reason: "".into(),
                })))
                .await
                .unwrap();
            timeout(TEST_TIMEOUT, harness.task).await.unwrap().unwrap();
            assert_eq!(
                *harness.status.borrow(),
                GatewayStatus::Failed("Discord odrzucił token bota".to_string())
            );
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn stops_on_fatal_gateway_close_codes() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let harness = start_client(url);
            let mut socket = accept(&listener).await;
            send_hello(&mut socket, 600_000).await;
            read_non_heartbeat(&mut socket).await.unwrap();
            socket
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::from(4013),
                    reason: "".into(),
                })))
                .await
                .unwrap();
            timeout(TEST_TIMEOUT, harness.task).await.unwrap().unwrap();
            assert_eq!(
                *harness.status.borrow(),
                GatewayStatus::Failed("Discord odrzucił połączenie bramki (kod 4013)".to_string())
            );
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn reconnects_with_backoff_after_non_fatal_close() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let harness = start_client(url);
            let mut first = accept(&listener).await;
            send_hello(&mut first, 600_000).await;
            read_non_heartbeat(&mut first).await.unwrap();
            first
                .send(Message::Close(Some(CloseFrame {
                    code: CloseCode::from(4000),
                    reason: "".into(),
                })))
                .await
                .unwrap();
            let mut second = accept(&listener).await;
            send_hello(&mut second, 600_000).await;
            let identify = read_non_heartbeat(&mut second).await.unwrap();
            assert_eq!(identify["op"], 2);
            harness.shutdown().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn stops_when_asked() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let harness = start_client(url);
            let mut socket = accept(&listener).await;
            send_hello(&mut socket, 600_000).await;
            read_non_heartbeat(&mut socket).await.unwrap();
            send_ready(&mut socket).await;
            let mut status = harness.status.clone();
            status
                .wait_for(|value| *value == GatewayStatus::Connected)
                .await
                .unwrap();
            harness.shutdown().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn stops_while_waiting_for_connection() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            drop(listener);
            let harness = start_client(url);
            let mut status = harness.status.clone();
            status
                .wait_for(|value| *value == GatewayStatus::Connecting)
                .await
                .unwrap();
            harness.shutdown().await;
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn returns_without_connecting_when_already_stopped() {
        timeout(TEST_TIMEOUT, async {
            let (listener, url) = bind().await;
            let (interaction_tx, _interactions) = mpsc::unbounded_channel();
            let (status_tx, status) = watch::channel(GatewayStatus::Off("test".to_string()));
            let (_stop, stop_rx) = watch::channel(true);
            run_gateway(
                url,
                "bot-token".to_string(),
                interaction_tx,
                status_tx,
                stop_rx,
            )
            .await;
            assert_eq!(*status.borrow(), GatewayStatus::Off("test".to_string()));
            assert!(timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err());
        })
        .await
        .unwrap();
    }

    #[test]
    fn debug_output_redacts_the_interaction_token() {
        let interaction = Interaction {
            id: "int-1".to_string(),
            token: "secret-token".to_string(),
            user_id: "user-1".to_string(),
            custom_id: "abeon:q:item-1:0".to_string(),
            message_id: "msg-1".to_string(),
            message_components: Value::Null,
        };
        let rendered = format!("{interaction:?}");
        assert!(!rendered.contains("secret-token"));
        assert!(rendered.contains("<redacted>"));
        assert!(rendered.contains("int-1"));
    }

    #[test]
    fn backoff_doubles_up_to_the_cap() {
        let mut current = BACKOFF_START;
        let mut seen = Vec::new();
        for _ in 0..8 {
            seen.push(current.as_secs());
            current = next_backoff(current);
        }
        assert_eq!(seen, vec![1, 2, 4, 8, 16, 32, 60, 60]);
    }

    #[test]
    fn invalid_session_delay_stays_between_one_and_five_seconds() {
        assert_eq!(invalid_session_delay(0.0), Duration::from_secs(1));
        assert!(invalid_session_delay(0.999_999) < Duration::from_secs(5));
        assert!(invalid_session_delay(0.999_999) > Duration::from_millis(4990));
    }

    #[test]
    fn classify_close_separates_fatal_from_retryable_codes() {
        fn fatal_message(code: Option<u16>) -> Option<String> {
            match classify_close(code) {
                Outcome::Fatal(message) => Some(message),
                Outcome::Backoff => None,
                _ => panic!("unexpected outcome for {code:?}"),
            }
        }

        let token_rejected = Some("Discord odrzucił token bota".to_string());
        assert_eq!(fatal_message(Some(4004)), token_rejected);
        for code in [4010u16, 4014] {
            assert_eq!(
                fatal_message(Some(code)),
                Some(format!("Discord odrzucił połączenie bramki (kod {code})"))
            );
        }
        for code in [Some(4009), Some(4015), Some(1000), None] {
            assert_eq!(fatal_message(code), None);
        }
    }

    #[test]
    fn jitter_stays_in_unit_interval() {
        for _ in 0..100 {
            let value = jitter();
            assert!((0.0..1.0).contains(&value));
        }
    }
}

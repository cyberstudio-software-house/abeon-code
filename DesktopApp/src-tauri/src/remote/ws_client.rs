use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::remote::protocol::RemoteEnvelope;
use crate::remote::wire::{encode_command, parse_frame, Frame, PONG};

pub struct TungsteniteCentrifugoClient {
    out_tx: mpsc::Sender<String>,
    next_id: AtomicU32,
}

pub struct CentrifugoConnection {
    pub client: Arc<TungsteniteCentrifugoClient>,
    pub inbound: mpsc::Receiver<RemoteEnvelope>,
}

impl TungsteniteCentrifugoClient {
    pub async fn connect(
        url: &str,
        token: &str,
        command_channel: &str,
        sub_token: Option<&str>,
    ) -> anyhow::Result<CentrifugoConnection> {
        let (ws_stream, _) = tokio_tungstenite::connect_async(url).await?;
        let (mut sink, stream) = ws_stream.split();

        let connect_frame = encode_command(1, "connect", serde_json::json!({ "token": token }));
        let sub_payload = match sub_token {
            Some(t) => serde_json::json!({ "channel": command_channel, "token": t }),
            None => serde_json::json!({ "channel": command_channel }),
        };
        let subscribe_frame = encode_command(2, "subscribe", sub_payload);

        sink.send(Message::from(connect_frame)).await?;
        sink.send(Message::from(subscribe_frame)).await?;

        let (out_tx, mut out_rx) = mpsc::channel::<String>(64);
        let (in_tx, in_rx) = mpsc::channel::<RemoteEnvelope>(64);

        tokio::spawn(async move {
            while let Some(frame) = out_rx.recv().await {
                if sink.send(Message::from(frame)).await.is_err() {
                    break;
                }
            }
        });

        let command_channel_owned = command_channel.to_string();
        let pong_tx = out_tx.clone();

        tokio::spawn(async move {
            let mut stream = stream;
            while let Some(msg) = stream.next().await {
                let msg = match msg {
                    Ok(m) => m,
                    Err(_) => break,
                };
                let text = match msg.into_text() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                for frame in parse_frame(text.as_str()) {
                    match frame {
                        Frame::Ping => {
                            let _ = pong_tx.send(PONG.to_string()).await;
                        }
                        Frame::Publication { channel, data } if channel == command_channel_owned => {
                            if let Ok(env) = serde_json::from_value::<RemoteEnvelope>(data) {
                                let _ = in_tx.send(env).await;
                            }
                        }
                        Frame::Ack { id, error: Some(e) } => {
                            eprintln!("centrifugo error (id {id}): code={} message={} temporary={}", e.code, e.message, e.temporary);
                        }
                        _ => {}
                    }
                }
            }
        });

        Ok(CentrifugoConnection {
            client: Arc::new(TungsteniteCentrifugoClient {
                out_tx,
                next_id: AtomicU32::new(3),
            }),
            inbound: in_rx,
        })
    }
}

#[async_trait]
impl crate::remote::client::CentrifugoClient for TungsteniteCentrifugoClient {
    async fn publish(&self, channel: &str, data: serde_json::Value) -> anyhow::Result<()> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let frame = encode_command(
            id,
            "publish",
            serde_json::json!({ "channel": channel, "data": data }),
        );
        self.out_tx
            .send(frame)
            .await
            .map_err(|_| anyhow::anyhow!("ws writer closed"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::client::CentrifugoClient;
    use crate::remote::protocol::RemoteCommand;
    use futures_util::{SinkExt, StreamExt};
    use tokio::net::TcpListener;
    use tokio_tungstenite::tungstenite::Message;

    #[tokio::test]
    async fn connects_subscribes_forwards_publication_and_publish() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let url = format!("ws://127.0.0.1:{}/connection/websocket", addr.port());

        let server_task = tokio::spawn(async move {
            let (tcp_stream, _) = listener.accept().await.unwrap();
            let mut ws = tokio_tungstenite::accept_async(tcp_stream).await.unwrap();

            // First message: connect frame
            let msg1 = ws.next().await.unwrap().unwrap();
            let text1 = msg1.to_text().unwrap();
            assert!(text1.contains("connect"), "expected connect, got: {text1}");
            assert!(text1.contains("JWT-TOKEN"), "expected token in connect, got: {text1}");

            // Second message: subscribe frame
            let msg2 = ws.next().await.unwrap().unwrap();
            let text2 = msg2.to_text().unwrap();
            assert!(text2.contains("subscribe"), "expected subscribe, got: {text2}");
            assert!(text2.contains("cmd:test"), "expected channel in subscribe, got: {text2}");

            // Send a publication
            ws.send(Message::from(
                r#"{"push":{"channel":"cmd:test","pub":{"data":{"commandId":"c1","command":{"type":"stopSession","sessionId":"s1"}}}}}"#,
            ))
            .await
            .unwrap();

            // Read the client's publish frame
            let msg3 = ws.next().await.unwrap().unwrap();
            let text3 = msg3.to_text().unwrap();
            assert!(text3.contains("publish"), "expected publish, got: {text3}");
            assert!(text3.contains("sess:x"), "expected channel in publish, got: {text3}");

            // Send a ping and read PONG
            ws.send(Message::from("{}")).await.unwrap();
            let msg4 = ws.next().await.unwrap().unwrap();
            let text4 = msg4.to_text().unwrap();
            assert_eq!(text4, "{}", "expected PONG {{}} got: {text4}");
        });

        let mut conn =
            TungsteniteCentrifugoClient::connect(&url, "JWT-TOKEN", "cmd:test", None)
                .await
                .unwrap();

        let env = conn.inbound.recv().await.unwrap();
        assert_eq!(env.command_id, "c1");
        assert!(
            matches!(
                &env.command,
                RemoteCommand::StopSession { session_id } if session_id == "s1"
            ),
            "unexpected command: {:?}",
            env.command
        );

        conn.client
            .publish("sess:x", serde_json::json!({ "k": 1 }))
            .await
            .unwrap();

        server_task.await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires CENTRIFUGO_TOKEN_SECRET env and network to the live server"]
    async fn live_centrifugo_smoke() {
        let secret = match std::env::var("CENTRIFUGO_TOKEN_SECRET") {
            Ok(s) if !s.is_empty() => s,
            _ => { eprintln!("SKIP: CENTRIFUGO_TOKEN_SECRET not set"); return; }
        };
        let url = std::env::var("CENTRIFUGO_WS_URL")
            .unwrap_or_else(|_| "wss://ws.k8s.abeon.app/connection/websocket".to_string());
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as usize;
        let token = crate::remote::token::mint_connection_token(&secret, "live-smoke-device", now, 3600).unwrap();

        let conn = TungsteniteCentrifugoClient::connect(&url, &token, "cmd:live-smoke-device", None).await
            .expect("connect to live centrifugo");
        conn.client.publish("sess:live-smoke", serde_json::json!({ "type": "smoke", "ts": now })).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        eprintln!("live smoke: connected and published (check above for any 'centrifugo error' lines)");
    }
}

use axum::body::Body;
use axum::http::{Request, StatusCode};
use cloudservice::centrifugo::FakeCentrifugo;
use cloudservice::config::Config;
use cloudservice::store::{InMemoryDevices, InMemoryPairing, InMemoryPhones};
use cloudservice::{app, AppState};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt; // for `oneshot`

fn test_state(centrifugo: Arc<FakeCentrifugo>) -> AppState {
    AppState {
        devices: Arc::new(InMemoryDevices::default()),
        phones: Arc::new(InMemoryPhones::default()),
        pairing: Arc::new(InMemoryPairing::default()),
        centrifugo,
        config: Arc::new(Config {
            bind_addr: "0.0.0.0:0".into(),
            database_url: "unused".into(),
            centrifugo_token_secret: "test-secret".into(),
            centrifugo_api_key: "test-key".into(),
            centrifugo_api_url: "http://unused".into(),
            token_ttl_secs: 3600,
            pairing_ttl_secs: 300,
        }),
    }
}

async fn json_request(
    state: AppState,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri).header("content-type", "application/json");
    if let Some(b) = bearer {
        builder = builder.header("authorization", format!("Bearer {b}"));
    }
    let req = builder.body(Body::from(serde_json::to_vec(&body).unwrap())).unwrap();
    let resp = app(state).oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let value: Value = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() };
    (status, value)
}

#[tokio::test]
async fn full_pairing_and_command_flow() {
    let centrifugo = Arc::new(FakeCentrifugo::default()); // present = 1 by default
    let state = test_state(centrifugo.clone());

    // 1. Desktop registers.
    let (s, body) = json_request(state.clone(), "POST", "/v1/devices", None, json!({})).await;
    assert_eq!(s, StatusCode::OK);
    let device_secret = body["deviceSecret"].as_str().unwrap().to_string();
    let device_id = body["deviceId"].as_str().unwrap().to_string();

    // 2. Desktop starts pairing.
    let (s, body) = json_request(state.clone(), "POST", "/v1/pair/start", Some(&device_secret), json!({})).await;
    assert_eq!(s, StatusCode::OK);
    let code = body["code"].as_str().unwrap().to_string();

    // 3. Phone claims the code.
    let (s, body) = json_request(state.clone(), "POST", "/v1/pair/claim", None, json!({ "code": code })).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(body["deviceId"], device_id);
    let phone_token = body["phoneToken"].as_str().unwrap().to_string();

    // 4. Phone sends a command → published to the device's cmd channel.
    let env = json!({
        "commandId": "c1",
        "command": { "type": "sendPrompt", "sessionId": "550e8400-e29b-41d4-a716-446655440000", "text": "hi" }
    });
    let (s, body) = json_request(state.clone(), "POST", "/v1/command", Some(&phone_token), env).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    assert_eq!(body["published"], true);

    let published = centrifugo.published.lock().unwrap();
    assert_eq!(published.len(), 1);
    assert_eq!(published[0].0, format!("abeon-cloud-cmd:{device_id}"));
    assert_eq!(published[0].1["commandId"], "c1");
}

#[tokio::test]
async fn command_without_auth_is_unauthorized() {
    let state = test_state(Arc::new(FakeCentrifugo::default()));
    let env = json!({ "commandId": "c1", "command": { "type": "stopSession", "sessionId": "s1" } });
    let (s, _) = json_request(state, "POST", "/v1/command", None, env).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn command_rejects_invalid_session_id() {
    let centrifugo = Arc::new(FakeCentrifugo::default());
    let state = test_state(centrifugo.clone());
    let (_, body) = json_request(state.clone(), "POST", "/v1/devices", None, json!({})).await;
    let device_secret = body["deviceSecret"].as_str().unwrap().to_string();
    let (_, body) = json_request(state.clone(), "POST", "/v1/pair/start", Some(&device_secret), json!({})).await;
    let code = body["code"].as_str().unwrap().to_string();
    let (_, body) = json_request(state.clone(), "POST", "/v1/pair/claim", None, json!({ "code": code })).await;
    let phone_token = body["phoneToken"].as_str().unwrap().to_string();

    let env = json!({ "commandId": "c1", "command": { "type": "stopSession", "sessionId": "../etc/passwd" } });
    let (s, _) = json_request(state, "POST", "/v1/command", Some(&phone_token), env).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(centrifugo.published.lock().unwrap().is_empty());
}

#[tokio::test]
async fn command_when_desktop_offline_is_conflict() {
    let centrifugo = Arc::new(FakeCentrifugo::default());
    *centrifugo.present.lock().unwrap() = 0; // desktop not connected
    let state = test_state(centrifugo.clone());
    let (_, body) = json_request(state.clone(), "POST", "/v1/devices", None, json!({})).await;
    let device_secret = body["deviceSecret"].as_str().unwrap().to_string();
    let (_, body) = json_request(state.clone(), "POST", "/v1/pair/start", Some(&device_secret), json!({})).await;
    let code = body["code"].as_str().unwrap().to_string();
    let (_, body) = json_request(state.clone(), "POST", "/v1/pair/claim", None, json!({ "code": code })).await;
    let phone_token = body["phoneToken"].as_str().unwrap().to_string();

    let env = json!({ "commandId": "c1", "command": { "type": "stopSession", "sessionId": "s1" } });
    let (s, _) = json_request(state, "POST", "/v1/command", Some(&phone_token), env).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert!(centrifugo.published.lock().unwrap().is_empty());
}

#[tokio::test]
async fn expired_or_unknown_code_is_bad_request() {
    let state = test_state(Arc::new(FakeCentrifugo::default()));
    let (s, _) = json_request(state, "POST", "/v1/pair/claim", None, json!({ "code": "ZZZZZZZZ" })).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
}

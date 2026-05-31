use axum::body::Body;
use axum::http::{Request, StatusCode};
use cloudservice::centrifugo::FakeCentrifugo;
use cloudservice::config::Config;
use cloudservice::expo::FakeExpo;
use cloudservice::store::{InMemoryDevices, InMemoryPairing, InMemoryPhones};
use cloudservice::{app, AppState};
use serde_json::{json, Value};
use std::sync::Arc;
use tower::ServiceExt; // for `oneshot`

fn test_state(centrifugo: Arc<FakeCentrifugo>) -> AppState {
    test_state_with_expo(centrifugo, Arc::new(FakeExpo::default()))
}

fn test_state_with_expo(centrifugo: Arc<FakeCentrifugo>, expo: Arc<FakeExpo>) -> AppState {
    AppState {
        devices: Arc::new(InMemoryDevices::default()),
        phones: Arc::new(InMemoryPhones::default()),
        pairing: Arc::new(InMemoryPairing::default()),
        centrifugo,
        expo: expo as Arc<dyn cloudservice::expo::ExpoApi>,
        config: Arc::new(Config {
            bind_addr: "0.0.0.0:0".into(),
            database_url: "unused".into(),
            centrifugo_token_secret: "test-secret".into(),
            centrifugo_api_key: "test-key".into(),
            centrifugo_api_url: "http://unused".into(),
            token_ttl_secs: 3600,
            pairing_ttl_secs: 300,
            expo_push_url: "http://unused-expo".into(),
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

/// Helper: register a device, start pairing, claim it — returns (device_id, device_secret, phone_token).
async fn setup_pair(state: AppState) -> (String, String, String) {
    let (_, body) = json_request(state.clone(), "POST", "/v1/devices", None, json!({})).await;
    let device_secret = body["deviceSecret"].as_str().unwrap().to_string();
    let device_id = body["deviceId"].as_str().unwrap().to_string();
    let (_, body) = json_request(state.clone(), "POST", "/v1/pair/start", Some(&device_secret), json!({})).await;
    let code = body["code"].as_str().unwrap().to_string();
    let (_, body) = json_request(state.clone(), "POST", "/v1/pair/claim", None, json!({ "code": code })).await;
    let phone_token = body["phoneToken"].as_str().unwrap().to_string();
    (device_id, device_secret, phone_token)
}

#[tokio::test]
async fn push_token_registers_and_is_looked_up() {
    let expo = Arc::new(FakeExpo::default());
    let state = test_state_with_expo(Arc::new(FakeCentrifugo::default()), expo.clone());

    let (device_id, _device_secret, phone_token) = setup_pair(state.clone()).await;

    // Register Expo push token via phone-authenticated endpoint.
    let (s, _) = json_request(
        state.clone(),
        "POST",
        "/v1/push-token",
        Some(&phone_token),
        json!({ "expoToken": "ExponentPushToken[x]" }),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    // Assert stored token is retrievable.
    let stored = state.phones.expo_push_token_for_device(&device_id).await.unwrap();
    assert_eq!(stored, Some("ExponentPushToken[x]".to_string()));
}

#[tokio::test]
async fn notify_sends_push_to_registered_token() {
    let expo = Arc::new(FakeExpo::default());
    let state = test_state_with_expo(Arc::new(FakeCentrifugo::default()), expo.clone());

    let (_device_id, device_secret, phone_token) = setup_pair(state.clone()).await;

    // Phone registers its Expo token.
    json_request(
        state.clone(),
        "POST",
        "/v1/push-token",
        Some(&phone_token),
        json!({ "expoToken": "ExponentPushToken[abc]" }),
    )
    .await;

    // Desktop triggers a notify.
    let (s, _) = json_request(
        state.clone(),
        "POST",
        "/v1/notify",
        Some(&device_secret),
        json!({ "sessionId": "s1" }),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    let sent = expo.sent.lock().unwrap();
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].0, "ExponentPushToken[abc]");
    assert_eq!(sent[0].3["sessionId"], "s1");
}

#[tokio::test]
async fn notify_without_token_is_noop() {
    let expo = Arc::new(FakeExpo::default());
    let state = test_state_with_expo(Arc::new(FakeCentrifugo::default()), expo.clone());

    let (_device_id, device_secret, _phone_token) = setup_pair(state.clone()).await;

    // Desktop triggers notify without any push token registered.
    let (s, _) = json_request(
        state.clone(),
        "POST",
        "/v1/notify",
        Some(&device_secret),
        json!({ "sessionId": "s1" }),
    )
    .await;
    assert_eq!(s, StatusCode::OK);

    let sent = expo.sent.lock().unwrap();
    assert!(sent.is_empty());
}

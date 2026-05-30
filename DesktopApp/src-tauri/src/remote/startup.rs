use std::sync::Arc;
use tauri::{AppHandle, Manager};
use crate::state::AppState;
use crate::remote::bus::RemoteEventBus;
use crate::remote::bridge::{RemoteBridge, AppPtyActuator, PtyActuator, cmd_channel};
use crate::remote::ws_client::TungsteniteCentrifugoClient;
use crate::remote::token::mint_connection_token;

const DEFAULT_WS_URL: &str = "wss://ws.k8s.abeon.app/connection/websocket";

/// Wire the remote bridge at startup, but only when explicitly enabled. Off by
/// default so normal launches are unaffected: requires the `remoteBridgeEnabled`
/// setting == "true" AND a non-empty `CENTRIFUGO_TOKEN_SECRET` env var. The WS
/// URL comes from `CENTRIFUGO_WS_URL` or falls back to the known deployment.
pub fn init_remote_bridge(app: AppHandle) {
    let state = app.state::<AppState>();
    let conn = match state.db.get() { Ok(c) => c, Err(_) => return };

    let enabled = matches!(crate::db::settings_repo::get(&conn, "remoteBridgeEnabled"), Ok(Some(ref v)) if v == "true");
    if !enabled { return; }
    let secret = match std::env::var("CENTRIFUGO_TOKEN_SECRET") { Ok(s) if !s.is_empty() => s, _ => return };
    let url = std::env::var("CENTRIFUGO_WS_URL").unwrap_or_else(|_| DEFAULT_WS_URL.to_string());
    let device_id = resolve_device_id(&conn);
    let allow_spawn = crate::commands::settings::allow_remote_spawn(&conn);
    drop(conn);

    let bus = RemoteEventBus::new();
    state.session_watchers.set_bus(bus.clone());

    let registry_for_hook = state.session_pty.clone();
    state.pty.set_exit_hook(Arc::new(move |id| registry_for_hook.unbind_pty(&id)));

    let registry = state.session_pty.clone();
    let app_for_actuator = app.clone();
    let device_for_run = device_id.clone();
    let bus_rx = bus.subscribe();

    tauri::async_runtime::spawn(async move {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as usize)
            .unwrap_or(0);
        let token = match mint_connection_token(&secret, &device_id, now, 3600) {
            Ok(t) => t,
            Err(e) => { eprintln!("remote bridge: token mint failed: {e}"); return; }
        };
        let conn = match TungsteniteCentrifugoClient::connect(&url, &token, &cmd_channel(&device_id), None).await {
            Ok(c) => c,
            Err(e) => { eprintln!("remote bridge: connect failed: {e}"); return; }
        };
        let bridge = Arc::new(RemoteBridge::new(registry, allow_spawn));
        let actuator: Arc<dyn PtyActuator> = Arc::new(AppPtyActuator::new(app_for_actuator));
        bridge.run(device_for_run, conn.inbound, bus_rx, conn.client, actuator).await;
        eprintln!("remote bridge: run-loop ended");
    });
}

fn resolve_device_id(conn: &rusqlite::Connection) -> String {
    if let Ok(Some(id)) = crate::db::settings_repo::get(conn, "remoteDeviceId") {
        if !id.is_empty() { return id; }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = crate::db::settings_repo::set(conn, "remoteDeviceId", &id);
    id
}

use std::future::Future;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader as AsyncBufReader};
use tokio::net::{UnixListener, UnixStream};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(1);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REQUEST_BYTES: u64 = 4 * 1024 * 1024;
const ACCEPT_RETRY_DELAY: Duration = Duration::from_millis(100);
const DIR_MODE: u32 = 0o700;
const SOCKET_MODE: u32 = 0o600;
const SOCKET_FILE: &str = "supervisor.sock";

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HookChannel {
    Session,
    Supervisor,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum IpcRequest {
    Hook { channel: HookChannel, input: Value },
    Tool { name: String, args: Value },
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum IpcResponse {
    Hook { stdout: Option<String> },
    Tool { ok: bool, result: Value },
}

pub trait IpcHandler: Send + Sync {
    fn handle(&self, req: IpcRequest) -> Pin<Box<dyn Future<Output = IpcResponse> + Send>>;
}

pub fn socket_path() -> PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    socket_path_from(runtime, dirs::data_local_dir())
}

fn socket_path_from(runtime: Option<PathBuf>, data_local: Option<PathBuf>) -> PathBuf {
    match runtime {
        Some(dir) => dir.join("abeoncode").join(SOCKET_FILE),
        None => data_local
            .unwrap_or_else(std::env::temp_dir)
            .join("pl.cyberstudio.abeoncode")
            .join("run")
            .join(SOCKET_FILE),
    }
}

fn prepare_socket_path(path: &Path) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(DIR_MODE))?;
    }
    if std::fs::symlink_metadata(path).is_ok() {
        if StdUnixStream::connect(path).is_ok() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::AddrInUse,
                "supervisor socket is already served by another process",
            ));
        }
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub async fn serve(path: PathBuf, handler: Arc<dyn IpcHandler>) -> std::io::Result<()> {
    let listener = bind(&path)?;
    serve_listener(listener, handler).await;
    Ok(())
}

pub fn bind(path: &Path) -> std::io::Result<UnixListener> {
    prepare_socket_path(path)?;
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(SOCKET_MODE))?;
    Ok(listener)
}

pub async fn serve_listener(listener: UnixListener, handler: Arc<dyn IpcHandler>) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                let handler = handler.clone();
                tokio::spawn(async move {
                    let _ = handle_connection(stream, handler).await;
                });
            }
            Err(_) => tokio::time::sleep(ACCEPT_RETRY_DELAY).await,
        }
    }
}

async fn handle_connection(
    stream: UnixStream,
    handler: Arc<dyn IpcHandler>,
) -> std::io::Result<()> {
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = AsyncBufReader::new(read_half.take(MAX_REQUEST_BYTES));
    let mut line = String::new();
    let read = tokio::time::timeout(REQUEST_READ_TIMEOUT, reader.read_line(&mut line)).await;
    match read {
        Ok(Ok(bytes)) if bytes > 0 => {}
        _ => return Ok(()),
    }
    let Ok(request) = serde_json::from_str::<IpcRequest>(line.trim()) else {
        return Ok(());
    };
    let response = handler.handle(request).await;
    let mut payload = serde_json::to_vec(&response).map_err(std::io::Error::other)?;
    payload.push(b'\n');
    write_half.write_all(&payload).await?;
    write_half.shutdown().await
}

fn connect_with_timeout(path: &Path, timeout: Duration) -> Option<StdUnixStream> {
    let (sender, receiver) = mpsc::channel();
    let target = path.to_path_buf();
    std::thread::spawn(move || {
        let _ = sender.send(StdUnixStream::connect(target).ok());
    });
    receiver.recv_timeout(timeout).ok().flatten()
}

pub fn request_blocking(
    path: &Path,
    req: &IpcRequest,
    read_timeout: Duration,
) -> Option<IpcResponse> {
    let stream = connect_with_timeout(path, CONNECT_TIMEOUT)?;
    stream.set_write_timeout(Some(WRITE_TIMEOUT)).ok()?;
    stream.set_read_timeout(Some(read_timeout)).ok()?;
    let mut payload = serde_json::to_vec(req).ok()?;
    payload.push(b'\n');
    (&stream).write_all(&payload).ok()?;
    (&stream).flush().ok()?;
    let mut line = String::new();
    let bytes = BufReader::new(&stream).read_line(&mut line).ok()?;
    if bytes == 0 {
        return None;
    }
    serde_json::from_str(line.trim()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::time::Instant;

    struct StubHandler;

    impl IpcHandler for StubHandler {
        fn handle(&self, req: IpcRequest) -> Pin<Box<dyn Future<Output = IpcResponse> + Send>> {
            Box::pin(async move {
                match req {
                    IpcRequest::Hook { channel, input } => IpcResponse::Hook {
                        stdout: Some(format!("{channel:?}:{}", input["session_id"])),
                    },
                    IpcRequest::Tool { name, args } => IpcResponse::Tool {
                        ok: name != "fail",
                        result: json!({ "name": name, "args": args }),
                    },
                }
            })
        }
    }

    async fn wait_until_serving(path: &Path) {
        for _ in 0..200 {
            if StdUnixStream::connect(path).is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("socket never started serving");
    }

    async fn call(path: &Path, req: IpcRequest) -> Option<IpcResponse> {
        let path = path.to_path_buf();
        tokio::task::spawn_blocking(move || request_blocking(&path, &req, Duration::from_secs(5)))
            .await
            .unwrap()
    }

    fn hook_request() -> IpcRequest {
        IpcRequest::Hook {
            channel: HookChannel::Session,
            input: json!({ "session_id": "s1" }),
        }
    }

    #[tokio::test]
    async fn roundtrip_hook_and_tool() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("run").join("supervisor.sock");
        let server = tokio::spawn(serve(path.clone(), Arc::new(StubHandler)));
        wait_until_serving(&path).await;

        let hook = call(&path, hook_request()).await;
        assert_eq!(
            hook,
            Some(IpcResponse::Hook {
                stdout: Some("Session:\"s1\"".to_string())
            })
        );

        let tool = call(
            &path,
            IpcRequest::Tool {
                name: "list_sessions".to_string(),
                args: json!({ "a": 1 }),
            },
        )
        .await;
        assert_eq!(
            tool,
            Some(IpcResponse::Tool {
                ok: true,
                result: json!({ "name": "list_sessions", "args": { "a": 1 } })
            })
        );

        let failing = call(
            &path,
            IpcRequest::Tool {
                name: "fail".to_string(),
                args: json!({}),
            },
        )
        .await;
        assert!(matches!(failing, Some(IpcResponse::Tool { ok: false, .. })));

        let dir_mode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        let socket_mode = std::fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(dir_mode & 0o777, 0o700);
        assert_eq!(socket_mode & 0o777, 0o600);
        server.abort();
    }

    #[tokio::test]
    async fn malformed_request_closes_without_reply_and_server_survives() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("supervisor.sock");
        let server = tokio::spawn(serve(path.clone(), Arc::new(StubHandler)));
        wait_until_serving(&path).await;

        let probe = path.clone();
        let reply = tokio::task::spawn_blocking(move || {
            let mut stream = StdUnixStream::connect(&probe).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream.write_all(b"not json\n").unwrap();
            let mut line = String::new();
            BufReader::new(&stream).read_line(&mut line).unwrap();
            line
        })
        .await
        .unwrap();
        assert!(reply.is_empty());
        assert!(call(&path, hook_request()).await.is_some());
        server.abort();
    }

    #[tokio::test]
    async fn server_refuses_to_steal_live_socket() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("supervisor.sock");
        let first = tokio::spawn(serve(path.clone(), Arc::new(StubHandler)));
        wait_until_serving(&path).await;

        let second = tokio::time::timeout(
            Duration::from_secs(5),
            serve(path.clone(), Arc::new(StubHandler)),
        )
        .await
        .expect("second serve must return instead of taking over the socket");
        assert_eq!(second.unwrap_err().kind(), std::io::ErrorKind::AddrInUse);
        assert!(call(&path, hook_request()).await.is_some());
        first.abort();
    }

    #[tokio::test]
    async fn stale_socket_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("supervisor.sock");
        drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
        assert!(path.exists());
        assert!(StdUnixStream::connect(&path).is_err());

        let server = tokio::spawn(serve(path.clone(), Arc::new(StubHandler)));
        wait_until_serving(&path).await;
        assert!(call(&path, hook_request()).await.is_some());
        server.abort();
    }

    #[test]
    fn hook_client_without_server_is_silent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.sock");
        let started = Instant::now();
        let reply = request_blocking(&path, &hook_request(), Duration::from_secs(10));
        assert!(reply.is_none());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn wire_format_is_tagged_camel_case() {
        let encoded = serde_json::to_value(hook_request()).unwrap();
        assert_eq!(
            encoded,
            json!({ "type": "hook", "channel": "session", "input": { "session_id": "s1" } })
        );
        let supervisor: IpcRequest =
            serde_json::from_value(json!({ "type": "hook", "channel": "supervisor", "input": {} }))
                .unwrap();
        assert!(matches!(
            supervisor,
            IpcRequest::Hook {
                channel: HookChannel::Supervisor,
                ..
            }
        ));
    }

    #[test]
    fn socket_path_prefers_runtime_dir() {
        let runtime = socket_path_from(
            Some(PathBuf::from("/run/user/1")),
            Some(PathBuf::from("/data")),
        );
        assert_eq!(
            runtime,
            PathBuf::from("/run/user/1/abeoncode/supervisor.sock")
        );
        let fallback = socket_path_from(None, Some(PathBuf::from("/data")));
        assert_eq!(
            fallback,
            PathBuf::from("/data/pl.cyberstudio.abeoncode/run/supervisor.sock")
        );
    }
}

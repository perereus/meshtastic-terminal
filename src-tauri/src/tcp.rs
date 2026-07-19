use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedWriteHalf;
use tauri::async_runtime::JoinHandle;
use tokio::net::TcpStream;

// ponytail: una sola conexión TCP a la vez, suficiente para este cliente
#[derive(Default)]
pub struct TcpState {
    writer: tokio::sync::Mutex<Option<OwnedWriteHalf>>,
    reader_task: Mutex<Option<JoinHandle<()>>>,
}

#[tauri::command]
pub async fn tcp_connect(
    app: AppHandle,
    state: State<'_, TcpState>,
    host: String,
) -> Result<(), String> {
    let addr = if host.contains(':') {
        host
    } else {
        format!("{host}:4403")
    };
    let stream = TcpStream::connect(&addr).await.map_err(|e| e.to_string())?;
    stream.set_nodelay(true).ok();
    let (mut read_half, write_half) = stream.into_split();

    let app2 = app.clone();
    let task = tauri::async_runtime::spawn(async move {
        let mut buf = [0u8; 4096];
        loop {
            match read_half.read(&mut buf).await {
                Ok(0) | Err(_) => {
                    app2.emit("tcp-closed", ()).ok();
                    break;
                }
                Ok(n) => {
                    app2.emit("tcp-data", buf[..n].to_vec()).ok();
                }
            }
        }
    });

    if let Some(old) = state.reader_task.lock().unwrap().replace(task) {
        old.abort();
    }
    *state.writer.lock().await = Some(write_half);
    Ok(())
}

#[tauri::command]
pub async fn tcp_send(state: State<'_, TcpState>, data: Vec<u8>) -> Result<(), String> {
    let mut guard = state.writer.lock().await;
    let writer = guard.as_mut().ok_or("sin conexión TCP")?;
    writer.write_all(&data).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tcp_disconnect(state: State<'_, TcpState>) -> Result<(), String> {
    if let Some(task) = state.reader_task.lock().unwrap().take() {
        task.abort();
    }
    if let Some(mut writer) = state.writer.lock().await.take() {
        writer.shutdown().await.ok();
    }
    Ok(())
}

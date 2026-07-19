mod tcp;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

// The app keeps receiving mesh packets with the window closed, so closing it
// hides it in the tray. Quitting for real: the tray menu.
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_blec::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_serialplugin::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .manage(tcp::TcpState::default())
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "Abrir", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("meshtastic-client")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = ev
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                // Closing only hides, so the plugin never sees a real close:
                // we save here, with the window still visible and reporting
                // valid measurements, instead of relying on the exit event.
                let _ = window.app_handle().save_window_state(StateFlags::all());
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            tcp::tcp_connect,
            tcp::tcp_send,
            tcp::tcp_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

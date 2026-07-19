mod tcp;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, WindowEvent};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

// La app sigue recibiendo paquetes de la malla con la ventana cerrada, asi que
// cerrar la esconde en la bandeja. Salir de verdad: menu de la bandeja.
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
                // Cerrar solo esconde, asi que el plugin no ve un cierre real:
                // guardamos aqui, con la ventana aun visible y con medidas
                // validas, en vez de fiarlo al evento de salida.
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

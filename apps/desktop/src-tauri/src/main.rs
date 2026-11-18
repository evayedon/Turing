#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod workspace;

use tauri::{Manager, RunEvent, WindowEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(workspace::WorkspaceService::default())
        .invoke_handler(tauri::generate_handler![
            commands::workspace_open,
            commands::workspace_close,
            commands::fs_list_directory,
            commands::fs_read_file,
            commands::fs_write_file,
            commands::file_open,
            commands::file_read,
            commands::file_write,
            commands::file_close,
            commands::file_save_as,
            commands::editor_confirm_discard,
            commands::editor_exit,
        ])
        .build(tauri::generate_context!())
        .expect("failed to start Turing Core")
        .run(|app, event| {
            if let Some(window) = app.get_webview_window("main") {
                match event {
                    RunEvent::WindowEvent {
                        label,
                        event: WindowEvent::CloseRequested { api, .. },
                        ..
                    } if label == "main" => api.prevent_close(),
                    RunEvent::ExitRequested {
                        code: None, api, ..
                    } => api.prevent_exit(),
                    _ => return,
                }
                // Deliver a fixed signal without granting webview eval or general event permissions.
                let _ = window.eval("window.dispatchEvent(new Event('turing-close-requested'))");
            }
        });
}

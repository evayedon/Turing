#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod workspace;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(workspace::WorkspaceService::default())
        .invoke_handler(tauri::generate_handler![
            commands::workspace_open,
            commands::workspace_close,
            commands::fs_list_directory,
            commands::fs_read_file,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Turing Core");
}

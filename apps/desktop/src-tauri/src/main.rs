#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ask;
mod commands;
#[cfg(test)]
mod contract_fixtures;
mod drafts;
mod execution;
mod git;
mod language;
#[cfg(feature = "smoke")]
mod smoke;
mod terminal;
mod windows;
mod workspace;

use tauri::{Manager, RunEvent, WindowEvent};

fn main() {
    #[cfg(feature = "perf")]
    let started = std::time::Instant::now();
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(windows::Windows::default())
        .manage(drafts::DraftJournal::default())
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                webview
                    .state::<drafts::DraftJournal>()
                    .release(webview.label());
                webview
                    .state::<windows::Windows>()
                    .page_loading(webview.label());
            }
            #[cfg(feature = "smoke")]
            smoke::page_event(webview, payload.event());
        });
    // The lifecycle smoke harness exists only in builds with the non-default
    // `smoke` feature and activates only when TURING_SMOKE=1.
    #[cfg(feature = "smoke")]
    let builder = smoke::install(builder);
    #[cfg(feature = "perf")]
    let mut context = tauri::generate_context!();
    #[cfg(feature = "perf")]
    let builder = smoke::configure_perf(builder, &mut context, started);
    #[cfg(not(feature = "perf"))]
    let context = tauri::generate_context!();
    builder
        .invoke_handler(tauri::generate_handler![
            ask::ask_run,
            ask::ask_index,
            ask::ask_cancel,
            ask::cloud::ask_cloud_credential,
            drafts::draft_recovery,
            windows::window_new_workbench,
            windows::window_new_terminal,
            commands::workspace_open,
            commands::workspace_create_file,
            commands::workspace_rename_entry,
            commands::workspace_close,
            commands::workspace_watch_poll,
            commands::fs_list_directory,
            commands::fs_read_file,
            commands::workspace_search_begin,
            commands::workspace_symbols_query,
            commands::workspace_search_run,
            commands::workspace_search_cancel,
            commands::fs_write_file,
            commands::file_open,
            commands::file_read,
            commands::file_write,
            commands::file_close,
            commands::file_save_as,
            commands::editor_confirm_discard,
            commands::editor_exit,
            execution::execution_start,
            execution::execution_read,
            execution::execution_stop,
            language::language_start,
            language::language_apply,
            language::language_poll,
            language::language_stop,
            terminal::terminal_start,
            terminal::terminal_cancel_start,
            terminal::terminal_read,
            terminal::links::terminal_open_link,
            terminal::terminal_input,
            terminal::terminal_resize,
            terminal::terminal_close,
            git::git_status,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_branches,
            git::git_checkout,
            git::git_log,
        ])
        .build(context)
        .expect("failed to start Turing Core")
        .run(|app, event| {
            let resources = app.state::<windows::Windows>();
            match event {
                RunEvent::Exit => resources.shutdown(),
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::Destroyed,
                    ..
                } => {
                    app.state::<drafts::DraftJournal>().release(&label);
                    resources.remove(&label);
                }
                RunEvent::WindowEvent {
                    label,
                    event: WindowEvent::CloseRequested { api, .. },
                    ..
                } => {
                    if resources
                        .get(&label)
                        .is_some_and(|resource| resource.kind == windows::Kind::Workbench)
                    {
                        if let Some(window) = app.get_webview_window(&label) {
                            api.prevent_close();
                            let _ = window
                                .eval("window.dispatchEvent(new Event('turing-close-requested'))");
                        }
                    }
                }
                RunEvent::ExitRequested {
                    code: None, api, ..
                } => {
                    let windows = app.webview_windows();
                    if windows.keys().any(|label| resources.get(label).is_some()) {
                        api.prevent_exit();
                        for (label, window) in windows {
                            if resources.get(&label).is_some() {
                                let _ = window.close();
                            }
                        }
                    }
                }
                _ => {}
            }
        });
}

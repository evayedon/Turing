use crate::windows::workbench;
use crate::workspace::{
    validate_save_content, DirectoryEntry, PickedFile, SelectedFileSnapshot, SelectedFileVersion,
    TextFile, WorkspaceChanges, WorkspaceDescriptor, WorkspaceError,
};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;

type Result<T> = std::result::Result<T, WorkspaceError>;

async fn in_workspace<T, F>(window: WebviewWindow, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(WebviewWindow) -> Result<T> + Send + 'static,
{
    workbench(&window)?;
    tauri::async_runtime::spawn_blocking(move || operation(window))
        .await
        .map_err(|_| WorkspaceError::IoError)?
}

#[tauri::command]
pub async fn workspace_open(
    window: WebviewWindow,
    recent_path: Option<String>,
) -> Result<Option<WorkspaceDescriptor>> {
    in_workspace(window, move |window| {
        let resources = workbench(&window)?;
        let service = &resources.workspace;
        let _picker = service.begin_picker()?;
        #[cfg(feature = "perf")]
        if let Some(path) = crate::smoke::fixture_for(&window) {
            let workspace = service.registry()?.register(window.label(), &path)?;
            resources.language.revoke(false);
            return Ok(Some(workspace));
        }
        let mut dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Open Workspace Folder");
        if let Some(path) = recent_path
            .as_deref()
            .map(std::path::Path::new)
            .filter(|path| path.is_absolute())
        {
            dialog = dialog.set_directory(path);
        }
        let Some(selection) = dialog.blocking_pick_folder() else {
            return Ok(None);
        };
        let path = selection
            .into_path()
            .map_err(|_| WorkspaceError::OutsideWorkspace)?;
        let workspace = service.registry()?.register(window.label(), &path)?;
        resources.language.revoke(false);
        // Watching is best effort: without it (for example when the OS watch
        // limit is reached) views keep their manual and periodic checks.
        let _ = service.watch(window.label(), &workspace.id);
        Ok(Some(workspace))
    })
    .await
}

#[tauri::command]
pub async fn workspace_close(window: WebviewWindow, workspace_id: String) -> Result<()> {
    in_workspace(window, move |window| {
        let resources = workbench(&window)?;
        let mut registry = resources.workspace.registry()?;
        registry.close(window.label(), &workspace_id)?;
        resources.language.revoke(false);
        Ok(())
    })
    .await
}

/// Returns coalesced change hints for the caller's active workspace.
#[tauri::command]
pub async fn workspace_watch_poll(
    window: WebviewWindow,
    workspace_id: String,
) -> Result<WorkspaceChanges> {
    in_workspace(window, move |window| {
        workbench(&window)?.workspace.registry()?.poll_changes(
            window.label(),
            &workspace_id,
            std::time::Instant::now(),
        )
    })
    .await
}

#[tauri::command]
pub async fn fs_list_directory(
    window: WebviewWindow,
    workspace_id: String,
    relative_path: String,
) -> Result<Vec<DirectoryEntry>> {
    in_workspace(window, move |window| {
        workbench(&window)?.workspace.registry()?.list(
            window.label(),
            &workspace_id,
            &relative_path,
        )
    })
    .await
}

#[tauri::command]
pub async fn fs_read_file(
    window: WebviewWindow,
    workspace_id: String,
    relative_path: String,
) -> Result<TextFile> {
    in_workspace(window, move |window| {
        workbench(&window)?.workspace.registry()?.read(
            window.label(),
            &workspace_id,
            &relative_path,
        )
    })
    .await
}

#[tauri::command]
pub async fn fs_write_file(
    window: WebviewWindow,
    workspace_id: String,
    relative_path: String,
    expected_version: String,
    content: String,
    recreate: Option<bool>,
) -> Result<Option<String>> {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};

    in_workspace(window, move |window| {
        let workbench = workbench(&window)?;
        let service = &workbench.workspace;
        if recreate == Some(true) {
            validate_save_content(&content)?;
            let workspace_path = service
                .registry()?
                .workspace_path(window.label(), &workspace_id)?
                .display()
                .to_string();
            if !window
                .dialog()
                .message(format!(
                    "Recreate {relative_path} in {workspace_path} using the text in this tab?"
                ))
                .title("Recreate file")
                .parent(&window)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Recreate file".into(),
                    "Cancel".into(),
                ))
                .blocking_show()
            {
                return Ok(None);
            }
            return service
                .registry()?
                .recreate(window.label(), &workspace_id, &relative_path, &content)
                .map(Some);
        }
        let registry = service.registry()?;
        registry
            .write(
                window.label(),
                &workspace_id,
                &relative_path,
                &expected_version,
                &content,
            )
            .map(Some)
    })
    .await
}

#[tauri::command]
pub async fn file_open(
    window: WebviewWindow,
    recent_path: Option<String>,
) -> Result<Option<SelectedFileSnapshot>> {
    in_workspace(window, move |window| {
        let resources = workbench(&window)?;
        let service = &resources.workspace;
        let _picker = service.begin_picker()?;
        let mut dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Open File");
        if let Some(path) = recent_path
            .as_deref()
            .map(std::path::Path::new)
            .filter(|path| path.is_absolute())
        {
            if let Some(parent) = path.parent() {
                dialog = dialog.set_directory(parent);
            }
            if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
                dialog = dialog.set_file_name(name);
            }
        }
        let Some(selection) = dialog.blocking_pick_file() else {
            return Ok(None);
        };
        let path = selection
            .into_path()
            .map_err(|_| WorkspaceError::OutsideWorkspace)?;
        let picked = PickedFile::from_dialog(&path)?;
        let snapshot = service.registry()?.open_selected(window.label(), picked)?;
        Ok(Some(snapshot))
    })
    .await
}

#[tauri::command]
pub async fn file_read(window: WebviewWindow, file_id: String) -> Result<SelectedFileSnapshot> {
    in_workspace(window, move |window| {
        workbench(&window)?
            .workspace
            .registry()?
            .read_selected(window.label(), &file_id)
    })
    .await
}

#[tauri::command]
pub async fn file_write(
    window: WebviewWindow,
    file_id: String,
    expected_version: String,
    content: String,
) -> Result<String> {
    in_workspace(window, move |window| {
        workbench(&window)?.workspace.registry()?.write_selected(
            window.label(),
            &file_id,
            &expected_version,
            &content,
        )
    })
    .await
}

#[tauri::command]
pub async fn file_close(window: WebviewWindow, file_id: String) -> Result<()> {
    in_workspace(window, move |window| {
        workbench(&window)?
            .workspace
            .registry()?
            .close_selected(window.label(), &file_id)
    })
    .await
}

#[tauri::command]
pub async fn file_save_as(
    window: WebviewWindow,
    content: String,
    suggested_name: Option<String>,
) -> Result<Option<SelectedFileVersion>> {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};

    in_workspace(window, move |window| {
        validate_save_content(&content)?;
        let resources = workbench(&window)?;
        let service = &resources.workspace;
        let _picker = service.begin_picker()?;
        let mut dialog = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Save File As");
        // The optional renderer string is a display hint, never a path.
        if let Some(name) = suggested_name.filter(|name| {
            !name.is_empty()
                && name.len() <= 255
                && !name.ends_with(['.', ' '])
                && !name.contains(['/', '\\', ':', '<', '>', '"', '|', '?', '*'])
                && !name.chars().any(char::is_control)
        }) {
            dialog = dialog.set_file_name(name);
        }
        let Some(selection) = dialog.blocking_save_file() else {
            return Ok(None);
        };
        let path = selection
            .into_path()
            .map_err(|_| WorkspaceError::OutsideWorkspace)?;
        let picked = PickedFile::from_dialog(&path)?;
        let Some(approved) = picked.approve_save(|path| {
            window
                .dialog()
                .message(format!("Replace the existing file at {path}?"))
                .title("Confirm File Replacement")
                .parent(&window)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Replace".into(),
                    "Cancel".into(),
                ))
                .blocking_show()
        })?
        else {
            return Ok(None);
        };
        let saved = service
            .registry()?
            .save_selected(window.label(), approved, &content)?;
        Ok(Some(saved))
    })
    .await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DiscardAction {
    Tab,
    CloseAll,
    Reload,
    Workspace,
    Exit,
}

#[tauri::command]
pub async fn editor_confirm_discard(window: WebviewWindow, action: DiscardAction) -> Result<bool> {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};

    let message = match action {
        DiscardAction::Tab => "Discard the unsaved changes and close this tab?",
        DiscardAction::CloseAll => "Discard unsaved changes and close all editors?",
        DiscardAction::Reload => "Discard the unsaved changes and reload this file from disk?",
        DiscardAction::Workspace => "Discard the unsaved changes in this workspace?",
        DiscardAction::Exit => "Discard all unsaved changes and quit Turing Core?",
    };
    in_workspace(window, move |window| {
        Ok(window
            .dialog()
            .message(message)
            .title("Unsaved changes")
            .parent(&window)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Discard changes".into(),
                "Cancel".into(),
            ))
            .blocking_show())
    })
    .await
}

#[tauri::command]
pub fn editor_exit(window: WebviewWindow) -> Result<()> {
    workbench(&window)?;
    window.destroy().map_err(|_| WorkspaceError::IoError)
}

#[tauri::command]
pub async fn workspace_symbols_query(
    window: WebviewWindow,
    workspace_id: String,
    query: String,
    limit: usize,
) -> Result<crate::workspace::SymbolsResponse> {
    in_workspace(window, move |window| {
        workbench(&window)?.workspace.registry()?.query_symbols(
            window.label(),
            &workspace_id,
            &query,
            limit,
        )
    })
    .await
}

#[tauri::command]
pub fn workspace_search_begin(
    window: WebviewWindow,
    workspace_id: String,
    options: crate::workspace::SearchOptions,
) -> Result<String> {
    workbench(&window)?;
    workbench(&window)?
        .workspace
        .registry()?
        .begin_search(window.label(), &workspace_id, options)
}

#[tauri::command]
pub async fn workspace_search_run(
    window: WebviewWindow,
    workspace_id: String,
    search_id: String,
) -> Result<crate::workspace::SearchResponse> {
    workbench(&window)?;
    let task = workbench(&window)?.workspace.registry()?.claim_search(
        window.label(),
        &workspace_id,
        &search_id,
    )?;
    let result = tauri::async_runtime::spawn_blocking(move || task.run()).await;
    workbench(&window)?.workspace.registry()?.finish_search(
        window.label(),
        &workspace_id,
        &search_id,
    )?;
    result.map_err(|_| WorkspaceError::IoError)?
}

#[tauri::command]
pub fn workspace_search_cancel(
    window: WebviewWindow,
    workspace_id: String,
    search_id: String,
) -> Result<()> {
    workbench(&window)?;
    workbench(&window)?.workspace.registry()?.cancel_search(
        window.label(),
        &workspace_id,
        &search_id,
    )
}

#[tauri::command]
pub async fn workspace_create_file(
    window: WebviewWindow,
    workspace_id: String,
    parent: String,
    name: String,
) -> Result<TextFile> {
    in_workspace(window, move |window| {
        workbench(&window)?.workspace.registry()?.create_file(
            window.label(),
            &workspace_id,
            &parent,
            &name,
        )
    })
    .await
}

#[tauri::command]
pub async fn workspace_rename_entry(
    window: WebviewWindow,
    workspace_id: String,
    relative_path: String,
    name: String,
    expected_identity: String,
) -> Result<String> {
    in_workspace(window, move |window| {
        workbench(&window)?.workspace.registry()?.rename_entry(
            window.label(),
            &workspace_id,
            &relative_path,
            &name,
            &expected_identity,
        )
    })
    .await
}

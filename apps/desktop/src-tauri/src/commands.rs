use crate::workspace::{
    validate_save_content, DirectoryEntry, PickedFile, SelectedFileSnapshot, SelectedFileVersion,
    TextFile, WorkspaceDescriptor, WorkspaceError, WorkspaceService,
};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

type Result<T> = std::result::Result<T, WorkspaceError>;

async fn in_workspace<T, F>(window: WebviewWindow, operation: F) -> Result<T>
where
    T: Send + 'static,
    F: FnOnce(WebviewWindow) -> Result<T> + Send + 'static,
{
    if window.label() != "main" {
        return Err(WorkspaceError::PermissionDenied);
    }
    tauri::async_runtime::spawn_blocking(move || operation(window))
        .await
        .map_err(|_| WorkspaceError::IoError)?
}

#[tauri::command]
pub async fn workspace_open(window: WebviewWindow) -> Result<Option<WorkspaceDescriptor>> {
    in_workspace(window, |window| {
        let service = window.state::<WorkspaceService>();
        let _picker = service.begin_picker()?;
        let Some(selection) = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Open Workspace Folder")
            .blocking_pick_folder()
        else {
            return Ok(None);
        };
        let path = selection
            .into_path()
            .map_err(|_| WorkspaceError::OutsideWorkspace)?;
        let workspace = service.registry()?.register(window.label(), &path)?;
        Ok(Some(workspace))
    })
    .await
}

#[tauri::command]
pub async fn workspace_close(window: WebviewWindow, workspace_id: String) -> Result<()> {
    in_workspace(window, move |window| {
        window
            .state::<WorkspaceService>()
            .registry()?
            .close(window.label(), &workspace_id)
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
        window.state::<WorkspaceService>().registry()?.list(
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
        window.state::<WorkspaceService>().registry()?.read(
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
) -> Result<String> {
    in_workspace(window, move |window| {
        window.state::<WorkspaceService>().registry()?.write(
            window.label(),
            &workspace_id,
            &relative_path,
            &expected_version,
            &content,
        )
    })
    .await
}

#[tauri::command]
pub async fn file_open(window: WebviewWindow) -> Result<Option<SelectedFileSnapshot>> {
    in_workspace(window, |window| {
        let service = window.state::<WorkspaceService>();
        let _picker = service.begin_picker()?;
        let Some(selection) = window
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("Open File")
            .blocking_pick_file()
        else {
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
        window
            .state::<WorkspaceService>()
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
        window
            .state::<WorkspaceService>()
            .registry()?
            .write_selected(window.label(), &file_id, &expected_version, &content)
    })
    .await
}

#[tauri::command]
pub async fn file_close(window: WebviewWindow, file_id: String) -> Result<()> {
    in_workspace(window, move |window| {
        window
            .state::<WorkspaceService>()
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
        let service = window.state::<WorkspaceService>();
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
    Reload,
    Workspace,
    Exit,
}

#[tauri::command]
pub async fn editor_confirm_discard(window: WebviewWindow, action: DiscardAction) -> Result<bool> {
    use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};

    let message = match action {
        DiscardAction::Tab => "Discard the unsaved changes and close this tab?",
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
    if window.label() != "main" {
        return Err(WorkspaceError::PermissionDenied);
    }
    window.app_handle().exit(0);
    Ok(())
}

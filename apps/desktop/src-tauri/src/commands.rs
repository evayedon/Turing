use crate::workspace::{
    DirectoryEntry, TextFile, WorkspaceDescriptor, WorkspaceError, WorkspaceService,
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

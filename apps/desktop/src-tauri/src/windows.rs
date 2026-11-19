use crate::{
    execution::ExecutionService,
    terminal::TerminalService,
    workspace::{WorkspaceError, WorkspaceService},
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Workbench,
    Terminal,
}

pub struct Resources {
    pub kind: Kind,
    pub workspace: WorkspaceService,
    pub execution: ExecutionService,
    pub terminal: TerminalService,
}

impl Resources {
    fn new(kind: Kind, label: &str) -> Self {
        Self {
            kind,
            workspace: WorkspaceService::for_window(label),
            execution: ExecutionService::default(),
            terminal: TerminalService::default(),
        }
    }

    fn shutdown(&self) {
        self.execution.shutdown();
        self.terminal.shutdown();
        self.workspace.shutdown();
    }
}

pub struct Windows(Mutex<HashMap<String, Arc<Resources>>>);

impl Default for Windows {
    fn default() -> Self {
        Self(Mutex::new(HashMap::from([(
            "main".into(),
            Arc::new(Resources::new(Kind::Workbench, "main")),
        )])))
    }
}

impl Windows {
    fn register(&self, kind: Kind) -> Result<String, WorkspaceError> {
        let mut windows = self.0.lock().map_err(|_| WorkspaceError::IoError)?;
        if windows.len() >= 12 {
            return Err(WorkspaceError::WindowLimit);
        }
        let prefix = match kind {
            Kind::Workbench => "workbench",
            Kind::Terminal => "terminal",
        };
        let label = format!("{prefix}-{}", uuid::Uuid::new_v4());
        match windows.entry(label.clone()) {
            std::collections::hash_map::Entry::Occupied(_) => return Err(WorkspaceError::Busy),
            std::collections::hash_map::Entry::Vacant(slot) => {
                slot.insert(Arc::new(Resources::new(kind, &label)));
            }
        }
        Ok(label)
    }

    pub fn get(&self, label: &str) -> Option<Arc<Resources>> {
        self.0.lock().ok()?.get(label).cloned()
    }

    pub fn remove(&self, label: &str) {
        let resource = self
            .0
            .lock()
            .ok()
            .and_then(|mut windows| windows.remove(label));
        if let Some(resource) = resource {
            resource.shutdown();
        }
    }

    pub fn shutdown(&self) {
        let resources = self
            .0
            .lock()
            .ok()
            .map(|mut windows| std::mem::take(&mut *windows));
        if let Some(resources) = resources {
            for (_, resource) in resources {
                resource.shutdown();
            }
        }
    }
}

pub fn resource(window: &WebviewWindow) -> Result<Arc<Resources>, WorkspaceError> {
    window
        .state::<Windows>()
        .get(window.label())
        .ok_or(WorkspaceError::PermissionDenied)
}

pub fn workbench(window: &WebviewWindow) -> Result<Arc<Resources>, WorkspaceError> {
    let resources = resource(window)?;
    if resources.kind != Kind::Workbench {
        return Err(WorkspaceError::PermissionDenied);
    }
    Ok(resources)
}

fn build(window: WebviewWindow, kind: Kind) -> Result<(), WorkspaceError> {
    workbench(&window)?;
    let manager = window.app_handle();
    let windows = manager.state::<Windows>();
    let label = windows.register(kind)?;
    let (title, width, height, min_width, min_height) = match kind {
        Kind::Workbench => ("Turing Core", 1280., 800., 680., 480.),
        Kind::Terminal => ("Turing Terminal", 850., 560., 440., 300.),
    };
    if WebviewWindowBuilder::new(manager, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(min_width, min_height)
        .theme(Some(tauri::Theme::Dark))
        .build()
        .is_err()
    {
        windows.remove(&label);
        return Err(WorkspaceError::IoError);
    }
    Ok(())
}

// Async commands avoid the synchronous webview creation deadlock on Windows.
#[tauri::command]
pub async fn window_new_workbench(window: WebviewWindow) -> Result<(), WorkspaceError> {
    build(window, Kind::Workbench)
}

#[tauri::command]
pub async fn window_new_terminal(window: WebviewWindow) -> Result<(), WorkspaceError> {
    build(window, Kind::Terminal)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_registry_never_reuses_a_label_or_shares_workspace_grants() {
        let windows = Windows::default();
        let first = windows.register(Kind::Workbench).unwrap();
        let second = windows.register(Kind::Workbench).unwrap();
        let terminal = windows.register(Kind::Terminal).unwrap();
        assert_ne!(first, second);
        assert!(terminal.starts_with("terminal-"));
        let folder = tempfile::tempdir().unwrap();
        let first_resources = windows.get(&first).unwrap();
        let first_grant = first_resources
            .workspace
            .registry()
            .unwrap()
            .register(&first, folder.path())
            .unwrap();
        let second_resources = windows.get(&second).unwrap();
        let second_grant = second_resources
            .workspace
            .registry()
            .unwrap()
            .register(&second, folder.path())
            .unwrap();
        assert_ne!(first_grant.id, second_grant.id);
        assert!(first_resources
            .workspace
            .registry()
            .unwrap()
            .list(&first, &first_grant.id, "")
            .is_ok());
        assert!(matches!(
            second_resources
                .workspace
                .registry()
                .unwrap()
                .list(&second, &first_grant.id, ""),
            Err(WorkspaceError::PermissionDenied)
        ));
        let first_pty = first_resources
            .terminal
            .start(&first, portable_pty::PtySize::default(), None)
            .unwrap();
        let terminal_resources = windows.get(&terminal).unwrap();
        let terminal_pty = terminal_resources
            .terminal
            .start(&terminal, portable_pty::PtySize::default(), None)
            .unwrap();
        assert_ne!(first_pty.id, terminal_pty.id);
        windows.remove(&terminal);
        assert!(windows.get(&terminal).is_none());
        assert!(terminal_resources
            .terminal
            .start(&terminal, portable_pty::PtySize::default(), None)
            .is_err());
        windows.remove(&first);
        assert!(windows.get(&first).is_none());
        assert!(windows.get(&second).is_some());
        assert!(first_resources
            .workspace
            .registry()
            .unwrap()
            .list(&first, &first_grant.id, "")
            .is_err());
    }
}

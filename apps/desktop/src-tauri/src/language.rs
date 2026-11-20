mod framing;
mod process;
mod workspace_edit;

use crate::{
    windows::workbench,
    workspace::{relative_parts, Registry},
};
use process::Process;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Url, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const MAX_DOCUMENTS: usize = 24;
const MAX_PENDING: usize = 16;
const MAX_MESSAGES_PER_POLL: usize = 32;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Error {
    Denied,
    Unavailable,
    StartFailed,
    ServerExited,
    Busy,
    InvalidDocument,
    InvalidWorkspaceEdit,
    NotReady,
    Internal,
}
type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Feature {
    Hover,
    Completion,
    Definition,
    PrepareRename,
    Rename,
}

impl Feature {
    fn method(self) -> &'static str {
        match self {
            Self::Hover => "textDocument/hover",
            Self::Completion => "textDocument/completion",
            Self::Definition => "textDocument/definition",
            Self::PrepareRename => "textDocument/prepareRename",
            Self::Rename => "textDocument/rename",
        }
    }
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    hover: bool,
    completion: bool,
    definition: bool,
    prepare_rename: bool,
    rename: bool,
}

impl Capabilities {
    fn supports(self, feature: Feature) -> bool {
        match feature {
            Feature::Hover => self.hover,
            Feature::Completion => self.completion,
            Feature::Definition => self.definition,
            Feature::PrepareRename => self.prepare_rename,
            Feature::Rename => self.rename,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct Position {
    line: u32,
    character: u32,
}

#[derive(Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Sync {
        path: String,
        version: u32,
        text: String,
        saved: bool,
    },
    Close {
        path: String,
    },
    Request {
        path: String,
        version: u32,
        position: Position,
        feature: Feature,
        #[serde(skip_serializing_if = "Option::is_none")]
        new_name: Option<String>,
        request_id: u32,
    },
    Cancel {
        request_id: u32,
    },
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    Diagnostics {
        path: String,
        version: u32,
        diagnostics: Vec<Value>,
    },
    Response {
        request_id: u32,
        value: Value,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Update {
    capabilities: Option<Capabilities>,
    events: Vec<Event>,
}

struct Document {
    uri: String,
    base_version: String,
    text: String,
    version: u32,
}

struct Request {
    path: String,
    version: u32,
    feature: Feature,
    started: Instant,
    position: Position,
    revision: u64,
}

struct Session {
    id: String,
    workspace_id: String,
    process: Process,
    staging: tempfile::TempDir,
    documents: HashMap<String, Document>,
    neighbors: HashMap<String, workspace_edit::Snapshot>,
    pending: HashMap<u32, Request>,
    capabilities: Option<Capabilities>,
    last_version: u32,
    last_request: u32,
    revision: u64,
    started: Instant,
}

fn supported(path: &str) -> bool {
    Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "c" | "cc" | "cpp" | "cxx" | "h" | "hh" | "hpp" | "hxx"
            )
        })
}

fn executable() -> Result<PathBuf> {
    let name = if cfg!(windows) {
        "clangd.exe"
    } else {
        "clangd"
    };
    let path = std::env::var_os("PATH").unwrap_or_default();
    let platform = if cfg!(target_os = "macos") {
        vec![PathBuf::from("/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin"), "/Library/Developer/CommandLineTools/usr/bin".into(), "/opt/homebrew/opt/llvm/bin".into(), "/usr/local/opt/llvm/bin".into()]
    } else if cfg!(windows) {
        std::env::var_os("ProgramFiles")
            .map(|path| PathBuf::from(path).join("LLVM/bin"))
            .into_iter()
            .collect()
    } else {
        vec!["/usr/bin".into(), "/usr/local/bin".into()]
    };
    platform
        .into_iter()
        .chain(std::env::split_paths(&path))
        .filter(|dir| dir.is_absolute())
        .find_map(|dir| {
            let path = dir.join(name).canonicalize().ok()?;
            let metadata = path.metadata().ok()?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if metadata.permissions().mode() & 0o111 == 0 {
                    return None;
                }
            }
            (metadata.is_file() && path.is_absolute()).then_some(path)
        })
        .ok_or(Error::Unavailable)
}

fn fingerprint(path: &Path) -> Result<[u8; 32]> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|_| Error::Unavailable)?;
    let meta = file.metadata().map_err(|_| Error::Unavailable)?;
    if !meta.is_file() || meta.len() > 512 * 1024 * 1024 {
        return Err(Error::Unavailable);
    }
    let mut digest = Sha256::new();
    let bytes = std::io::copy(
        &mut std::io::Read::take(&mut file, meta.len() + 1),
        &mut digest,
    )
    .map_err(|_| Error::Unavailable)?;
    if bytes != meta.len() {
        return Err(Error::Unavailable);
    }
    Ok(digest.finalize().into())
}

fn same_uri(known: &str, received: &str) -> bool {
    known == received || (cfg!(windows) && known.eq_ignore_ascii_case(received))
}

fn notify(method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0", "method":method, "params":params})
}

fn did_open(path: &str, uri: &str, version: u32, text: &str) -> Value {
    notify(
        "textDocument/didOpen",
        json!({
            "textDocument":{"uri":uri,"version":version,"languageId":if path.to_ascii_lowercase().ends_with(".c") {"c"} else {"cpp"},"text":text}
        }),
    )
}

fn did_change(uri: &str, version: u32, text: &str) -> Value {
    notify(
        "textDocument/didChange",
        json!({
            "textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":text}]
        }),
    )
}

fn did_close(uri: &str) -> Value {
    notify("textDocument/didClose", json!({"textDocument":{"uri":uri}}))
}

impl Session {
    fn start(workspace_id: String, executable: &Path) -> Result<Self> {
        let staging = Self::staging()?;
        let process = Process::start(executable, staging.path())?;
        Self::begin(workspace_id, staging, process)
    }

    fn staging() -> Result<tempfile::TempDir> {
        let temp_root = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| Error::StartFailed)?;
        let mut builder = tempfile::Builder::new();
        builder.prefix("turing-clangd-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        builder
            .tempdir_in(temp_root)
            .map_err(|_| Error::StartFailed)
    }

    /// Sends `initialize` over an already connected transport. Capabilities
    /// are accepted later by `poll`; until then every action is `NotReady`.
    fn begin(workspace_id: String, staging: tempfile::TempDir, process: Process) -> Result<Self> {
        let root_uri = Url::from_directory_path(staging.path()).map_err(|_| Error::StartFailed)?;
        process.send(json!({
            "jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "processId":std::process::id(), "rootUri":root_uri.as_str(),
                "capabilities":{
                    "general":{"positionEncodings":["utf-16"]},
                    "workspace":{"workspaceEdit":{"documentChanges":true,"resourceOperations":[]}},
                    "textDocument":{
                        "publishDiagnostics":{"versionSupport":true},
                        "rename":{"prepareSupport":true},
                        "hover":{"contentFormat":["plaintext"]},
                        "completion":{"completionItem":{"snippetSupport":false}}
                    }
                }
            }
        }))?;
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            workspace_id,
            process,
            staging,
            documents: HashMap::new(),
            neighbors: HashMap::new(),
            pending: HashMap::new(),
            capabilities: None,
            last_version: 0,
            last_request: 2,
            revision: 0,
            started: Instant::now(),
        })
    }

    fn mirror(&self, path: &str) -> Result<(PathBuf, String)> {
        let parts = relative_parts(path).map_err(|_| Error::InvalidDocument)?;
        if !supported(path) || path.len() > 4096 || parts.len() > 32 {
            return Err(Error::InvalidDocument);
        }
        let file = self.staging.path().join(PathBuf::from_iter(parts));
        let uri = Url::from_file_path(&file).map_err(|_| Error::InvalidDocument)?;
        Ok((file, uri.to_string()))
    }

    fn apply(&mut self, registry: &Registry, owner: &str, action: Action) -> Result<()> {
        let capabilities = self.capabilities.ok_or(Error::NotReady)?;
        match action {
            Action::Sync {
                path,
                version,
                text,
                saved,
            } => {
                crate::workspace::validate_save_content(&text)
                    .map_err(|_| Error::InvalidDocument)?;
                if version <= self.last_version || version > i32::MAX as u32 {
                    return Err(Error::InvalidDocument);
                }
                if self.documents.len() >= MAX_DOCUMENTS && !self.documents.contains_key(&path) {
                    return Err(Error::Busy);
                }
                let (file, uri) = self.mirror(&path)?;
                if !self.documents.contains_key(&path)
                    && self
                        .documents
                        .keys()
                        .chain(self.neighbors.keys())
                        .any(|existing| {
                            existing != &path && existing.to_lowercase() == path.to_lowercase()
                        })
                {
                    return Err(Error::InvalidDocument);
                }
                let opened = self.documents.contains_key(&path);
                let base_version = if !opened || saved {
                    let disk = registry
                        .read(owner, &self.workspace_id, &path)
                        .map_err(|_| Error::InvalidDocument)?;
                    std::fs::create_dir_all(file.parent().ok_or(Error::InvalidDocument)?)
                        .map_err(|_| Error::Internal)?;
                    std::fs::write(file, &disk.content).map_err(|_| Error::Internal)?;
                    Some(disk.version)
                } else {
                    registry
                        .language_file(owner, &self.workspace_id, &path)
                        .map_err(|_| Error::InvalidDocument)?;
                    None
                };
                let mut messages = Vec::new();
                if opened {
                    messages.push(did_change(&uri, version, &text));
                } else {
                    if self.neighbors.contains_key(&path) {
                        messages.push(did_close(&uri));
                    }
                    messages.push(did_open(&path, &uri, version, &text));
                }
                if saved {
                    messages.push(notify(
                        "textDocument/didSave",
                        json!({"textDocument":{"uri":uri}}),
                    ));
                }
                self.process.batch(messages)?;
                self.neighbors.remove(&path);
                let base_version = base_version
                    .or_else(|| self.documents.remove(&path).map(|doc| doc.base_version))
                    .ok_or(Error::Internal)?;
                self.documents.insert(
                    path,
                    Document {
                        uri,
                        base_version,
                        version,
                        text,
                    },
                );
                self.last_version = version;
                self.revision += 1;
            }
            Action::Close { path } => {
                if let Some(doc) = self.documents.get(&path) {
                    self.process.send(did_close(&doc.uri))?;
                    self.documents.remove(&path);
                    self.revision += 1;
                    self.pending.retain(|_, req| req.path != path);
                    let _ = std::fs::remove_file(self.mirror(&path)?.0);
                }
            }
            Action::Request {
                path,
                version,
                position,
                feature,
                new_name,
                request_id,
            } => {
                if request_id <= self.last_request
                    || self.pending.len() >= MAX_PENDING
                    || self.pending.contains_key(&request_id)
                {
                    return Err(Error::Busy);
                }
                let doc = self
                    .documents
                    .get(&path)
                    .filter(|doc| doc.version == version)
                    .ok_or(Error::InvalidDocument)?;
                registry
                    .language_file(owner, &self.workspace_id, &path)
                    .map_err(|_| Error::InvalidDocument)?;
                if !capabilities.supports(feature) {
                    return Err(Error::NotReady);
                }
                let mut params = json!({"textDocument":{"uri":doc.uri},"position":position});
                match (feature, new_name) {
                    (Feature::Rename, Some(name))
                        if !name.is_empty()
                            && name.len() <= 256
                            && !name.chars().any(|ch| ch.is_control() || ch.is_whitespace()) =>
                    {
                        params["newName"] = json!(name);
                        self.stage_rename_neighbors(registry, owner, &path)?;
                    }
                    (Feature::Rename, _) | (_, Some(_)) => return Err(Error::InvalidDocument),
                    (Feature::PrepareRename, None) => {
                        self.stage_rename_neighbors(registry, owner, &path)?
                    }
                    _ => {}
                }
                self.process.send(json!({
                    "jsonrpc":"2.0","id":request_id,"method":feature.method(),"params":params
                }))?;
                self.last_request = request_id;
                self.pending.insert(
                    request_id,
                    Request {
                        path,
                        version,
                        feature,
                        position,
                        started: Instant::now(),
                        revision: self.revision,
                    },
                );
            }
            Action::Cancel { request_id } => {
                if self.pending.remove(&request_id).is_some() {
                    self.process
                        .send(notify("$/cancelRequest", json!({"id":request_id})))?;
                }
            }
        }
        Ok(())
    }

    fn poll(&mut self, registry: &Registry, owner: &str) -> Result<Update> {
        let mut events = Vec::new();
        if self.capabilities.is_none() && self.started.elapsed() > Duration::from_secs(8) {
            return Err(Error::StartFailed);
        }
        for _ in 0..MAX_MESSAGES_PER_POLL {
            let Some(message) = self.process.next()? else {
                break;
            };
            let id = message.get("id");
            let method = message.get("method").and_then(Value::as_str);
            if let (Some(id), Some(_)) = (id, method) {
                self.process.send(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Unsupported request"}}))?;
                continue;
            }
            if id.and_then(Value::as_u64) == Some(1) && self.capabilities.is_none() {
                let result = message
                    .pointer("/result/capabilities")
                    .ok_or(Error::StartFailed)?;
                let encoding = result
                    .get("positionEncoding")
                    .and_then(Value::as_str)
                    .unwrap_or("utf-16");
                if encoding != "utf-16" {
                    return Err(Error::StartFailed);
                }
                let supports = |feature: &str| {
                    result
                        .get(feature)
                        .is_some_and(|value| value == true || value.is_object())
                };
                self.process.send(notify("initialized", json!({})))?;
                self.capabilities = Some(Capabilities {
                    hover: supports("hoverProvider"),
                    completion: supports("completionProvider"),
                    definition: supports("definitionProvider"),
                    rename: supports("renameProvider"),
                    prepare_rename: result.pointer("/renameProvider/prepareProvider")
                        == Some(&Value::Bool(true)),
                });
            } else if method == Some("textDocument/publishDiagnostics") {
                if let Some((event, path)) = self.diagnostics(&message["params"]) {
                    if registry
                        .language_file(owner, &self.workspace_id, path)
                        .is_ok()
                    {
                        events.push(event);
                    }
                }
            } else if let Some(request_id) = id
                .and_then(Value::as_u64)
                .and_then(|id| u32::try_from(id).ok())
            {
                if let Some(req) = self.pending.remove(&request_id) {
                    let current = req.revision == self.revision
                        && self
                            .documents
                            .get(&req.path)
                            .is_some_and(|doc| doc.version == req.version);
                    let value = if !current
                        || registry
                            .language_file(owner, &self.workspace_id, &req.path)
                            .is_err()
                    {
                        Value::Null
                    } else if matches!(req.feature, Feature::Definition) {
                        self.definitions(&message["result"], registry, owner)
                    } else if matches!(req.feature, Feature::Rename | Feature::PrepareRename) {
                        let result = &message["result"];
                        if result.is_null() {
                            Value::Null
                        } else if matches!(req.feature, Feature::Rename) {
                            match self.workspace_edit(result, registry, owner) {
                                Ok(files) => json!(workspace_edit::Preview { files }),
                                Err(error) => json!(workspace_edit::Failure { error }),
                            }
                        } else {
                            match workspace_edit::prepare(
                                result,
                                &self.documents[&req.path].text,
                                req.position,
                            ) {
                                Ok(placeholder) => json!(workspace_edit::Prepared { placeholder }),
                                Err(error) => json!(workspace_edit::Failure { error }),
                            }
                        }
                    } else {
                        message.get("result").cloned().unwrap_or(Value::Null)
                    };
                    events.push(Event::Response { request_id, value });
                }
            }
        }
        let expired: Vec<u32> = self
            .pending
            .iter()
            .filter(|(_, request)| request.started.elapsed() >= REQUEST_TIMEOUT)
            .map(|(id, _)| *id)
            .collect();
        for request_id in expired {
            self.pending.remove(&request_id);
            // Best effort: the server may stop work it no longer owes.
            let _ = self
                .process
                .send(notify("$/cancelRequest", json!({"id":request_id})));
        }
        Ok(Update {
            capabilities: self.capabilities,
            events,
        })
    }

    fn diagnostics(&self, params: &Value) -> Option<(Event, &str)> {
        let uri = params.get("uri")?.as_str()?;
        let version = u32::try_from(params.get("version")?.as_u64()?).ok()?;
        let (path, _) = self
            .documents
            .iter()
            .find(|(_, doc)| same_uri(&doc.uri, uri) && doc.version == version)?;
        Some((
            Event::Diagnostics {
                path: path.clone(),
                version,
                diagnostics: params
                    .get("diagnostics")?
                    .as_array()?
                    .iter()
                    .take(200)
                    .cloned()
                    .collect(),
            },
            path,
        ))
    }

    fn definitions(&self, result: &Value, registry: &Registry, owner: &str) -> Value {
        let entries = result
            .as_array()
            .map_or_else(|| std::slice::from_ref(result), Vec::as_slice);
        Value::Array(
            entries
                .iter()
                .take(40)
                .filter_map(|item| {
                    let uri = item
                        .get("targetUri")
                        .or_else(|| item.get("uri"))?
                        .as_str()?;
                    let (path, _) = self
                        .documents
                        .iter()
                        .find(|(_, doc)| same_uri(&doc.uri, uri))?;
                    registry
                        .language_file(owner, &self.workspace_id, path)
                        .ok()?;
                    let range = item
                        .get("targetSelectionRange")
                        .or_else(|| item.get("range"))?;
                    Some(json!({"path":path,"range":range}))
                })
                .collect(),
        )
    }
}

#[derive(Default)]
struct State {
    destroyed: bool,
    session: Option<Session>,
}

#[derive(Default)]
pub struct LanguageService {
    state: Mutex<State>,
    approval: Mutex<()>,
}

impl LanguageService {
    pub fn revoke(&self, destroy: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.destroyed |= destroy;
            state.session.take();
        }
    }
}

async fn blocking<T: Send + 'static>(
    call: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(call)
        .await
        .map_err(|_| Error::Internal)?
}

#[tauri::command]
pub async fn language_start(window: WebviewWindow, workspace_id: String) -> Result<Option<String>> {
    blocking(move || {
        let resources = workbench(&window).map_err(|_| Error::Denied)?;
        let service = &resources.language;
        let _approval = service.approval.try_lock().map_err(|_| Error::Busy)?;
        resources.workspace.registry().map_err(|_| Error::Denied)?.authorize(window.label(), &workspace_id).map_err(|_| Error::Denied)?;
        let path = executable()?;
        let identity = fingerprint(&path)?;
        let approved = window.dialog().message(format!(
            "Start clangd for this workspace? The tool runs with your OS privileges and receives the contents of supported files you open and may read copies of nearby C/C++ files when you use Rename Symbol.\n\n{}",
            path.display()
        )).title("Enable C/C++ Language Intelligence")
            .parent(&window)
            .buttons(MessageDialogButtons::OkCancel).blocking_show();
        if !approved {
            return Ok(None);
        }
        if identity != fingerprint(&path)? {
            return Err(Error::StartFailed);
        }
        let registry = resources.workspace.registry().map_err(|_| Error::Denied)?;
        registry.authorize(window.label(), &workspace_id).map_err(|_| Error::Denied)?;
        let mut state = service.state.lock().map_err(|_| Error::Internal)?;
        if state.destroyed {
            return Err(Error::Denied);
        }
        let session = Session::start(workspace_id, &path)?;
        let id = session.id.clone();
        state.session = Some(session);
        Ok(Some(id))
    }).await
}

fn with_session<T>(
    window: &WebviewWindow,
    workspace_id: &str,
    session_id: &str,
    run: impl FnOnce(&mut Session, &Registry) -> Result<T>,
) -> Result<T> {
    let resources = workbench(window).map_err(|_| Error::Denied)?;
    let registry = resources.workspace.registry().map_err(|_| Error::Denied)?;
    registry
        .authorize(window.label(), workspace_id)
        .map_err(|_| Error::Denied)?;
    let mut state = resources
        .language
        .state
        .lock()
        .map_err(|_| Error::Internal)?;
    let session = state
        .session
        .as_mut()
        .filter(|session| session.workspace_id == workspace_id && session.id == session_id)
        .ok_or(Error::Denied)?;
    let result = run(session, &registry);
    if matches!(result, Err(Error::ServerExited | Error::StartFailed)) {
        state.session.take();
    }
    result
}

#[tauri::command]
pub async fn language_apply(
    window: WebviewWindow,
    workspace_id: String,
    session_id: String,
    action: Action,
) -> Result<()> {
    blocking(move || {
        with_session(&window, &workspace_id, &session_id, |session, registry| {
            session.apply(registry, window.label(), action)
        })
    })
    .await
}

#[tauri::command]
pub async fn language_poll(
    window: WebviewWindow,
    workspace_id: String,
    session_id: String,
) -> Result<Update> {
    blocking(move || {
        with_session(&window, &workspace_id, &session_id, |session, registry| {
            session.poll(registry, window.label())
        })
    })
    .await
}

#[tauri::command]
pub async fn language_stop(
    window: WebviewWindow,
    workspace_id: String,
    session_id: String,
) -> Result<()> {
    blocking(move || {
        let resources = workbench(&window).map_err(|_| Error::Denied)?;
        let session = {
            let mut state = resources
                .language
                .state
                .lock()
                .map_err(|_| Error::Internal)?;
            if !state.session.as_ref().is_some_and(|session| {
                session.workspace_id == workspace_id && session.id == session_id
            }) {
                return Err(Error::Denied);
            }
            state.session.take()
        };
        if let Some(mut session) = session {
            session.process.shutdown();
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    fn wait(
        session: &mut Session,
        registry: &Registry,
        predicate: impl Fn(&Update) -> bool,
    ) -> Update {
        let deadline = Instant::now() + Duration::from_secs(6);
        loop {
            let value = session.poll(registry, "owner").unwrap();
            if predicate(&value) {
                return value;
            }
            assert!(Instant::now() < deadline, "clangd integration deadline");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    #[ignore = "requires a trusted installed clangd selected via TURING_TEST_CLANGD"]
    fn installed_clangd_renames_across_an_open_source_and_unopened_header() {
        let executable =
            PathBuf::from(std::env::var_os("TURING_TEST_CLANGD").expect("clangd path"));
        let root = tempfile::tempdir().unwrap();
        let source = "#include \"helper.hpp\"\nint main() { return item; }\n";
        std::fs::write(root.path().join("hello.cpp"), source).unwrap();
        std::fs::write(root.path().join("helper.hpp"), "inline int item = 4;\n").unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register("owner", root.path()).unwrap();
        let mut session = Session::start(workspace.id, &executable).unwrap();
        wait(&mut session, &registry, |update| {
            update.capabilities.is_some()
        });
        session
            .apply(
                &registry,
                "owner",
                Action::Sync {
                    path: "hello.cpp".into(),
                    version: 1,
                    text: source.into(),
                    saved: false,
                },
            )
            .unwrap();
        wait(&mut session, &registry, |update| {
            update
                .events
                .iter()
                .any(|event| matches!(event, Event::Diagnostics { version: 1, .. }))
        });
        for (request_id, feature, new_name) in [
            (3, Feature::PrepareRename, None),
            (4, Feature::Rename, Some("renamed".into())),
        ] {
            session
                .apply(
                    &registry,
                    "owner",
                    Action::Request {
                        path: "hello.cpp".into(),
                        version: 1,
                        position: Position {
                            line: 1,
                            character: 20,
                        },
                        feature,
                        new_name,
                        request_id,
                    },
                )
                .unwrap();
            let update = wait(&mut session, &registry, |update| {
                update.events.iter().any(|event| matches!(event, Event::Response { request_id: id, .. } if *id == request_id))
            });
            let value = update
                .events
                .into_iter()
                .find_map(|event| match event {
                    Event::Response {
                        request_id: id,
                        value,
                    } if id == request_id => Some(value),
                    _ => None,
                })
                .unwrap();
            if request_id == 3 {
                assert_eq!(value, json!({"placeholder":"item"}));
            } else {
                assert_eq!(
                    value.pointer("/files/0/path"),
                    Some(&json!("hello.cpp")),
                    "{value}"
                );
                assert_eq!(
                    value.pointer("/files/1/path"),
                    Some(&json!("helper.hpp")),
                    "{value}"
                );
                assert_eq!(
                    value.pointer("/files/1/documentVersion"),
                    Some(&Value::Null)
                );
            }
        }
    }

    #[test]
    #[ignore = "requires a trusted installed clangd selected via TURING_TEST_CLANGD"]
    fn installed_clangd_syncs_diagnostics_and_answers_a_definition() {
        let executable =
            PathBuf::from(std::env::var_os("TURING_TEST_CLANGD").expect("clangd path"));
        let root = tempfile::tempdir().unwrap();
        std::fs::write(
            root.path().join("hello.cpp"),
            "int answer = 42;\nint main() { return answer; }\n",
        )
        .unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register("owner", root.path()).unwrap();
        let mut session = Session::start(workspace.id, &executable).unwrap();
        let capabilities = wait(&mut session, &registry, |update| {
            update.capabilities.is_some()
        })
        .capabilities
        .unwrap();
        assert!(capabilities.hover && capabilities.completion && capabilities.definition);
        let sync = |version, text: &str, saved| Action::Sync {
            path: "hello.cpp".into(),
            version,
            text: text.into(),
            saved,
        };
        assert_eq!(
            session.apply(&registry, "other", sync(1, "", false)),
            Err(Error::InvalidDocument)
        );
        assert!(session.mirror("../secret.cpp").is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(
                root.path().join("hello.cpp"),
                root.path().join("alias.cpp"),
            )
            .unwrap();
            assert_eq!(
                session.apply(
                    &registry,
                    "owner",
                    Action::Sync {
                        path: "alias.cpp".into(),
                        version: 1,
                        text: "int x;".into(),
                        saved: false,
                    }
                ),
                Err(Error::InvalidDocument)
            );
        }
        session
            .apply(
                &registry,
                "owner",
                sync(1, "int main() { return missing; }", false),
            )
            .unwrap();
        wait(&mut session, &registry, |update| {
            update.events.iter().any(|event| {
                matches!(event,
                    Event::Diagnostics { version:1, diagnostics, .. } if !diagnostics.is_empty()
                )
            })
        });
        session
            .apply(
                &registry,
                "owner",
                sync(2, "int answer = 42;\nint main() { return answer; }\n", true),
            )
            .unwrap();
        wait(&mut session, &registry, |update| {
            update.events.iter().any(|event| {
                matches!(event,
                    Event::Diagnostics { version:2, diagnostics, .. } if diagnostics.is_empty()
                )
            })
        });
        let uri = session.documents["hello.cpp"].uri.clone();
        assert!(session
            .diagnostics(&json!({"uri":uri,"version":1,"diagnostics":[]}))
            .is_none());
        assert!(session
            .diagnostics(&json!({"uri":uri,"diagnostics":[]}))
            .is_none());
        for (request_id, feature, position) in [
            (
                3,
                Feature::Definition,
                Position {
                    line: 1,
                    character: 21,
                },
            ),
            (
                4,
                Feature::Hover,
                Position {
                    line: 1,
                    character: 21,
                },
            ),
            (
                5,
                Feature::Completion,
                Position {
                    line: 1,
                    character: 22,
                },
            ),
        ] {
            session
                .apply(
                    &registry,
                    "owner",
                    Action::Request {
                        path: "hello.cpp".into(),
                        version: 2,
                        position,
                        feature,
                        new_name: None,
                        request_id,
                    },
                )
                .unwrap();
            wait(&mut session, &registry, |update| {
                update.events.iter().any(|event| matches!(event,
                Event::Response { request_id:id, value } if *id == request_id &&
                    if id == &3 { value.pointer("/0/path").and_then(Value::as_str) == Some("hello.cpp") } else { !value.is_null() }
            ))
            });
        }
        session
            .apply(
                &registry,
                "owner",
                Action::Request {
                    path: "hello.cpp".into(),
                    version: 2,
                    position: Position {
                        line: 1,
                        character: 21,
                    },
                    feature: Feature::Hover,
                    new_name: None,
                    request_id: 6,
                },
            )
            .unwrap();
        session
            .apply(&registry, "owner", Action::Cancel { request_id: 6 })
            .unwrap();
        assert!(!session.pending.contains_key(&6));
        session
            .apply(
                &registry,
                "owner",
                Action::Close {
                    path: "hello.cpp".into(),
                },
            )
            .unwrap();
        assert!(session.documents.is_empty());
        let header = "int headerValue = 4;\n";
        let source = "#include \"other header.hpp\"\nint main() { return headerValue; }\n";
        std::fs::write(root.path().join("other header.hpp"), header).unwrap();
        session
            .apply(
                &registry,
                "owner",
                Action::Sync {
                    path: "other header.hpp".into(),
                    version: 3,
                    text: header.into(),
                    saved: false,
                },
            )
            .unwrap();
        session
            .apply(&registry, "owner", sync(4, source, false))
            .unwrap();
        wait(&mut session, &registry, |update| {
            update.events.iter().any(|event| {
                matches!(event,
                    Event::Diagnostics {version:4, diagnostics, ..} if diagnostics.is_empty()
                )
            })
        });
        session
            .apply(
                &registry,
                "owner",
                Action::Request {
                    path: "hello.cpp".into(),
                    version: 4,
                    position: Position {
                        line: 1,
                        character: 24,
                    },
                    feature: Feature::Definition,
                    new_name: None,
                    request_id: 7,
                },
            )
            .unwrap();
        wait(&mut session, &registry, |update| {
            update.events.iter().any(|event| matches!(event,
            Event::Response {request_id:7,value} if value.pointer("/0/path").and_then(Value::as_str) == Some("other header.hpp")
        ))
        });
        let bad = json!({"uri":"file:///outside.hpp","range":{"start":{"line":0,"character":0},"end":{"line":0,"character":1}}});
        assert_eq!(session.definitions(&bad, &registry, "owner"), json!([]));
        assert_eq!(
            session.process.shutdown(),
            super::process::Shutdown::Graceful
        );
    }
}

#[cfg(test)]
mod lifecycle_tests {
    //! Deterministic LSP lifecycle coverage against a scripted server over
    //! real OS pipes, so every platform's default suite exercises
    //! initialize, document sync, cancellation and shutdown.
    use super::process::{Process, Shutdown};
    use super::*;
    use std::{
        io::BufReader,
        sync::{Arc, Mutex as StdMutex},
        thread,
    };

    #[derive(Clone, Copy, Default)]
    struct Script {
        encoding: Option<&'static str>,
        server_request: bool,
        hold_hover: bool,
        flood: usize,
        ignore_shutdown: bool,
        shutdown_delay: Duration,
        reject_shutdown: bool,
        linger_after_exit: bool,
        crash_on_open: bool,
        rename: bool,
        rename_without_prepare: bool,
    }

    type Log = Arc<StdMutex<Vec<Value>>>;

    fn reply(id: &Value, result: Value) -> Value {
        json!({"jsonrpc":"2.0","id":id,"result":result})
    }

    fn serve(
        script: Script,
        input: std::io::PipeReader,
        mut output: std::io::PipeWriter,
        log: Log,
    ) {
        let mut input = BufReader::new(input);
        let mut send = |message: Value| framing::write(&mut output, &message).is_ok();
        while let Ok(message) = framing::read(&mut input) {
            log.lock().unwrap().push(message.clone());
            let id = message.get("id").cloned().unwrap_or(Value::Null);
            let params = &message["params"];
            match message.get("method").and_then(Value::as_str) {
                Some("initialize") => {
                    let mut capabilities = json!({
                        "hoverProvider": true,
                        "completionProvider": {},
                        "definitionProvider": true,
                    });
                    if script.rename {
                        capabilities["renameProvider"] = if script.rename_without_prepare {
                            json!(true)
                        } else {
                            json!({"prepareProvider": true})
                        };
                    }
                    if let Some(encoding) = script.encoding {
                        capabilities["positionEncoding"] = json!(encoding);
                    }
                    send(reply(&id, json!({ "capabilities": capabilities })));
                    if script.server_request {
                        send(
                            json!({"jsonrpc":"2.0","id":"s1","method":"workspace/applyEdit","params":{"edit":{"changes":{}}}}),
                        );
                    }
                    for index in 0..script.flood {
                        send(
                            json!({"jsonrpc":"2.0","method":"window/logMessage","params":{"type":4,"message":format!("burst {index}")}}),
                        );
                    }
                }
                Some("textDocument/didOpen" | "textDocument/didChange") => {
                    if script.crash_on_open {
                        return;
                    }
                    let document = &params["textDocument"];
                    let version = document["version"].as_u64().unwrap();
                    for stale in [version.saturating_sub(1), version] {
                        send(
                            json!({"jsonrpc":"2.0","method":"textDocument/publishDiagnostics","params":{
                                "uri": document["uri"], "version": stale,
                                "diagnostics": [{"message": format!("v{stale}")}],
                            }}),
                        );
                    }
                }
                Some("textDocument/hover") if script.hold_hover => {}
                Some("textDocument/hover" | "textDocument/completion") => {
                    send(reply(&id, json!({"contents": "answer"})));
                }
                Some("textDocument/definition") => {
                    send(reply(
                        &id,
                        json!([{"uri": params["textDocument"]["uri"], "range": {"start":{"line":0,"character":4},"end":{"line":0,"character":10}}}]),
                    ));
                }
                Some("textDocument/prepareRename") => {
                    send(reply(
                        &id,
                        json!({
                            "range":{"start":{"line":0,"character":4},"end":{"line":0,"character":8}},
                            "placeholder": "main"
                        }),
                    ));
                }
                Some("textDocument/rename") => {
                    let uri = params["textDocument"]["uri"].as_str().unwrap();
                    let neighbor = uri.replace("hello.cpp", "helper.hpp");
                    let edit = json!({
                        "range":{"start":{"line":0,"character":4},"end":{"line":0,"character":8}},
                        "newText": params["newName"]
                    });
                    send(reply(
                        &id,
                        json!({"documentChanges":[
                            {"textDocument":{"uri":uri,"version":1},"edits":[edit]},
                            {"textDocument":{"uri":neighbor,"version":null},"edits":[edit]}
                        ]}),
                    ));
                }
                Some("$/cancelRequest") => {
                    // A late, cancelled reply that the client must ignore.
                    send(
                        json!({"jsonrpc":"2.0","id":params["id"],"error":{"code":-32800,"message":"cancelled"}}),
                    );
                    send(reply(&params["id"], json!({"contents": "too late"})));
                }
                Some("shutdown") if !script.ignore_shutdown => {
                    thread::sleep(script.shutdown_delay);
                    if script.reject_shutdown {
                        send(
                            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32603,"message":"failed"}}),
                        );
                    } else {
                        send(reply(&id, Value::Null));
                    }
                }
                Some("exit") if script.linger_after_exit => {
                    thread::sleep(Duration::from_secs(4));
                    return;
                }
                _ => {}
            }
        }
    }

    fn connect(script: Script) -> (Process, Log) {
        let (server_input, client_output) = std::io::pipe().unwrap();
        let (client_input, server_output) = std::io::pipe().unwrap();
        let log = Log::default();
        let server_log = log.clone();
        thread::spawn(move || serve(script, server_input, server_output, server_log));
        (Process::connect(client_output, client_input).unwrap(), log)
    }

    struct Fixture {
        _root: tempfile::TempDir,
        registry: Registry,
        session: Session,
        log: Log,
    }

    fn fixture(script: Script) -> Fixture {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("hello.cpp"), "int main() {}\n").unwrap();
        let mut registry = Registry::default();
        let workspace = registry.register("owner", root.path()).unwrap();
        let (process, log) = connect(script);
        let session = Session::begin(workspace.id, Session::staging().unwrap(), process).unwrap();
        Fixture {
            _root: root,
            registry,
            session,
            log,
        }
    }

    impl Fixture {
        fn poll(&mut self) -> Result<Update> {
            self.session.poll(&self.registry, "owner")
        }

        /// Polls until `found` matches an update, failing after a deadline.
        fn until(&mut self, mut found: impl FnMut(&Update) -> bool) -> Update {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let update = self.poll().expect("session stays alive");
                if found(&update) {
                    return update;
                }
                assert!(Instant::now() < deadline, "lifecycle deadline");
                thread::sleep(Duration::from_millis(5));
            }
        }

        fn ready(&mut self) -> Capabilities {
            self.until(|update| update.capabilities.is_some())
                .capabilities
                .unwrap()
        }

        fn apply(&mut self, action: Action) -> Result<()> {
            self.session.apply(&self.registry, "owner", action)
        }

        fn sync(&mut self, version: u32, saved: bool) -> Result<()> {
            self.apply(Action::Sync {
                path: "hello.cpp".into(),
                version,
                text: format!("int main() {{ return {version}; }}\n"),
                saved,
            })
        }

        fn request(&mut self, request_id: u32, version: u32, feature: Feature) -> Result<()> {
            self.apply(Action::Request {
                path: "hello.cpp".into(),
                version,
                position: Position {
                    line: 0,
                    character: 4,
                },
                feature,
                new_name: None,
                request_id,
            })
        }

        /// Methods the server received, in order. Client replies to
        /// server requests carry no method and are left out.
        fn methods(&self) -> Vec<String> {
            self.log
                .lock()
                .unwrap()
                .iter()
                .filter_map(|message| message.get("method")?.as_str().map(String::from))
                .collect()
        }

        fn received(&self, matches: impl Fn(&Value) -> bool) -> bool {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if self.log.lock().unwrap().iter().any(&matches) {
                    return true;
                }
                if Instant::now() >= deadline {
                    return false;
                }
                thread::sleep(Duration::from_millis(5));
            }
        }
    }

    fn response(update: &Update, id: u32) -> Option<&Value> {
        update.events.iter().find_map(|event| match event {
            Event::Response { request_id, value } if *request_id == id => Some(value),
            _ => None,
        })
    }

    fn diagnostic_versions(update: &Update) -> Vec<u32> {
        update
            .events
            .iter()
            .filter_map(|event| match event {
                Event::Diagnostics { version, .. } => Some(*version),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn prepares_and_renames_open_and_neighboring_files_without_writing_them() {
        let mut test = fixture(Script {
            rename: true,
            ..Script::default()
        });
        std::fs::write(test._root.path().join("helper.hpp"), "int main();\n").unwrap();
        let caps = test.ready();
        assert!(caps.rename && caps.prepare_rename);
        assert!(test.received(|message| {
            message.pointer("/params/capabilities/workspace/workspaceEdit")
                == Some(&json!({"documentChanges":true,"resourceOperations":[]}))
                && message.pointer("/params/capabilities/textDocument/rename/prepareSupport")
                    == Some(&json!(true))
        }));
        test.sync(1, false).unwrap();
        test.request(3, 1, Feature::PrepareRename).unwrap();
        let prepared = test.until(|update| response(update, 3).is_some());
        assert!(test.received(|message| {
            message["method"] == "textDocument/didOpen"
                && message["params"]["textDocument"]["uri"]
                    .as_str()
                    .is_some_and(|uri| uri.ends_with("/helper.hpp"))
        }));
        assert_eq!(response(&prepared, 3), Some(&json!({"placeholder":"main"})));

        // If a neighboring file changes after staging, the original version
        // still accompanies the edit and the renderer can report the conflict.
        let base = test
            .registry
            .read("owner", &test.session.workspace_id, "helper.hpp")
            .unwrap()
            .version;
        test.apply(Action::Request {
            path: "hello.cpp".into(),
            version: 1,
            position: Position {
                line: 0,
                character: 4,
            },
            feature: Feature::Rename,
            new_name: Some("other".into()),
            request_id: 4,
        })
        .unwrap();
        std::fs::write(test._root.path().join("helper.hpp"), "int changed();\n").unwrap();
        let renamed = test.until(|update| response(update, 4).is_some());
        let files = response(&renamed, 4).unwrap()["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(files[0]["path"], "hello.cpp");
        assert_eq!(files[0]["documentVersion"], 1);
        assert_eq!(files[1]["path"], "helper.hpp");
        assert_eq!(files[1]["documentVersion"], Value::Null);
        assert_eq!(files[1]["baseVersion"], base);
        assert_eq!(files[1]["edits"][0]["before"], "main");
        assert_eq!(files[1]["edits"][0]["after"], "other");
        assert_eq!(
            std::fs::read_to_string(test._root.path().join("helper.hpp")).unwrap(),
            "int changed();\n"
        );
    }

    #[test]
    fn rename_does_not_imply_prepare_support() {
        let mut test = fixture(Script {
            rename: true,
            rename_without_prepare: true,
            ..Script::default()
        });
        let caps = test.ready();
        assert!(caps.rename && !caps.prepare_rename);
        test.sync(1, false).unwrap();
        assert_eq!(
            test.request(3, 1, Feature::PrepareRename),
            Err(Error::NotReady)
        );
    }

    #[test]
    fn rejects_unmapped_traversal_unauthorized_and_resource_edit_targets() {
        let mut test = fixture(Script::default());
        test.ready();
        test.sync(1, false).unwrap();
        let uri = &test.session.documents["hello.cpp"].uri;
        let edit = test_edit(0, 4, 8, "name");
        let validate = |value: &Value, owner| {
            test.session
                .workspace_edit(value, &test.registry, owner)
                .is_ok()
        };
        for target in [
            "file:///elsewhere/hello.cpp".into(),
            uri.replace("hello.cpp", "unknown.cpp"),
            uri.replace("hello.cpp", "../hello.cpp"),
            uri.replace("hello.cpp", "%2e%2e/hello.cpp"),
            format!("{uri}?alternate"),
            "https://localhost/hello.cpp".into(),
        ] {
            assert!(
                !validate(&json!({"changes":{(target.as_str()):[edit]}}), "owner"),
                "{target}"
            );
        }
        let changes = json!({"changes":{uri:[edit]}});
        assert!(validate(&changes, "owner"));
        assert!(!validate(&changes, "other"));
        assert!(!validate(
            &json!({"documentChanges":[{"kind":"delete","uri":uri}]}),
            "owner"
        ));
        assert!(!validate(
            &json!({"documentChanges":[{"textDocument":{"uri":uri,"version":2},"edits":[edit]}]}),
            "owner"
        ));
        assert!(!validate(
            &json!({"documentChanges":[
                {"textDocument":{"uri":uri,"version":1},"edits":[edit]},
                {"textDocument":{"uri":uri,"version":null},"edits":[edit]}
            ]}),
            "owner"
        ));
        std::fs::remove_file(test._root.path().join("hello.cpp")).unwrap();
        assert!(!validate(&changes, "owner"));
        #[cfg(unix)]
        {
            let outside = tempfile::tempdir().unwrap();
            let outside_file = outside.path().join("hello.cpp");
            std::fs::write(&outside_file, "int outside;").unwrap();
            std::os::unix::fs::symlink(outside_file, test._root.path().join("hello.cpp")).unwrap();
            assert!(!validate(&changes, "owner"));
        }
    }

    fn test_edit(line: u32, start: u32, end: u32, new_text: &str) -> Value {
        json!({
            "range": {
                "start":{"line":line,"character":start},
                "end":{"line":line,"character":end}
            },
            "newText":new_text
        })
    }

    #[test]
    fn validates_utf16_ranges_overlap_and_edit_budgets() {
        let mut test = fixture(Script::default());
        test.ready();
        test.apply(Action::Sync {
            path: "hello.cpp".into(),
            version: 1,
            text: "a💡 b\r\nend\rnext\n".into(),
            saved: false,
        })
        .unwrap();
        let uri = &test.session.documents["hello.cpp"].uri;
        let validate = |value: &Value| test.session.workspace_edit(value, &test.registry, "owner");
        let edit = test_edit(0, 1, 3, "z");
        let result =
            json!(validate(&json!({"changes":{uri:[test_edit(1,0,3,"fin"),edit]}})).unwrap());
        assert_eq!(result.pointer("/0/edits/0/before"), Some(&json!("💡")));
        assert_eq!(result.pointer("/0/edits/1/start"), Some(&json!(7)));
        for edits in [
            vec![test_edit(0, 2, 3, "split surrogate")],
            vec![test_edit(0, 1, 6, "past line")],
            vec![test_edit(4, 0, 0, "past file")],
            vec![test_edit(0, 3, 1, "reversed")],
            vec![edit.clone(), test_edit(0, 1, 4, "overlap")],
            vec![edit.clone(); 513],
            vec![test_edit(0, 0, 1, &"x".repeat(256 * 1024))],
        ] {
            assert!(validate(&json!({"changes":{uri:edits}})).is_err());
        }
        let too_many_files: serde_json::Map<String, Value> = (0..25)
            .map(|i| (format!("{uri}{i}"), json!([edit])))
            .collect();
        assert!(validate(&json!({"changes":too_many_files})).is_err());
    }

    #[test]
    fn server_initializes_syncs_cancels_and_shuts_down() {
        let mut test = fixture(Script {
            server_request: true,
            hold_hover: true,
            ..Script::default()
        });

        // Initialize: nothing is accepted until capabilities are negotiated.
        assert_eq!(test.sync(1, false), Err(Error::NotReady));
        let capabilities = test.ready();
        assert!(capabilities.hover && capabilities.completion && capabilities.definition);
        let initialize = test.log.lock().unwrap()[0].clone();
        assert_eq!(initialize["method"], "initialize");
        assert_eq!(
            initialize.pointer("/params/capabilities/general/positionEncodings"),
            Some(&json!(["utf-16"]))
        );
        assert!(test.received(|message| message["method"] == "initialized"));
        // Server-initiated requests are refused rather than forwarded.
        assert!(test.received(|message| {
            message["id"] == "s1" && message.pointer("/error/code") == Some(&json!(-32601))
        }));

        // Sync: open, then change and save; only current versions surface.
        test.sync(1, false).unwrap();
        let first = test.until(|update| !diagnostic_versions(update).is_empty());
        assert_eq!(diagnostic_versions(&first), vec![1]);
        assert!(test.session.staging.path().join("hello.cpp").is_file());
        test.sync(2, true).unwrap();
        let second = test.until(|update| !diagnostic_versions(update).is_empty());
        assert_eq!(diagnostic_versions(&second), vec![2]);
        assert_eq!(test.sync(2, false), Err(Error::InvalidDocument));
        assert_eq!(
            test.request(3, 1, Feature::Hover),
            Err(Error::InvalidDocument)
        );

        // Cancel: the server is told, and its late replies are dropped.
        test.request(3, 2, Feature::Hover).unwrap();
        test.apply(Action::Cancel { request_id: 3 }).unwrap();
        assert!(test.received(|message| {
            message["method"] == "$/cancelRequest" && message["params"]["id"] == 3
        }));
        test.request(4, 2, Feature::Completion).unwrap();
        let answered = test.until(|update| response(update, 4).is_some());
        assert_eq!(response(&answered, 4), Some(&json!({"contents": "answer"})));
        assert!(response(&answered, 3).is_none());
        for _ in 0..10 {
            assert!(response(&test.poll().unwrap(), 3).is_none());
        }

        // Responses for a request made before an edit are withheld.
        test.request(5, 2, Feature::Definition).unwrap();
        test.sync(3, false).unwrap();
        let stale = test.until(|update| response(update, 5).is_some());
        assert_eq!(response(&stale, 5), Some(&Value::Null));

        // Expired requests are cancelled on the server too.
        test.request(6, 3, Feature::Hover).unwrap();
        test.session.pending.get_mut(&6).unwrap().started =
            Instant::now().checked_sub(REQUEST_TIMEOUT).unwrap();
        test.poll().unwrap();
        assert!(!test.session.pending.contains_key(&6));
        assert!(test.received(|message| {
            message["method"] == "$/cancelRequest" && message["params"]["id"] == 6
        }));

        // Close removes the document and its mirror.
        test.apply(Action::Close {
            path: "hello.cpp".into(),
        })
        .unwrap();
        assert!(test.session.documents.is_empty());
        assert!(!test.session.staging.path().join("hello.cpp").exists());

        // Shutdown: request, reply, exit, and the server closes its output.
        assert_eq!(test.session.process.shutdown(), Shutdown::Graceful);
        assert_eq!(
            test.methods(),
            [
                "initialize",
                "initialized",
                "textDocument/didOpen",
                "textDocument/didChange",
                "textDocument/didSave",
                "textDocument/hover",
                "$/cancelRequest",
                "textDocument/completion",
                "textDocument/definition",
                "textDocument/didChange",
                "textDocument/hover",
                "$/cancelRequest",
                "textDocument/didClose",
                "shutdown",
                "exit",
            ]
        );
    }

    #[test]
    fn shutdown_drains_document_activity_and_waits_for_a_delayed_reply() {
        let mut test = fixture(Script {
            shutdown_delay: Duration::from_millis(100),
            ..Script::default()
        });
        test.ready();
        for version in 1..=7 {
            test.sync(version, false).unwrap();
        }
        assert_eq!(test.session.process.shutdown(), Shutdown::Graceful);
        let methods = test.methods();
        assert_eq!(
            &methods[methods.len() - 3..],
            ["textDocument/didChange", "shutdown", "exit"]
        );
    }

    #[test]
    fn shutdown_rejects_an_error_response_without_sending_exit() {
        let mut test = fixture(Script {
            reject_shutdown: true,
            ..Script::default()
        });
        test.ready();
        assert_eq!(test.session.process.shutdown(), Shutdown::Rejected);
        assert_eq!(test.methods().last().map(String::as_str), Some("shutdown"));
    }

    #[test]
    fn shutdown_reports_servers_that_do_not_cooperate() {
        let mut silent = fixture(Script {
            ignore_shutdown: true,
            ..Script::default()
        });
        silent.ready();
        assert_eq!(silent.session.process.shutdown(), Shutdown::NoReply);

        let mut lingering = fixture(Script {
            linger_after_exit: true,
            ..Script::default()
        });
        lingering.ready();
        assert_eq!(lingering.session.process.shutdown(), Shutdown::NoExit);
        assert!(lingering.received(|message| message["method"] == "exit"));
    }

    #[test]
    fn a_crashed_server_ends_the_session() {
        let mut test = fixture(Script {
            crash_on_open: true,
            ..Script::default()
        });
        test.ready();
        test.sync(1, false).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let error = loop {
            match test.poll() {
                Err(error) => break error,
                Ok(_) => assert!(Instant::now() < deadline, "crash not reported"),
            }
            thread::sleep(Duration::from_millis(5));
        };
        assert_eq!(error, Error::ServerExited);
        assert_eq!(test.session.process.shutdown(), Shutdown::AlreadyExited);
    }

    #[test]
    fn servers_without_utf16_positions_are_rejected() {
        let mut test = fixture(Script {
            encoding: Some("utf-8"),
            ..Script::default()
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match test.poll() {
                Err(error) => {
                    assert_eq!(error, Error::StartFailed);
                    break;
                }
                Ok(update) => assert!(update.capabilities.is_none()),
            }
            assert!(Instant::now() < deadline, "encoding was not rejected");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn message_bursts_apply_backpressure_without_ending_the_session() {
        // Far more than the 16-message inbound queue between polls.
        let mut test = fixture(Script {
            flood: 400,
            ..Script::default()
        });
        thread::sleep(Duration::from_millis(100));
        test.ready();
        test.sync(1, false).unwrap();
        let update = test.until(|update| !diagnostic_versions(update).is_empty());
        assert_eq!(diagnostic_versions(&update), vec![1]);
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    #[test]
    fn only_the_current_authorized_workbench_can_use_language_paths() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("main.cpp"), "int main() {}").unwrap();
        let mut registry = Registry::default();
        let grant = registry.register("main", root.path()).unwrap();
        assert!(registry
            .language_file("main", &grant.id, "main.cpp")
            .is_ok());
        assert!(registry
            .language_file("main", &grant.id, "../main.cpp")
            .is_err());
        assert!(registry
            .language_file("other", &grant.id, "main.cpp")
            .is_err());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path().join("main.cpp"), root.path().join("alias.cpp"))
                .unwrap();
            assert!(registry
                .language_file("main", &grant.id, "alias.cpp")
                .is_err());
        }
        registry.close("main", &grant.id).unwrap();
        assert!(registry
            .language_file("main", &grant.id, "main.cpp")
            .is_err());

        let config: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let capabilities = config
            .pointer("/app/security/capabilities")
            .unwrap()
            .as_array()
            .unwrap();
        for capability in capabilities {
            let permissions = capability["permissions"].as_array().unwrap();
            assert_eq!(
                permissions
                    .iter()
                    .any(|permission| permission == "allow-managed-clangd"),
                capability["identifier"] == "workspace-editor"
            );
        }
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use crate::contract_fixtures as fixture;
    use serde_json::json;

    #[test]
    fn error_codes_match_contract() {
        use Error::*;
        let all = [
            Denied,
            Unavailable,
            StartFailed,
            ServerExited,
            Busy,
            InvalidDocument,
            InvalidWorkspaceEdit,
            NotReady,
            Internal,
        ];
        for error in &all {
            match error {
                Denied | Unavailable | StartFailed | ServerExited | Busy | InvalidDocument
                | InvalidWorkspaceEdit | NotReady | Internal => {}
            }
        }
        fixture::assert_error_codes("language", &all);
    }

    #[test]
    fn rename_matches_contract() {
        for (index, (feature, new_name)) in [
            (Feature::PrepareRename, None),
            (Feature::Rename, Some("renamed".to_owned())),
        ]
        .into_iter()
        .enumerate()
        {
            let action = Action::Request {
                path: "src/main.cpp".into(),
                version: 4,
                position: Position {
                    line: 0,
                    character: 4,
                },
                feature,
                new_name,
                request_id: 7,
            };
            fixture::assert_payload("RenameAction", index, &action);
            assert!(serde_json::from_value::<Action>(json!(action)).is_ok());
        }
        fixture::assert_case_count("RenameAction", 2);
        fixture::assert_payload(
            "PrepareRename",
            0,
            &workspace_edit::Prepared {
                placeholder: "item".into(),
            },
        );
        fixture::assert_case_count("PrepareRename", 1);
        fixture::assert_payload(
            "WorkspaceEditFailure",
            0,
            &workspace_edit::Failure {
                error: Error::InvalidWorkspaceEdit,
            },
        );
        fixture::assert_case_count("WorkspaceEditFailure", 1);
        workspace_edit::assert_preview_contract();
    }

    #[test]
    fn update_matches_contract() {
        fixture::assert_payload(
            "LanguageUpdate",
            0,
            &Update {
                capabilities: Some(Capabilities {
                    hover: true,
                    completion: true,
                    definition: false,
                    rename: true,
                    prepare_rename: true,
                }),
                events: vec![
                    Event::Diagnostics {
                        path: "src/main.cpp".into(),
                        version: 4,
                        diagnostics: vec![json!({ "message": "unused variable" })],
                    },
                    Event::Response {
                        request_id: 7,
                        value: Value::Null,
                    },
                ],
            },
        );
        fixture::assert_payload(
            "LanguageUpdate",
            1,
            &Update {
                capabilities: None,
                events: Vec::new(),
            },
        );
        fixture::assert_case_count("LanguageUpdate", 2);
    }
}

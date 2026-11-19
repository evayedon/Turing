mod framing;
mod process;

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Error {
    Denied,
    Unavailable,
    StartFailed,
    ServerExited,
    Busy,
    InvalidDocument,
    NotReady,
    Internal,
}
type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Feature {
    Hover,
    Completion,
    Definition,
}

impl Feature {
    fn method(self) -> &'static str {
        match self {
            Self::Hover => "textDocument/hover",
            Self::Completion => "textDocument/completion",
            Self::Definition => "textDocument/definition",
        }
    }
}

#[derive(Clone, Copy, Default, Serialize)]
pub struct Capabilities {
    hover: bool,
    completion: bool,
    definition: bool,
}

impl Capabilities {
    fn supports(self, feature: Feature) -> bool {
        match feature {
            Feature::Hover => self.hover,
            Feature::Completion => self.completion,
            Feature::Definition => self.definition,
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct Position {
    line: u32,
    character: u32,
}

#[derive(Deserialize)]
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
    version: u32,
}

struct Request {
    path: String,
    version: u32,
    feature: Feature,
    started: Instant,
    revision: u64,
}

struct Session {
    id: String,
    workspace_id: String,
    process: Process,
    staging: tempfile::TempDir,
    documents: HashMap<String, Document>,
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

impl Session {
    fn start(workspace_id: String, executable: &Path) -> Result<Self> {
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
        let staging = builder
            .tempdir_in(temp_root)
            .map_err(|_| Error::StartFailed)?;
        let root_uri = Url::from_directory_path(staging.path()).map_err(|_| Error::StartFailed)?;
        let process = Process::start(executable, staging.path())?;
        process.send(json!({
            "jsonrpc":"2.0","id":1,"method":"initialize","params":{
                "processId":std::process::id(), "rootUri":root_uri.as_str(),
                "capabilities":{
                    "general":{"positionEncodings":["utf-16"]},
                    "textDocument":{
                        "publishDiagnostics":{"versionSupport":true},
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
                        .any(|existing| existing.to_lowercase() == path.to_lowercase())
                {
                    return Err(Error::InvalidDocument);
                }
                let opened = self.documents.contains_key(&path);
                if !opened || saved {
                    let (disk, _, _) = registry
                        .execution_snapshot(owner, &self.workspace_id, &path)
                        .map_err(|_| Error::InvalidDocument)?;
                    std::fs::create_dir_all(file.parent().ok_or(Error::InvalidDocument)?)
                        .map_err(|_| Error::Internal)?;
                    std::fs::write(file, disk).map_err(|_| Error::Internal)?;
                } else {
                    registry
                        .language_file(owner, &self.workspace_id, &path)
                        .map_err(|_| Error::InvalidDocument)?;
                }
                let change = if opened {
                    notify(
                        "textDocument/didChange",
                        json!({
                            "textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":text}]
                        }),
                    )
                } else {
                    notify(
                        "textDocument/didOpen",
                        json!({
                            "textDocument":{"uri":uri,"version":version,"languageId":if path.to_ascii_lowercase().ends_with(".c") {"c"} else {"cpp"},"text":text}
                        }),
                    )
                };
                let mut messages = vec![change];
                if saved {
                    messages.push(notify(
                        "textDocument/didSave",
                        json!({"textDocument":{"uri":uri}}),
                    ));
                }
                self.process.batch(messages)?;
                self.documents.insert(path, Document { uri, version });
                self.last_version = version;
                self.revision += 1;
            }
            Action::Close { path } => {
                if let Some(doc) = self.documents.get(&path) {
                    self.process.send(notify(
                        "textDocument/didClose",
                        json!({"textDocument":{"uri":doc.uri}}),
                    ))?;
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
                self.process.send(json!({
                    "jsonrpc":"2.0","id":request_id,"method":feature.method(),
                    "params":{"textDocument":{"uri":doc.uri},"position":position}
                }))?;
                self.last_request = request_id;
                self.pending.insert(
                    request_id,
                    Request {
                        path,
                        version,
                        feature,
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
        for _ in 0..8 {
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
                    } else {
                        message.get("result").cloned().unwrap_or(Value::Null)
                    };
                    events.push(Event::Response { request_id, value });
                }
            }
        }
        self.pending
            .retain(|_, request| request.started.elapsed() < Duration::from_secs(10));
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
            "Start clangd for this workspace? The tool runs with your OS privileges and receives the contents of supported files you open.\n\n{}",
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
        session.process.shutdown();
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
            NotReady,
            Internal,
        ];
        for error in &all {
            match error {
                Denied | Unavailable | StartFailed | ServerExited | Busy | InvalidDocument
                | NotReady | Internal => {}
            }
        }
        fixture::assert_error_codes("language", &all);
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

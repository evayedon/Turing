//! Opt-in workloads driven through the regular workspace, Monaco and PTY paths.

use super::{
    drive, instrument, memory, ms, wait_until, Probe as SmokeProbe, ENABLE_ENV, POLL, STEP_TIMEOUT,
};
use crate::terminal::{self, Profile};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex, time::Instant};
use tauri::{AppHandle, Builder, Context, Manager, WebviewWindow, WebviewWindowBuilder, Wry};

pub const EDITOR_SCRIPT: &str = include_str!("perf-agent.js");
const EDITOR_TITLE: &str = "__turing_perf__";
const TYPING_TEXT: &str = "quick brown fox jumps over the lazy dog";
const PTY_LINE: &str = "0123456789abcdef0123456789abcdef";
const PTY_LINES: usize = 200_000;

#[derive(Default)]
pub struct Probe {
    editor: Mutex<Option<EditorRun>>,
}

struct EditorRun {
    label: String,
    fixture: tempfile::TempDir,
    result: Option<Result<EditorTiming, String>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorTiming {
    large_file_open_ms: f64,
    typing_burst_ms: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum EditorMessage {
    Result(EditorTiming),
    Error(String),
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalTiming {
    start_ms: f64,
    output_ms: f64,
    payload_bytes: usize,
    payload_bytes_per_second: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capture {
    main_ready_ms: f64,
    startup_rss_bytes: Option<u64>,
    pub after_open_rss_bytes: Option<u64>,
    pub after_close_rss_bytes: Option<u64>,
    editor: Option<EditorTiming>,
    terminal: Option<TerminalTiming>,
}

impl Capture {
    pub fn new(main_ready_ms: f64) -> Self {
        Self {
            main_ready_ms,
            startup_rss_bytes: memory::resident(),
            after_open_rss_bytes: None,
            after_close_rss_bytes: None,
            editor: None,
            terminal: None,
        }
    }
}

pub fn enabled() -> bool {
    [ENABLE_ENV, "TURING_PERF"]
        .into_iter()
        .all(|key| std::env::var_os(key).is_some_and(|value| value == "1"))
}

pub fn configure_perf(
    builder: Builder<Wry>,
    context: &mut Context<Wry>,
    started: Instant,
) -> Builder<Wry> {
    if !enabled() {
        return builder;
    }
    // Install the same readiness script and title callback on the configured
    // main window before navigation begins.
    let main = context
        .config_mut()
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
        .expect("performance harness requires a configured main window");
    main.create = false;
    let main = main.clone();
    let mut probe = SmokeProbe::new(started);
    probe.perf = Some(Probe::default());
    builder.manage(probe).setup(move |app| {
        let handle = app.handle().clone();
        instrument(
            &handle,
            WebviewWindowBuilder::from_config(&handle, &main)?,
            "main",
        )
        .build()?;
        std::thread::Builder::new()
            .name("turing-perf".into())
            .spawn(move || drive(handle, started))?;
        Ok(())
    })
}

/// Substitutes the picker only for the one harness workbench and only with a
/// Rust-created directory. Frontend paths cannot affect the selection.
pub fn fixture_for(window: &WebviewWindow) -> Option<PathBuf> {
    let probe = window.try_state::<SmokeProbe>()?;
    let editor = probe.perf.as_ref()?.editor.lock().ok()?;
    let run = editor.as_ref()?;
    (run.label == window.label()).then(|| run.fixture.path().to_owned())
}

impl Probe {
    pub fn record(&self, label: &str, title: &str) {
        let Some(payload) = title.strip_prefix(EDITOR_TITLE) else {
            return;
        };
        let Ok(mut editor) = self.editor.lock() else {
            return;
        };
        if let Some(run) = editor.as_mut().filter(|run| run.label == label) {
            run.result.get_or_insert_with(|| {
                match serde_json::from_str::<EditorMessage>(payload) {
                    Ok(EditorMessage::Result(result)) => Ok(result),
                    Ok(EditorMessage::Error(error)) => Err(error),
                    Err(error) => Err(format!("invalid editor result: {error}")),
                }
            });
        }
    }

    pub fn exercise(
        &self,
        app: &AppHandle,
        editor_label: &str,
        terminal_label: &str,
        capture: &mut Capture,
    ) -> Result<(), String> {
        let terminal = app
            .get_webview_window(terminal_label)
            .ok_or("missing terminal window")?;
        capture.terminal = Some(tauri::async_runtime::block_on(terminal_task(terminal))?);

        let editor = app
            .get_webview_window(editor_label)
            .ok_or("missing editor window")?;
        let fixture = tempfile::tempdir().map_err(|error| error.to_string())?;
        let typing_path = fixture.path().join("typing.txt");
        std::fs::write(&typing_path, "").map_err(|error| error.to_string())?;
        std::fs::write(
            fixture.path().join("large.txt"),
            "Turing large document 0123456789\n".repeat(40_000),
        )
        .map_err(|error| error.to_string())?;
        let mut run = self.editor.lock().map_err(|_| "editor lock poisoned")?;
        *run = Some(EditorRun {
            label: editor_label.to_owned(),
            fixture,
            result: None,
        });
        drop(run);
        editor.set_focus().map_err(|error| error.to_string())?;
        editor
            .eval("window.dispatchEvent(new Event('turing-perf-editor'))")
            .map_err(|error| error.to_string())?;
        wait_until(
            "editor workload",
            Instant::now() + STEP_TIMEOUT,
            || {
                self.editor
                    .lock()
                    .is_ok_and(|run| run.as_ref().is_some_and(|run| run.result.is_some()))
            },
            || {},
        )?;
        let mut run = self.editor.lock().map_err(|_| "editor lock poisoned")?;
        capture.editor = Some(
            run.as_mut()
                .and_then(|run| run.result.take())
                .ok_or("missing editor result")??,
        );
        let actual = std::fs::read_to_string(typing_path).map_err(|error| error.to_string())?;
        if actual != [TYPING_TEXT; 4].join(" ") {
            return Err("saved typing fixture differs from the scripted burst".into());
        }
        Ok(())
    }
}

async fn terminal_task(window: WebviewWindow) -> Result<TerminalTiming, String> {
    let (profile, ready, workload) = if cfg!(windows) {
        (
            Profile::PowerShell,
            "[Console]::WriteLine('Turing'+'PtyReady')\r",
            "$s=('0123456789abcdef'*2)+[char]13+[char]10; [Console]::Write($s*200000); exit 0\r",
        )
    } else {
        (
            Profile::Sh,
            "printf '%s%s\\n' Turing PtyReady\r",
            "yes '0123456789abcdef''0123456789abcdef' | head -n 200000; exit 0\r",
        )
    };
    let started = Instant::now();
    let id = terminal::terminal_start(window.clone(), None, Some(profile), None, 24, 120)
        .await
        .map_err(|error| format!("PTY start: {error:?}"))?
        .id;
    #[cfg(unix)]
    send(&window, &id, ready.as_bytes()).await?;
    #[cfg(windows)]
    let mut ready_sent = false;
    #[cfg(windows)]
    let mut query_offsets = [0; terminal::CONPTY_QUERIES.len()];
    let mut bytes = Vec::new();
    loop {
        let output = read(&window, &id).await?;
        bytes.extend(output.bytes);
        #[cfg(windows)]
        {
            // This measurement session has no xterm frontend to answer ConPTY's
            // startup queries. Reply before entering the probe command.
            for ((query, reply), offset) in
                terminal::CONPTY_QUERIES.into_iter().zip(&mut query_offsets)
            {
                while let Some(index) = bytes[*offset..]
                    .windows(query.len())
                    .position(|chunk| chunk == query)
                {
                    *offset += index + query.len();
                    send(&window, &id, reply).await?;
                }
                *offset = (*offset).max(bytes.len().saturating_sub(query.len() - 1));
            }
            if !ready_sent
                && !bytes.is_empty()
                && !output.finished
                && !terminal::CONPTY_QUERIES
                    .iter()
                    .any(|(query, _)| (1..query.len()).any(|len| bytes.ends_with(&query[..len])))
            {
                send(&window, &id, ready.as_bytes()).await?;
                ready_sent = true;
            }
        }
        if bytes
            .windows(b"TuringPtyReady".len())
            .any(|chunk| chunk == b"TuringPtyReady")
        {
            break;
        }
        if output.finished || started.elapsed() >= STEP_TIMEOUT || bytes.len() > 1024 * 1024 {
            return Err("PTY did not print the readiness marker".into());
        }
        std::thread::sleep(POLL);
    }
    let start_ms = ms(started.elapsed());
    let started = Instant::now();
    send(&window, &id, workload.as_bytes()).await?;
    let payload_bytes = PTY_LINE.len() * PTY_LINES;
    let mut all_output_at = None;
    let mut payload = Payload::default();
    loop {
        let output = read(&window, &id).await?;
        payload.push(&output.bytes);
        if payload.lines >= PTY_LINES {
            all_output_at.get_or_insert_with(|| started.elapsed());
        }
        if output.finished {
            if output.exit_code != Some(0) || payload.lines != PTY_LINES {
                return Err(format!(
                    "PTY workload returned {:?} and {}/{PTY_LINES} payload lines",
                    output.exit_code, payload.lines,
                ));
            }
            break;
        }
        if started.elapsed() >= STEP_TIMEOUT {
            return Err(format!(
                "PTY workload timed out after {} payload lines",
                payload.lines
            ));
        }
        if output.bytes.is_empty() {
            std::thread::sleep(POLL);
        }
    }
    let duration = all_output_at.ok_or("missing PTY output timing")?;
    Ok(TerminalTiming {
        start_ms,
        output_ms: ms(duration),
        payload_bytes,
        payload_bytes_per_second: payload_bytes as f64 / duration.as_secs_f64(),
    })
}

// Match the payload independently of the PTY's line endings, control
// sequences and read boundaries. The shell command assembles the payload
// in pieces so its input echo cannot match.
#[derive(Default)]
struct Payload {
    tail: Vec<u8>,
    lines: usize,
}

impl Payload {
    fn push(&mut self, chunk: &[u8]) {
        self.tail.extend_from_slice(chunk);
        let marker = PTY_LINE.as_bytes();
        let mut offset = 0;
        while let Some(index) = self.tail[offset..]
            .windows(marker.len())
            .position(|window| window == marker)
        {
            self.lines += 1;
            offset += index + marker.len();
        }
        offset = offset.max(self.tail.len().saturating_sub(marker.len() - 1));
        self.tail.drain(..offset);
    }
}

async fn send(window: &WebviewWindow, id: &str, command: &[u8]) -> Result<(), String> {
    terminal::terminal_input(window.clone(), id.into(), command.to_vec())
        .await
        .map_err(|error| format!("PTY input: {error:?}"))
}

async fn read(window: &WebviewWindow, id: &str) -> Result<terminal::TerminalOutput, String> {
    terminal::terminal_read(window.clone(), id.into())
        .await
        .map_err(|error| format!("PTY read: {error:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_counts_complete_markers_once_across_reads() {
        let (left, right) = PTY_LINE.split_at(16);
        let mut payload = Payload::default();
        payload.push(format!("command '{left}''{right}'\r\n{left}").as_bytes());
        assert_eq!(payload.lines, 0);
        payload.push(format!("{right}\r\n\x1b[0m{PTY_LINE}\n{left}").as_bytes());
        assert_eq!(payload.lines, 2);
        payload.push(right.as_bytes());
        assert_eq!(payload.lines, 3);
        assert!(payload.tail.len() < PTY_LINE.len());
    }

    #[test]
    fn editor_probe_accepts_only_the_first_result_from_its_window() {
        let probe = Probe::default();
        *probe.editor.lock().unwrap() = Some(EditorRun {
            label: "workbench-fixture".into(),
            fixture: tempfile::tempdir().unwrap(),
            result: None,
        });
        let title = r#"__turing_perf__{"result":{"largeFileOpenMs":42,"typingBurstMs":5}}"#;
        probe.record("main", title);
        probe.record("workbench-fixture", "Turing Core");
        assert!(probe
            .editor
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .result
            .is_none());
        probe.record("workbench-fixture", title);
        probe.record("workbench-fixture", "__turing_perf__malformed");
        let mut editor = probe.editor.lock().unwrap();
        let result = editor.as_mut().unwrap().result.take().unwrap().unwrap();
        assert_eq!(result.large_file_open_ms, 42.);
        assert_eq!(result.typing_burst_ms, 5.);
    }
}

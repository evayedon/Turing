//! Native lifecycle smoke harness.
//!
//! Compiled only with the non-default `smoke` cargo feature and active only
//! when the process starts with `TURING_SMOKE=1`. It drives the real window
//! lifecycle from Rust: it opens two workbench and two terminal windows through
//! [`windows::build`], waits for each page to load and its frontend to mount,
//! waits for each terminal window's frontend to start a PTY through the normal
//! IPC path, closes every window through its normal close flow, verifies that
//! the per-window resources were released, prints a JSON summary and exits.

#[cfg(feature = "perf")]
mod memory;
#[cfg(feature = "perf")]
mod perf;
#[cfg(feature = "perf")]
pub use perf::{configure_perf, fixture_for};

use crate::windows::{self, Kind, Windows};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{
    webview::PageLoadEvent, AppHandle, Builder, Manager, Webview, WebviewWindowBuilder, Wry,
};

const ENABLE_ENV: &str = "TURING_SMOKE";
const OUTPUT_ENV: &str = "TURING_SMOKE_OUTPUT";
const TIMEOUT_ENV: &str = "TURING_SMOKE_TIMEOUT_SECS";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(180);
const STEP_TIMEOUT: Duration = Duration::from_secs(60);
const CLOSE_RETRY: Duration = Duration::from_secs(2);
const POLL: Duration = Duration::from_millis(10);
const EXIT_GRACE: Duration = Duration::from_secs(20);
const PLAN: [Kind; 4] = [
    Kind::Workbench,
    Kind::Workbench,
    Kind::Terminal,
    Kind::Terminal,
];

/// The document title the readiness script sets once the frontend mounted.
const READY_TITLE: &str = "__turing_smoke_ready__";

/// Injected only into smoke-mode windows. It sets a sentinel title once React
/// has rendered into `#root`; Rust observes it through the title handler, so
/// no IPC command or capability is needed.
const READY_SCRIPT: &str = r#"(function () {
  if (window.top !== window) return;
  var signalled = false;
  function mounted() {
    var root = document.getElementById("root");
    return !!root && root.childElementCount > 0;
  }
  function signal() {
    if (signalled) return;
    signalled = true;
    setTimeout(function () { document.title = "__turing_smoke_ready__"; }, 0);
  }
  function watch() {
    if (mounted()) return signal();
    var observer = new MutationObserver(function () {
      if (mounted()) { observer.disconnect(); signal(); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", watch, { once: true });
  } else {
    watch();
  }
})();"#;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mark {
    PageLoaded,
    Ready,
}

#[derive(Clone, Copy, Default)]
struct Marks {
    page_loaded: Option<Instant>,
    ready: Option<Instant>,
}

impl Marks {
    fn get(&self, mark: Mark) -> Option<Instant> {
        match mark {
            Mark::PageLoaded => self.page_loaded,
            Mark::Ready => self.ready,
        }
    }
}

/// Records lifecycle milestones per window label. Only managed in smoke mode.
pub struct Probe {
    started: Instant,
    marks: Mutex<HashMap<String, Marks>>,
    changed: Condvar,
    #[cfg(feature = "perf")]
    perf: Option<perf::Probe>,
}

impl Probe {
    fn new(started: Instant) -> Self {
        Self {
            started,
            marks: Mutex::default(),
            changed: Condvar::new(),
            #[cfg(feature = "perf")]
            perf: None,
        }
    }

    /// Keeps the first occurrence so a later reload cannot rewrite timings.
    fn record(&self, label: &str, mark: Mark) {
        let Ok(mut marks) = self.marks.lock() else {
            return;
        };
        let entry = marks.entry(label.to_owned()).or_default();
        let slot = match mark {
            Mark::PageLoaded => &mut entry.page_loaded,
            Mark::Ready => &mut entry.ready,
        };
        slot.get_or_insert_with(Instant::now);
        drop(marks);
        self.changed.notify_all();
    }

    fn wait(&self, label: &str, mark: Mark, deadline: Instant) -> Result<Instant, String> {
        let mut marks = self
            .marks
            .lock()
            .map_err(|_| "probe lock poisoned".to_owned())?;
        loop {
            if let Some(at) = marks.get(label).and_then(|marks| marks.get(mark)) {
                return Ok(at);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(format!("timed out waiting for {mark:?} in window {label}"));
            }
            marks = self
                .changed
                .wait_timeout(marks, deadline - now)
                .map_err(|_| "probe lock poisoned".to_owned())?
                .0;
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowTiming {
    kind: &'static str,
    label: String,
    open_to_page_loaded_ms: f64,
    open_to_ready_ms: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    ready_to_pty_ms: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    close_ms: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    harness: &'static str,
    schema: u32,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    os: &'static str,
    arch: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    main_page_loaded_ms: Option<f64>,
    windows: Vec<WindowTiming>,
    #[cfg(feature = "perf")]
    #[serde(skip_serializing_if = "Option::is_none")]
    perf: Option<perf::Capture>,
    total_ms: f64,
}

impl Summary {
    fn new() -> Self {
        Self {
            harness: "turing-native-lifecycle-smoke",
            schema: 1,
            status: "running",
            error: None,
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            main_page_loaded_ms: None,
            windows: Vec::new(),
            #[cfg(feature = "perf")]
            perf: None,
            total_ms: 0.,
        }
    }

    fn finish(&mut self, result: Result<(), String>, elapsed: Duration) -> i32 {
        self.total_ms = ms(elapsed);
        match result {
            Ok(()) => {
                self.status = "passed";
                0
            }
            Err(error) => {
                self.status = "failed";
                self.error = Some(error);
                1
            }
        }
    }

    fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| {
            r#"{"harness":"turing-native-lifecycle-smoke","status":"failed","error":"summary serialization failed"}"#.to_owned()
        })
    }
}

fn ms(duration: Duration) -> f64 {
    (duration.as_secs_f64() * 10_000.).round() / 10.
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Workbench => "workbench",
        Kind::Terminal => "terminal",
    }
}

/// Polls `done` until it holds; `retry` runs every [`CLOSE_RETRY`] meanwhile.
fn wait_until(
    what: &str,
    deadline: Instant,
    mut done: impl FnMut() -> bool,
    mut retry: impl FnMut(),
) -> Result<Instant, String> {
    let mut next_retry = Instant::now() + CLOSE_RETRY;
    loop {
        if done() {
            return Ok(Instant::now());
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(format!("timed out waiting for {what}"));
        }
        if now >= next_retry {
            retry();
            next_retry = now + CLOSE_RETRY;
        }
        thread::sleep(POLL.min(deadline - now));
    }
}

fn timeout() -> Duration {
    std::env::var(TIMEOUT_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|seconds| *seconds > 0)
        .map_or(DEFAULT_TIMEOUT, Duration::from_secs)
}

fn emit(json: &str) {
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{json}");
    let _ = stdout.flush();
    if let Some(path) = std::env::var_os(OUTPUT_ENV) {
        if let Err(error) = std::fs::write(&path, format!("{json}\n")) {
            eprintln!("turing smoke: cannot write summary file: {error}");
        }
    }
}

/// Activates the harness when `TURING_SMOKE=1`; otherwise returns `builder`
/// unchanged.
pub fn install(builder: Builder<Wry>) -> Builder<Wry> {
    if std::env::var_os(ENABLE_ENV).is_none_or(|value| value != "1") {
        return builder;
    }
    #[cfg(feature = "perf")]
    if perf::enabled() {
        return builder;
    }
    let started = Instant::now();
    builder.manage(Probe::new(started)).setup(move |app| {
        let handle = app.handle().clone();
        thread::Builder::new()
            .name("turing-smoke".into())
            .spawn(move || drive(handle, started))?;
        Ok(())
    })
}

/// Records page-load completion for any webview while the harness is active.
pub fn page_event(webview: &Webview<Wry>, event: PageLoadEvent) {
    if event == PageLoadEvent::Finished {
        if let Some(probe) = webview.try_state::<Probe>() {
            probe.record(webview.label(), Mark::PageLoaded);
        }
    }
}

/// Adds the readiness script and title observer to windows created while the
/// harness is active. Other builds and runs leave `builder` unchanged.
pub fn instrument<'a>(
    manager: &AppHandle<Wry>,
    builder: WebviewWindowBuilder<'a, Wry, AppHandle<Wry>>,
    _label: &str,
) -> WebviewWindowBuilder<'a, Wry, AppHandle<Wry>> {
    let Some(_probe) = manager.try_state::<Probe>() else {
        return builder;
    };
    #[cfg(feature = "perf")]
    let builder = if _probe.perf.is_some() {
        let builder = builder.incognito(true);
        if _label.starts_with("workbench-") {
            builder.initialization_script(perf::EDITOR_SCRIPT)
        } else {
            builder
        }
    } else {
        builder
    };
    builder
        .initialization_script(READY_SCRIPT)
        .on_document_title_changed(|window, title| {
            if let Some(probe) = window.try_state::<Probe>() {
                if title == READY_TITLE {
                    probe.record(window.label(), Mark::Ready);
                }
                #[cfg(feature = "perf")]
                if let Some(perf) = &probe.perf {
                    perf.record(window.label(), &title);
                }
            }
        })
}

fn drive(app: AppHandle<Wry>, started: Instant) {
    let finished = Arc::new(AtomicBool::new(false));
    let limit = timeout();
    {
        let finished = finished.clone();
        let _ = thread::Builder::new()
            .name("turing-smoke-watchdog".into())
            .spawn(move || {
                thread::sleep(limit.saturating_sub(started.elapsed()));
                if !finished.swap(true, Ordering::SeqCst) {
                    let mut summary = Summary::new();
                    let code = summary.finish(
                        Err(format!("overall timeout of {}s exceeded", limit.as_secs())),
                        started.elapsed(),
                    );
                    emit(&summary.to_json());
                    std::process::exit(code);
                }
            });
    }

    let mut summary = Summary::new();
    let result = run(&app, &mut summary);
    let code = summary.finish(result, started.elapsed());
    if finished.swap(true, Ordering::SeqCst) {
        return;
    }
    emit(&summary.to_json());
    if code != 0 {
        eprintln!(
            "turing smoke: FAILED: {}",
            summary.error.as_deref().unwrap_or("unknown")
        );
    }
    app.exit(code);
    // The event loop should exit promptly; never let a stuck loop hang CI.
    thread::sleep(EXIT_GRACE);
    std::process::exit(code);
}

fn run(app: &AppHandle<Wry>, summary: &mut Summary) -> Result<(), String> {
    let probe = app.state::<Probe>();
    let registry = app.state::<Windows>();

    let main_loaded = probe.wait("main", Mark::PageLoaded, Instant::now() + STEP_TIMEOUT)?;
    summary.main_page_loaded_ms = Some(ms(main_loaded - probe.started));
    let main = app
        .get_webview_window("main")
        .ok_or("main window is missing")?;

    #[cfg(feature = "perf")]
    if probe.perf.is_some() {
        let ready = probe.wait("main", Mark::Ready, Instant::now() + STEP_TIMEOUT)?;
        summary.perf = Some(perf::Capture::new(ms(ready - probe.started)));
    }

    let mut opened = Vec::new();
    for kind in PLAN {
        let name = kind_name(kind);
        let open = Instant::now();
        let deadline = open + STEP_TIMEOUT;
        let label = windows::build(main.clone(), kind)
            .map_err(|error| format!("opening a {name} window failed: {error:?}"))?;
        let resources = registry
            .get(&label)
            .ok_or_else(|| format!("{name} window {label} was not registered"))?;
        let loaded = probe.wait(&label, Mark::PageLoaded, deadline)?;
        let ready = probe.wait(&label, Mark::Ready, deadline)?;
        let pty = if kind == Kind::Terminal {
            let at = wait_until(
                &format!("a PTY session in terminal window {label}"),
                deadline,
                || resources.terminal.live_sessions() > 0,
                || {},
            )?;
            Some(ms(at.saturating_duration_since(ready)))
        } else {
            None
        };
        summary.windows.push(WindowTiming {
            kind: name,
            label: label.clone(),
            open_to_page_loaded_ms: ms(loaded - open),
            open_to_ready_ms: ms(ready - open),
            ready_to_pty_ms: pty,
            close_ms: None,
        });
        opened.push((label, resources));
    }

    let mut expected = vec!["main".to_owned()];
    expected.extend(opened.iter().map(|(label, _)| label.clone()));
    expected.sort();
    let labels = registry.labels();
    if labels != expected {
        return Err(format!(
            "window registry mismatch after opening: {labels:?}"
        ));
    }

    #[cfg(feature = "perf")]
    if let (Some(perf), Some(capture)) = (&probe.perf, &mut summary.perf) {
        capture.after_open_rss_bytes = memory::resident();
        perf.exercise(app, &opened[0].0, &opened[2].0, capture)?;
    }

    for (index, (label, resources)) in opened.into_iter().enumerate() {
        let window = app
            .get_webview_window(&label)
            .ok_or_else(|| format!("window {label} disappeared before close"))?;
        let close = Instant::now();
        let request = || {
            let _ = window.close();
        };
        request();
        // Workbenches close through the frontend's unsaved-change flow, which
        // could miss a request sent before its listener mounted, so repeat it.
        let closed = wait_until(
            &format!("window {label} to close and release its resources"),
            close + STEP_TIMEOUT,
            || {
                registry.get(&label).is_none()
                    && resources.terminal.live_sessions() == 0
                    && app.get_webview_window(&label).is_none()
            },
            request,
        )?;
        summary.windows[index].close_ms = Some(ms(closed - close));
    }

    let labels = registry.labels();
    if labels != ["main"] {
        return Err(format!(
            "window registry did not return to the main window: {labels:?}"
        ));
    }
    let mut native: Vec<String> = app.webview_windows().into_keys().collect();
    native.sort();
    if native != ["main"] {
        return Err(format!("native windows remain open: {native:?}"));
    }
    #[cfg(feature = "perf")]
    if let Some(capture) = &mut summary.perf {
        capture.after_close_rss_bytes = memory::resident();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_returns_the_first_recorded_mark() {
        let probe = Probe::new(Instant::now());
        probe.record("a", Mark::PageLoaded);
        let first = probe
            .wait(
                "a",
                Mark::PageLoaded,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
        thread::sleep(Duration::from_millis(2));
        probe.record("a", Mark::PageLoaded);
        let again = probe
            .wait(
                "a",
                Mark::PageLoaded,
                Instant::now() + Duration::from_secs(1),
            )
            .unwrap();
        assert_eq!(first, again);
    }

    #[test]
    fn probe_wakes_a_waiter_from_another_thread() {
        let probe = Arc::new(Probe::new(Instant::now()));
        let recorder = probe.clone();
        let handle = thread::spawn(move || {
            thread::sleep(Duration::from_millis(20));
            recorder.record("terminal-x", Mark::Ready);
        });
        assert!(probe
            .wait(
                "terminal-x",
                Mark::Ready,
                Instant::now() + Duration::from_secs(5)
            )
            .is_ok());
        handle.join().unwrap();
    }

    #[test]
    fn probe_times_out_per_label_and_mark() {
        let probe = Probe::new(Instant::now());
        probe.record("a", Mark::PageLoaded);
        let error = probe
            .wait("a", Mark::Ready, Instant::now() + Duration::from_millis(20))
            .unwrap_err();
        assert!(
            error.contains("Ready") && error.contains("window a"),
            "{error}"
        );
        assert!(probe
            .wait(
                "b",
                Mark::PageLoaded,
                Instant::now() + Duration::from_millis(20)
            )
            .is_err());
    }

    #[test]
    fn wait_until_retries_and_times_out() {
        let mut retries = 0;
        let error = wait_until(
            "nothing",
            Instant::now() + CLOSE_RETRY + Duration::from_millis(100),
            || false,
            || retries += 1,
        )
        .unwrap_err();
        assert_eq!(error, "timed out waiting for nothing");
        assert_eq!(retries, 1);
        let mut polls = 0;
        assert!(wait_until(
            "three polls",
            Instant::now() + Duration::from_secs(5),
            || {
                polls += 1;
                polls == 3
            },
            || {},
        )
        .is_ok());
    }

    #[test]
    fn summary_reports_pass_and_failure_as_json() {
        let mut summary = Summary::new();
        summary.main_page_loaded_ms = Some(ms(Duration::from_micros(123_456)));
        summary.windows.push(WindowTiming {
            kind: kind_name(Kind::Terminal),
            label: "terminal-1".into(),
            open_to_page_loaded_ms: 1.,
            open_to_ready_ms: 2.,
            ready_to_pty_ms: Some(3.),
            close_ms: Some(4.),
        });
        summary.windows.push(WindowTiming {
            kind: kind_name(Kind::Workbench),
            label: "workbench-1".into(),
            open_to_page_loaded_ms: 1.,
            open_to_ready_ms: 2.,
            ready_to_pty_ms: None,
            close_ms: None,
        });
        assert_eq!(summary.finish(Ok(()), Duration::from_millis(1500)), 0);
        let json: serde_json::Value = serde_json::from_str(&summary.to_json()).unwrap();
        assert_eq!(json["status"], "passed");
        assert_eq!(json["mainPageLoadedMs"], 123.5);
        assert_eq!(json["totalMs"], 1500.0);
        assert!(json.get("error").is_none());
        assert_eq!(json["windows"][0]["kind"], "terminal");
        assert_eq!(json["windows"][0]["readyToPtyMs"], 3.0);
        assert_eq!(json["windows"][0]["closeMs"], 4.0);
        assert!(json["windows"][1].get("readyToPtyMs").is_none());

        let mut failed = Summary::new();
        assert_eq!(failed.finish(Err("boom".into()), Duration::ZERO), 1);
        let json: serde_json::Value = serde_json::from_str(&failed.to_json()).unwrap();
        assert_eq!(json["status"], "failed");
        assert_eq!(json["error"], "boom");
        assert_eq!(json["harness"], "turing-native-lifecycle-smoke");
    }

    #[test]
    fn plan_opens_two_workbenches_and_two_terminals() {
        assert_eq!(
            PLAN.iter().filter(|kind| **kind == Kind::Workbench).count(),
            2
        );
        assert_eq!(
            PLAN.iter().filter(|kind| **kind == Kind::Terminal).count(),
            2
        );
    }

    #[test]
    fn readiness_script_sets_the_observed_title() {
        assert!(READY_SCRIPT.contains(READY_TITLE));
    }
}

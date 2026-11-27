use crate::{
    agent::{
        model::Endpoint,
        policy::AskReason,
        task::{run_task, Approver, ArgvVerifier, Host, TaskContext},
        AgentError, AgentEvent, CloudScope, Limits, PlanAdjustments, PlanView, ReviewDecision,
        SandboxView,
    },
    ask::fake_server::Script,
    workspace::WorkspaceService,
};
use serde_json::{json, Value};
use std::{collections::HashSet, fs, sync::Mutex};
use uuid::Uuid;

const OWNER: &str = "test-workbench";
const ORIGINAL_SUM: &str = "module.exports = (a,b) => a+b+1;\n";

struct Panel {
    events: Mutex<Vec<Value>>,
    deny_plan: bool,
    dirty: HashSet<String>,
    /// Cancels once this file exists; `None` never cancels.
    cancel_when: Option<std::path::PathBuf>,
}

impl Host for Panel {
    fn emit(&self, event: AgentEvent) -> Result<(), AgentError> {
        self.events
            .lock()
            .unwrap()
            .push(serde_json::to_value(event).unwrap());
        Ok(())
    }
    fn cancelled(&self) -> bool {
        self.cancel_when.as_ref().is_some_and(|path| path.exists())
    }
    fn dirty(&self) -> HashSet<String> {
        self.dirty.clone()
    }
    fn plan_adjustments(&self) -> Result<PlanAdjustments, AgentError> {
        Ok(PlanAdjustments {
            verification: Some(vec!["node".into(), "check.js".into()]),
            allow_network: false,
        })
    }
    fn review_decision(&self) -> Result<ReviewDecision, AgentError> {
        Ok(ReviewDecision::RollBack)
    }
}

impl Approver for Panel {
    fn cloud_scope(&self, _: &CloudScope) -> bool {
        false
    }
    fn plan(
        &self,
        _: &PlanView,
        verification: Option<&[String]>,
        _: &SandboxView,
        network: bool,
        _: &Limits,
        _: Option<&CloudScope>,
    ) -> bool {
        assert_eq!(verification.unwrap(), ["node", "check.js"]);
        assert!(!network);
        !self.deny_plan
    }
    fn action(&self, reason: AskReason, _: &str) -> bool {
        assert!(
            reason == AskReason::UnsandboxedTests
                || (self.cancel_when.is_some() && matches!(reason, AskReason::Command(_))),
            "unexpected approval {reason:?}"
        );
        true
    }
    fn overwrite_after_agent(&self, path: &str) -> bool {
        panic!("unexpected overwrite approval for {path}");
    }
}

fn tool(name: &str, arguments: Value) -> Value {
    json!({"type":"function","function":{"name":name,"arguments":arguments.to_string()}})
}

fn plan() -> Value {
    tool(
        "submit_plan",
        json!({"summary":"Fix sum","steps":["Edit and test"], "files":["src/sum.js","src/util.js"],
        "verification":["node","check.js"], "limits":{"modelCalls":99,"toolCalls":15}}),
    )
}

fn server(replies: Vec<Vec<Value>>) -> Script {
    Script::new(
        replies
            .into_iter()
            .map(|calls| json!({ "tool_calls": calls }))
            .collect(),
    )
}

struct Fixture {
    workspace: tempfile::TempDir,
    app_data: tempfile::TempDir,
    service: WorkspaceService,
    id: String,
    task: Uuid,
}

impl Fixture {
    fn new() -> Self {
        let workspace = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join("src")).unwrap();
        fs::write(workspace.path().join("src/sum.js"), ORIGINAL_SUM).unwrap();
        fs::write(
            workspace.path().join("check.js"),
            "const sum = require('./src/sum')(2,3); console.log('sum', sum); process.exit(sum === 5 ? 0 : 1);",
        )
        .unwrap();
        fs::write(workspace.path().join(".env"), "fixture-secret-do-not-send").unwrap();
        let service = WorkspaceService::default();
        let id = service
            .registry()
            .unwrap()
            .register(OWNER, workspace.path())
            .unwrap()
            .id;
        Self {
            workspace,
            service,
            id,
            app_data: tempfile::tempdir().unwrap(),
            task: Uuid::new_v4(),
        }
    }

    fn run(&self, endpoint: &str, panel: &Panel) -> Result<(), AgentError> {
        let mut verifier = {
            let registry = self.service.registry().unwrap();
            ArgvVerifier::new(self.task, &registry, OWNER, &self.id).unwrap()
        };
        tauri::async_runtime::block_on(run_task(TaskContext {
            task_id: self.task,
            workspace: &self.service,
            workspace_id: &self.id,
            owner: OWNER,
            app_data: self.app_data.path(),
            endpoint: Endpoint::local(endpoint, None).unwrap(),
            cloud: None,
            request: "Fix sum",
            host: panel,
            approver: panel,
            verifier: &mut verifier,
        }))
    }

    fn unchanged(&self) {
        assert_eq!(
            fs::read_to_string(self.workspace.path().join("src/sum.js")).unwrap(),
            ORIGINAL_SUM
        );
        assert!(!self.workspace.path().join("src/util.js").exists());
        assert!(!self
            .app_data
            .path()
            .join("agent-checkpoints")
            .join(self.task.to_string())
            .exists());
    }
}

#[test]
fn plan_edit_fail_fix_pass_review_rollback() {
    let fixture = Fixture::new();
    let panel = Panel {
        events: Mutex::default(),
        deny_plan: false,
        dirty: HashSet::new(),
        cancel_when: None,
    };
    let script = server(vec![
        vec![tool(
            "read_file",
            json!({"path":"src/sum.js","startLine":1,"endLine":1}),
        )],
        vec![plan()],
        vec![tool(
            "write_file",
            json!({"path":"src/util.js","text":"module.exports = 1;"}),
        )],
        vec![tool(
            "edit_file",
            json!({"path":"src/sum.js","old":"a+b+1","new":"a+b+2"}),
        )],
        vec![tool("run_tests", json!({}))],
        vec![tool(
            "edit_file",
            json!({"path":"src/sum.js","old":"a+b+2","new":"a+b"}),
        )],
        vec![tool("run_tests", json!({}))],
        vec![tool(
            "finish",
            json!({"summary":"Verified the new implementation"}),
        )],
    ]);
    fixture.run(&script.url, &panel).unwrap();
    let requests = script.requests();
    let events = panel.events.into_inner().unwrap();
    let mut expected = vec![
        "planning",
        "modelCall",
        "read",
        "modelCall",
        "plan",
        "executing",
        "modelCall",
        "edit",
        "modelCall",
        "edit",
        "modelCall",
        "command",
        "modelCall",
        "edit",
        "modelCall",
        "command",
        "modelCall",
        "review",
        "finished",
    ];
    let sandboxed = events[5]["sandbox"]["sandboxed"].as_bool().unwrap();
    if std::env::var_os("TURING_CI_REQUIRE_SANDBOX").is_some() {
        assert!(sandboxed);
    }
    if !sandboxed {
        for index in (0..expected.len()).rev() {
            if expected[index] == "command" {
                expected.insert(index, "approval");
            }
        }
    }
    assert_eq!(
        events
            .iter()
            .map(|e| e["kind"].as_str().unwrap())
            .collect::<Vec<_>>(),
        expected
    );
    let commands = events
        .iter()
        .filter(|e| e["kind"] == "command")
        .collect::<Vec<_>>();
    // The wrong fix must fail by running and computing 7, not by Node failing to start.
    for (command, exit, sum) in [(commands[0], 1, "sum 7"), (commands[1], 0, "sum 5")] {
        let outcome = &command["outcome"];
        assert!(
            outcome["exitCode"] == exit && outcome["stdout"].as_str().unwrap().contains(sum),
            "expected exit {exit} printing {sum:?}, got {outcome}"
        );
    }
    let review = events.iter().find(|e| e["kind"] == "review").unwrap();
    assert_eq!(review["verification"]["status"], "passed");
    assert_eq!(review["files"].as_array().unwrap().len(), 2);
    assert_eq!(events[3]["inputTokens"], 120);
    assert_eq!(events[3]["sources"][0]["relativePath"], "src/sum.js");
    assert_eq!(events[4]["limits"]["modelCalls"], 30);
    assert!(requests[1].contains("module.exports"));
    fixture.unchanged();
}

#[test]
fn planning_refuses_writes_commands_secrets_and_traversal_then_honors_decline() {
    let fixture = Fixture::new();
    let panel = Panel {
        events: Mutex::default(),
        deny_plan: true,
        dirty: HashSet::new(),
        cancel_when: None,
    };
    let script = server(vec![
        vec![
            tool("write_file", json!({"path":"src/sum.js","text":"wrong"})),
            tool("run_command", json!({"argv":["node","--version"]})),
            tool("read_file", json!({"path":".env"})),
            tool("read_file", json!({"path":"../outside"})),
            tool("run_tests", json!({"skipApproval":true})),
        ],
        vec![plan()],
    ]);
    assert_eq!(
        fixture.run(&script.url, &panel),
        Err(AgentError::PlanDeclined)
    );
    let requests = script.requests();
    let events = panel.events.into_inner().unwrap();
    let reasons = events
        .iter()
        .filter(|event| event["kind"] == "refused")
        .map(|event| event["reason"].as_str().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        reasons,
        [
            "NOT_IN_PHASE",
            "NOT_IN_PHASE",
            "SECRET_FILE",
            "OUTSIDE_WORKSPACE",
            "INVALID_ARGUMENTS"
        ]
    );
    assert!(!requests.join("").contains("fixture-secret-do-not-send"));
    fixture.unchanged();
}

/// Starts a grandchild, records both pids, then sleeps well beyond the test.
const PROCESS_TREE: &str = r#"
const { spawn } = require('child_process');
const fs = require('fs');
fs.writeFileSync('child.pid', String(process.pid));
spawn(process.execPath, ['-e', `
  require('fs').writeFileSync('grand.tmp', String(process.pid));
  require('fs').renameSync('grand.tmp', 'grand.pid');
  setTimeout(() => {}, 600000);
`], { stdio: 'ignore' });
setTimeout(() => {}, 600000);
"#;

fn alive(pid: &str) -> bool {
    #[cfg(unix)]
    return std::process::Command::new("kill")
        .args(["-0", pid])
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap()
        .success();
    #[cfg(windows)]
    {
        let output = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout)
            .split_whitespace()
            .any(|word| word == pid)
    }
}

#[test]
fn cancelling_a_command_kills_its_process_tree() {
    let fixture = Fixture::new();
    let grand = fixture.workspace.path().join("grand.pid");
    let panel = Panel {
        events: Mutex::default(),
        deny_plan: false,
        dirty: HashSet::new(),
        cancel_when: Some(grand.clone()),
    };
    let script = server(vec![
        vec![plan()],
        vec![tool(
            "run_command",
            json!({"argv":["node","-e",PROCESS_TREE]}),
        )],
        vec![tool("finish", json!({"summary":"unreachable"}))],
    ]);
    fixture.run(&script.url, &panel).unwrap();
    script.requests();
    let events = panel.events.into_inner().unwrap();
    let command = events.iter().find(|e| e["kind"] == "command").unwrap();
    assert_eq!(command["outcome"]["cancelled"], true);
    let review = events.iter().find(|e| e["kind"] == "review").unwrap();
    assert_eq!(review["reason"]["kind"], "cancelled");
    let pids = [
        fs::read_to_string(fixture.workspace.path().join("child.pid")).unwrap(),
        fs::read_to_string(grand).unwrap(),
    ];
    // Generous: only bounds how long the OS may take to reap a killed tree.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    while pids.iter().any(|pid| alive(pid)) {
        assert!(
            std::time::Instant::now() < deadline,
            "the command's process tree outlived the cancel"
        );
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
}

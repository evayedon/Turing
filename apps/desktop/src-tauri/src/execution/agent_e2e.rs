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
        false
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
        assert_eq!(reason, AskReason::UnsandboxedTests);
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
            "process.exit(require('./src/sum')(2,3) === 5 ? 0 : 1);",
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
    assert_eq!(commands[0]["outcome"]["exitCode"], 1);
    assert_eq!(commands[1]["outcome"]["exitCode"], 0);
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

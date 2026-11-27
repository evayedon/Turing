//! Planning, approval, supervised execution and checkpoint review.

use super::{
    checkpoint::{Checkpoint, CheckpointState},
    model::{self, Endpoint, ToolCall},
    policy::{self, Action, AskReason, Decision, Phase, Scope},
    tools::{self, ToolArgs, ToolRefusal},
    AgentError, AgentEvent, ChangedFile, CloudScope, Limits, PlanAdjustments, PlanView,
    ReviewDecision, ReviewReason, ReviewView, SandboxView, Verification,
};
use crate::{
    ask::{self, Source},
    execution::{
        argv::{self, ArgvOutcome, ArgvRun},
        sandbox::{self, Availability, Sandbox, TaskGrants},
        ExecutionError,
    },
    workspace::{
        search::{self, FileFingerprints},
        Registry, WorkspaceService,
    },
};
use cap_std::fs::Dir;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering::Relaxed},
    time::{Duration, Instant},
};
use uuid::Uuid;

mod workspace_tools;

#[cfg(test)]
mod tests;

const MAX_UNTRACKED: usize = 50;
const OUTPUT_TAIL: usize = 8 * 1024;

pub(crate) trait Approver: Send + Sync {
    fn cloud_scope(&self, scope: &CloudScope) -> bool;
    fn plan(
        &self,
        plan: &PlanView,
        verification: Option<&[String]>,
        sandbox: &SandboxView,
        network: bool,
        limits: &Limits,
        cloud: Option<&CloudScope>,
    ) -> bool;
    fn action(&self, reason: AskReason, summary: &str) -> bool;
    fn overwrite_after_agent(&self, path: &str) -> bool;
}

pub(crate) trait Host: Send + Sync {
    fn emit(&self, event: AgentEvent) -> Result<(), AgentError>;
    fn cancelled(&self) -> bool;
    fn dirty(&self) -> HashSet<String>;
    fn plan_adjustments(&self) -> Result<PlanAdjustments, AgentError>;
    fn review_decision(&self) -> Result<ReviewDecision, AgentError>;
}

pub(crate) trait Verifier: Send {
    fn prepare(
        &mut self,
        argv: Option<&[String]>,
        network: bool,
        record_grant: &mut dyn FnMut(&Path) -> io::Result<()>,
    ) -> SandboxView;
    fn run(
        &self,
        argv: &[String],
        tests: bool,
        stopped: &AtomicBool,
    ) -> Result<ArgvOutcome, ExecutionError>;
    fn release(&mut self, task_id: Uuid, grants: &[String]) -> io::Result<()>;
}

pub(crate) struct ArgvVerifier {
    task_id: Uuid,
    cwd: Dir,
    root: PathBuf,
    temp: tempfile::TempDir,
    sandbox: Option<Sandbox>,
    network: bool,
}

impl ArgvVerifier {
    pub(crate) fn new(
        task_id: Uuid,
        registry: &Registry,
        owner: &str,
        id: &str,
    ) -> Result<Self, AgentError> {
        Ok(Self {
            task_id,
            root: registry
                .language_root(owner, id)
                .map_err(|_| AgentError::WorkspaceDenied)?
                .into(),
            cwd: registry
                .terminal_directory(owner, id)
                .map_err(|_| AgentError::WorkspaceDenied)?,
            temp: tempfile::tempdir().map_err(|_| AgentError::CheckpointIo)?,
            sandbox: None,
            network: false,
        })
    }
}

impl Verifier for ArgvVerifier {
    fn prepare(
        &mut self,
        argv: Option<&[String]>,
        network: bool,
        record: &mut dyn FnMut(&Path) -> io::Result<()>,
    ) -> SandboxView {
        self.network = network;
        let unavailable = |label: &str| SandboxView {
            sandboxed: false,
            label: label.into(),
        };
        let Some(program) = argv.and_then(|argv| argv.first()) else {
            return unavailable("No verification command");
        };
        let path = std::env::var_os("PATH");
        let Ok(program) = argv::resolve_program(program, path.as_deref()) else {
            return unavailable("Verification program unavailable");
        };
        let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
        match sandbox::detect_for_program(
            &self.cwd,
            &self.root,
            self.temp.path(),
            home.as_deref().map(Path::new),
            &program,
            network,
            TaskGrants {
                task_id: self.task_id,
                record,
            },
        ) {
            Availability::Available(sandbox) => {
                let label = sandbox.label().into();
                self.sandbox = Some(sandbox);
                SandboxView {
                    sandboxed: true,
                    label,
                }
            }
            Availability::Unavailable(reason) => unavailable(reason),
        }
    }

    fn run(
        &self,
        argv: &[String],
        tests: bool,
        stopped: &AtomicBool,
    ) -> Result<ArgvOutcome, ExecutionError> {
        argv::run_argv(ArgvRun {
            argv,
            cwd: &self.cwd,
            cwd_path: &self.root,
            temp: self.temp.path(),
            timeout: argv::COMMAND_TIMEOUT,
            network: !tests || self.network,
            sandbox: self.sandbox.as_ref().filter(|_| tests),
            stopped,
        })
    }

    fn release(&mut self, task_id: Uuid, grants: &[String]) -> io::Result<()> {
        self.sandbox = None;
        sandbox::revoke_grants(task_id, grants)
    }
}

pub(crate) struct TaskContext<'a> {
    pub task_id: Uuid,
    pub owner: &'a str,
    pub workspace_id: &'a str,
    pub workspace: &'a WorkspaceService,
    pub app_data: &'a Path,
    pub endpoint: Endpoint,
    pub cloud: Option<CloudScope>,
    pub request: &'a str,
    pub host: &'a dyn Host,
    pub approver: &'a dyn Approver,
    pub verifier: &'a mut dyn Verifier,
}

struct Task<'a> {
    ctx: TaskContext<'a>,
    started: Instant,
    limits: Limits,
    calls: u32,
    tokens: u64,
    tool_calls: u32,
    messages: Vec<Value>,
    sources: Vec<Source>,
    verification: Option<Vec<String>>,
    network: bool,
    sandboxed: bool,
    latest_test: Option<ArgvOutcome>,
    verify_pending: bool,
}

pub(crate) async fn run_task(ctx: TaskContext<'_>) -> Result<(), AgentError> {
    if ctx.host.cancelled() {
        return Err(AgentError::Cancelled);
    }
    if ctx.endpoint.is_cloud() != ctx.cloud.is_some() {
        return Err(AgentError::InvalidRequest);
    }
    if ctx
        .cloud
        .as_ref()
        .is_some_and(|scope| !ctx.approver.cloud_scope(scope))
    {
        return Err(AgentError::CloudConsentDeclined);
    }
    let mut limits = Limits::MAX;
    if let Some(scope) = &ctx.cloud {
        limits.model_calls = limits.model_calls.min(scope.max_calls);
        limits.total_tokens = limits.total_tokens.min(scope.max_tokens);
    }
    let messages = vec![
        json!({"role":"system","content":model::SYSTEM_PROMPT}),
        json!({"role":"user","content":ctx.request}),
    ];
    let client = model::client(ctx.cloud.is_some())?;
    let mut task = Task {
        ctx,
        started: Instant::now(),
        limits,
        calls: 0,
        tokens: 0,
        tool_calls: 0,
        messages,
        sources: vec![],
        verification: None,
        network: false,
        sandboxed: false,
        latest_test: None,
        verify_pending: false,
    };
    task.emit(AgentEvent::Planning)?;
    let plan = match task.run_phase(&client, None).await {
        PhaseEnd::Plan(plan) => plan,
        PhaseEnd::Review(ReviewReason::Cancelled, _) => return Err(AgentError::Cancelled),
        PhaseEnd::Review(ReviewReason::Failed { code }, _) => return Err(code),
        PhaseEnd::Review(_, _) => return Err(AgentError::InvalidRequest),
    };
    task.execute_plan(&client, plan).await
}

enum PhaseEnd {
    Plan(tools::PlanArgs),
    Review(ReviewReason, Option<String>),
}

enum ToolResult {
    Value(Value),
    Plan(tools::PlanArgs),
    Finish(String),
}

impl Task<'_> {
    fn emit(&self, event: AgentEvent) -> Result<(), AgentError> {
        self.ctx.host.emit(event)
    }

    fn registry(&self) -> Result<std::sync::MutexGuard<'_, Registry>, ToolRefusal> {
        let registry = self.ctx.workspace.registry()?;
        registry.language_root(self.ctx.owner, self.ctx.workspace_id)?;
        Ok(registry)
    }

    fn check(&self) -> Result<(), ReviewReason> {
        if self.ctx.host.cancelled() {
            return Err(ReviewReason::Cancelled);
        }
        if self.started.elapsed() >= Duration::from_secs(self.limits.wall_clock_secs) {
            return Err(ReviewReason::Limit { limit: "wallClock" });
        }
        if self.registry().is_err() {
            return Err(ReviewReason::Failed {
                code: AgentError::WorkspaceDenied,
            });
        }
        Ok(())
    }

    fn model_budget(&self) -> Result<(), ReviewReason> {
        for (exhausted, limit) in [
            (self.calls >= self.limits.model_calls, "modelCalls"),
            (self.tokens >= self.limits.total_tokens, "tokens"),
            (self.tool_calls >= self.limits.tool_calls, "toolCalls"),
        ] {
            if exhausted {
                return Err(ReviewReason::Limit { limit });
            }
        }
        Ok(())
    }

    async fn run_phase(
        &mut self,
        client: &reqwest::Client,
        mut checkpoint: Option<&mut Checkpoint>,
    ) -> PhaseEnd {
        let mut text_only = 0;
        let phase = if checkpoint.is_some() {
            Phase::Executing
        } else {
            Phase::Planning
        };
        let schema = if checkpoint.is_some() {
            tools::execution_tools()
        } else {
            tools::planning_tools()
        };
        loop {
            let completion = match self.next_completion(client, &schema).await {
                Ok(completion) => completion,
                Err(reason) => return PhaseEnd::Review(reason, None),
            };
            if completion.tool_calls.is_empty() {
                text_only += 1;
                if text_only == 2 {
                    let reason = if phase == Phase::Planning && self.ctx.cloud.is_none() {
                        ReviewReason::Failed {
                            code: AgentError::ModelCannotCallTools,
                        }
                    } else {
                        ReviewReason::GaveUp
                    };
                    return PhaseEnd::Review(reason, completion.content);
                }
                self.messages.push(
                    json!({"role":"assistant","content":completion.content.unwrap_or_default()}),
                );
                let instruction = if phase == Phase::Planning {
                    "Use submit_plan to propose a plan."
                } else {
                    "Use the available tools or finish with a factual summary."
                };
                self.messages
                    .push(json!({"role":"user","content":instruction}));
                continue;
            }
            text_only = 0;
            self.messages.push(json!({
                "role":"assistant", "content":completion.content,
                "tool_calls":completion.tool_calls.iter().map(|call| json!({
                    "id":call.id, "type":"function", "function":{"name":call.name,"arguments":call.arguments}
                })).collect::<Vec<_>>(),
            }));
            let mut pending_plan = None;
            for call in completion.tool_calls {
                if let Err(reason) = self.check() {
                    return PhaseEnd::Review(reason, None);
                }
                if self.tool_calls >= self.limits.tool_calls {
                    return PhaseEnd::Review(ReviewReason::Limit { limit: "toolCalls" }, None);
                }
                self.tool_calls += 1;
                let result = if pending_plan.is_some() {
                    Err(ToolRefusal::Policy(policy::Denial::NotInPhase))
                } else {
                    tools::parse(&call)
                        .and_then(|args| self.dispatch(phase, args, checkpoint.as_deref_mut()))
                };
                let value = match result {
                    Ok(ToolResult::Value(value)) => value,
                    Ok(ToolResult::Plan(plan)) => {
                        pending_plan = Some(plan);
                        json!({"status":"submitted"})
                    }
                    Ok(ToolResult::Finish(summary)) => {
                        return PhaseEnd::Review(ReviewReason::Finished, Some(summary))
                    }
                    Err(refused) => {
                        // A cancel or limit reached during an approval dialog stops the
                        // task; it is not a refusal.
                        if let Err(reason) = self.check() {
                            self.add_tool_result(&call, json!({ "stopped": stop_code(&reason) }));
                            return PhaseEnd::Review(reason, None);
                        }
                        let reason = refused.reason_code();
                        let tool: String = call.name.chars().take(128).collect();
                        if let Err(code) = self.emit(AgentEvent::Refused { tool, reason }) {
                            return PhaseEnd::Review(ReviewReason::Failed { code }, None);
                        }
                        json!({"refused":reason})
                    }
                };
                self.add_tool_result(&call, value);
            }
            if let Some(plan) = pending_plan {
                return PhaseEnd::Plan(plan);
            }
        }
    }

    async fn next_completion(
        &mut self,
        client: &reqwest::Client,
        schema: &Value,
    ) -> Result<model::Completion, ReviewReason> {
        self.check()?;
        self.model_budget()?;
        let estimated_prompt = serde_json::to_vec(&self.messages)
            .map_err(|_| ReviewReason::Failed {
                code: AgentError::InferenceFailed,
            })?
            .len()
            .saturating_add(schema.to_string().len())
            .div_ceil(4) as u64;
        if estimated_prompt.saturating_add(u64::from(model::MAX_COMPLETION_TOKENS))
            > self.limits.total_tokens.saturating_sub(self.tokens)
        {
            return Err(ReviewReason::Limit { limit: "tokens" });
        }
        let completion = ask::interruptible(
            model::complete(client, &self.ctx.endpoint, &self.messages, schema),
            &|| self.check(),
        )
        .await?
        .map_err(|code| ReviewReason::Failed { code })?;
        self.calls += 1;
        let (input_tokens, output_tokens) =
            completion.usage.as_ref().map_or((None, None), |usage| {
                (Some(usage.input_tokens), Some(usage.output_tokens))
            });
        let estimated_output = completion
            .content
            .as_ref()
            .map_or(0, String::len)
            .saturating_add(
                completion
                    .tool_calls
                    .iter()
                    .map(|call| call.arguments.len())
                    .sum(),
            )
            .div_ceil(4) as u64;
        self.tokens = self
            .tokens
            .saturating_add(input_tokens.unwrap_or(estimated_prompt))
            .saturating_add(output_tokens.unwrap_or(estimated_output));
        let sources = std::mem::take(&mut self.sources);
        self.emit(AgentEvent::ModelCall {
            number: self.calls,
            sources,
            input_tokens,
            output_tokens,
        })
        .map_err(|code| ReviewReason::Failed { code })?;
        if self.tokens >= self.limits.total_tokens {
            return Err(ReviewReason::Limit { limit: "tokens" });
        }
        Ok(completion)
    }

    fn add_tool_result(&mut self, call: &ToolCall, value: Value) {
        let content = value.to_string();
        let content = if content.len() <= 32 * 1024 {
            content
        } else {
            json!({"refused":"RESULT_TOO_LARGE","instruction":"Request a smaller result."})
                .to_string()
        };
        self.messages
            .push(json!({"role":"tool","tool_call_id":call.id,"content":content}));
    }

    async fn execute_plan(
        &mut self,
        client: &reqwest::Client,
        plan: tools::PlanArgs,
    ) -> Result<(), AgentError> {
        self.limits = self.limits.within(plan.limits.as_ref());
        self.verification = plan.verification.or_else(|| {
            self.registry().ok().and_then(|registry| {
                registry
                    .authorize(self.ctx.owner, self.ctx.workspace_id)
                    .ok()
                    .and_then(argv::detect_test_command)
            })
        });
        let plan = PlanView {
            summary: plan.summary,
            steps: plan.steps,
            files: plan.files,
        };
        self.emit(AgentEvent::Plan {
            plan: plan.clone(),
            verification: self.verification.clone(),
            limits: self.limits,
            cloud: self.ctx.cloud.clone(),
        })?;
        let adjustments = self.ctx.host.plan_adjustments()?;
        self.check().map_err(phase_error)?;
        if adjustments
            .verification
            .as_deref()
            .is_some_and(|argv| !tools::valid_argv(argv))
        {
            return Err(AgentError::InvalidRequest);
        }
        self.verification = adjustments.verification;
        self.network = adjustments.allow_network;
        let (identity, display) = {
            let registry = self.registry().map_err(|_| AgentError::WorkspaceDenied)?;
            let path = registry
                .language_root(self.ctx.owner, self.ctx.workspace_id)
                .map_err(|_| AgentError::WorkspaceDenied)?;
            let display = registry
                .workspace_display_path(self.ctx.owner, self.ctx.workspace_id)
                .map_err(|_| AgentError::WorkspaceDenied)?;
            (
                path.to_str().ok_or(AgentError::WorkspaceDenied)?.to_owned(),
                display.to_owned(),
            )
        };
        let mut checkpoint =
            Checkpoint::create(self.ctx.app_data, self.ctx.task_id, identity, display)
                .map_err(|_| AgentError::CheckpointIo)?;
        let sandbox =
            self.ctx
                .verifier
                .prepare(self.verification.as_deref(), self.network, &mut |path| {
                    checkpoint.note_acl_grant(path)
                });
        self.sandboxed = sandbox.sandboxed;
        if !self.ctx.approver.plan(
            &plan,
            self.verification.as_deref(),
            &sandbox,
            self.network,
            &self.limits,
            self.ctx.cloud.as_ref(),
        ) {
            self.release(&checkpoint)?;
            checkpoint.discard().map_err(|_| AgentError::CheckpointIo)?;
            return Err(AgentError::PlanDeclined);
        }
        let baseline = self.fingerprints();
        let execution = async {
            self.emit(AgentEvent::Executing {
                network: self.network,
                sandbox,
            })?;
            self.messages.push(json!({"role":"user","content":json!({
                "status":"approved", "verification":self.verification, "network":self.network,
                "instruction":"Execute the approved plan using tools."
            }).to_string()}));
            let PhaseEnd::Review(mut reason, summary) =
                self.run_phase(client, Some(&mut checkpoint)).await
            else {
                return Err(AgentError::InferenceFailed);
            };
            if self.ctx.host.cancelled() {
                reason = ReviewReason::Cancelled;
            }
            if let ReviewReason::Failed { code } = reason {
                self.emit(AgentEvent::Error { code })?;
            }
            if self.verify_pending
                && !matches!(
                    reason,
                    ReviewReason::Cancelled | ReviewReason::Failed { .. }
                )
                && self.check().is_ok()
            {
                if let Some(argv) = self.verification.clone() {
                    let _ = self.execute_command(Phase::Executing, &argv, true);
                    if self.ctx.host.cancelled() {
                        reason = ReviewReason::Cancelled;
                    }
                }
            }
            checkpoint
                .set_state(CheckpointState::Review)
                .map_err(|_| AgentError::CheckpointIo)?;
            Ok((reason, summary))
        }
        .await;
        self.release(&checkpoint)?;
        let (reason, summary) = execution?;
        let review = self.review(&checkpoint, baseline, reason, summary)?;
        self.emit(AgentEvent::Review(review))?;
        let decision = self.ctx.host.review_decision()?;
        let report = if decision == ReviewDecision::RollBack {
            Some(checkpoint.rollback(
                &|| self.registry().ok(),
                self.ctx.owner,
                self.ctx.workspace_id,
                &mut |path| self.ctx.approver.overwrite_after_agent(path),
            ))
        } else {
            None
        };
        let complete = report.as_ref().is_none_or(|report| report.complete);
        // Keep or a complete rollback: revoke the grant log, then drop the checkpoint. A partial
        // rollback keeps both for another attempt.
        if complete {
            checkpoint.discard().map_err(|_| AgentError::CheckpointIo)?;
        }
        self.emit(AgentEvent::Finished {
            outcome: decision,
            report,
        })?;
        if complete {
            Ok(())
        } else {
            Err(AgentError::RollbackIncomplete)
        }
    }

    fn release(&mut self, checkpoint: &Checkpoint) -> Result<(), AgentError> {
        self.ctx
            .verifier
            .release(self.ctx.task_id, checkpoint.acl_grants())
            .map_err(|_| AgentError::CheckpointIo)
    }

    fn fingerprints(&self) -> Option<FileFingerprints> {
        let dir = self
            .registry()
            .ok()?
            .terminal_directory(self.ctx.owner, self.ctx.workspace_id)
            .ok()?;
        search::agent_fingerprints(&dir).ok()
    }

    fn review(
        &self,
        checkpoint: &Checkpoint,
        before: Option<FileFingerprints>,
        reason: ReviewReason,
        summary: Option<String>,
    ) -> Result<ReviewView, AgentError> {
        let mut files = Vec::new();
        for file in checkpoint.changed_paths() {
            let before = checkpoint
                .original(&file.relative_path)
                .map_err(|_| AgentError::CheckpointIo)?
                .and_then(|bytes| String::from_utf8(bytes).ok());
            let after = self.registry().ok().and_then(|registry| {
                registry
                    .read(self.ctx.owner, self.ctx.workspace_id, &file.relative_path)
                    .ok()
                    .map(|file| file.content)
            });
            if before == after {
                continue;
            }
            let redact = |text: Option<String>| {
                text.filter(|text| !crate::workspace::ask::excluded_content(text))
            };
            files.push(ChangedFile {
                relative_path: file.relative_path,
                change: file.change,
                before: redact(before),
                after: redact(after),
            });
        }
        let mut untracked_changes = Vec::new();
        if let (Some(before), Some(after)) = (before, self.fingerprints()) {
            let recorded: HashSet<_> = checkpoint
                .changed_paths()
                .into_iter()
                .map(|file| file.relative_path)
                .collect();
            let paths = before
                .keys()
                .chain(after.keys())
                .collect::<std::collections::BTreeSet<_>>();
            untracked_changes = paths
                .into_iter()
                .filter(|path| !recorded.contains(*path) && before.get(*path) != after.get(*path))
                .take(MAX_UNTRACKED)
                .cloned()
                .collect();
        }
        let verification = match (
            self.verification.is_some(),
            &self.latest_test,
            self.verify_pending,
        ) {
            (false, _, _) => Verification::NoCommand,
            (_, Some(outcome), false) if !outcome.cancelled => {
                if outcome.exit_code == Some(0) && !outcome.timed_out {
                    Verification::Passed
                } else {
                    Verification::Failed {
                        exit_code: outcome.exit_code,
                        timed_out: outcome.timed_out,
                    }
                }
            }
            _ => Verification::NotRun,
        };
        Ok(ReviewView {
            reason,
            files,
            untracked_changes,
            verification,
            sandboxed: self.latest_test.as_ref().map(|outcome| outcome.sandboxed),
            summary,
        })
    }

    fn authorize_action(&self, phase: Phase, action: &Action<'_>) -> Result<(), ToolRefusal> {
        self.check().map_err(|_| ToolRefusal::Interrupted)?;
        let scope = Scope {
            tests: self.verification.as_deref(),
            sandboxed: self.sandboxed,
        };
        let decide = || policy::decide(phase, &scope, action, &self.ctx.host.dirty());
        match decide() {
            Decision::Allow => Ok(()),
            Decision::Deny(denial) => Err(denial.into()),
            Decision::Ask(reason) => {
                let key = policy::action_key(action);
                let summary = approval_text(action);
                let granted = self.ctx.approver.action(reason, &summary);
                self.emit(AgentEvent::Approval {
                    reason: approval_reason(reason),
                    summary,
                    granted,
                })
                .map_err(|_| ToolRefusal::WorkspaceError)?;
                self.check().map_err(|_| ToolRefusal::Interrupted)?;
                if !granted {
                    return Err(ToolRefusal::ApprovalDeclined);
                }
                match decide() {
                    Decision::Ask(current)
                        if current == reason && key == policy::action_key(action) =>
                    {
                        Ok(())
                    }
                    Decision::Deny(reason) => Err(reason.into()),
                    _ => Err(ToolRefusal::ApprovalDeclined),
                }
            }
        }
    }

    fn execute_command(
        &mut self,
        phase: Phase,
        argv: &[String],
        tests: bool,
    ) -> Result<Value, ToolRefusal> {
        let action = if tests {
            Action::RunTests { argv }
        } else {
            Action::RunCommand { argv }
        };
        self.authorize_action(phase, &action)?;
        let stopped = AtomicBool::new(false);
        let complete = AtomicBool::new(false);
        let (host, workspace, owner, id) = (
            self.ctx.host,
            self.ctx.workspace,
            self.ctx.owner,
            self.ctx.workspace_id,
        );
        let deadline = self.started + Duration::from_secs(self.limits.wall_clock_secs);
        let outcome = std::thread::scope(|threads| {
            let watcher = threads.spawn(|| {
                while !complete.load(Relaxed) {
                    let revoked = workspace
                        .registry()
                        .map_or(true, |registry| registry.language_root(owner, id).is_err());
                    if host.cancelled() || revoked || Instant::now() >= deadline {
                        stopped.store(true, Relaxed);
                        break;
                    }
                    std::thread::park_timeout(Duration::from_millis(50));
                }
            });
            let result = self.ctx.verifier.run(argv, tests, &stopped);
            complete.store(true, Relaxed);
            watcher.thread().unpark();
            result
        });
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(_) => ArgvOutcome {
                exit_code: None,
                timed_out: false,
                cancelled: stopped.load(Relaxed),
                truncated: false,
                stdout: String::new(),
                stderr: "The command could not be started.".into(),
                sandboxed: tests && self.sandboxed,
            },
        };
        if tests {
            self.latest_test = Some(outcome.clone());
            self.verify_pending = false;
        } else {
            // An approved command can modify code outside of the edit tools.
            self.verify_pending = true;
        }
        self.emit(AgentEvent::Command {
            argv: argv.to_vec(),
            tests,
            outcome: outcome.clone(),
            network: !tests || self.network,
        })
        .map_err(|_| ToolRefusal::WorkspaceError)?;
        let mut result = serde_json::to_value(outcome).map_err(|_| ToolRefusal::WorkspaceError)?;
        // The two streams together send at most the last 16 KiB of output.
        for key in ["stdout", "stderr"] {
            let text = result[key].as_str().unwrap_or("");
            result[key] = if crate::workspace::ask::excluded_content(text) {
                json!("")
            } else {
                json!(tail(text, OUTPUT_TAIL))
            };
        }
        Ok(result)
    }
}

fn stop_code(reason: &ReviewReason) -> &'static str {
    match reason {
        ReviewReason::Cancelled => "cancelled",
        ReviewReason::Limit { limit } => limit,
        _ => "failed",
    }
}

fn phase_error(reason: ReviewReason) -> AgentError {
    match reason {
        ReviewReason::Cancelled => AgentError::Cancelled,
        ReviewReason::Failed { code } => code,
        _ => AgentError::InvalidRequest,
    }
}

fn approval_reason(reason: AskReason) -> &'static str {
    match reason {
        AskReason::BuildConfigEdit => "buildConfigEdit",
        AskReason::Rename => "rename",
        AskReason::Delete => "delete",
        AskReason::UnsandboxedTests => "unsandboxedTests",
        AskReason::Command(_) => "command",
    }
}

fn approval_text(action: &Action<'_>) -> String {
    let text = match action {
        Action::Write { path, .. } | Action::Edit { path } | Action::Delete { path } => json!(path),
        Action::Rename { from, to } => json!({"from":from,"to":to}),
        Action::RunTests { argv } | Action::RunCommand { argv } => json!(argv),
        _ => Value::Null,
    };
    let visible = ask::cloud::dialog_text(&text.to_string());
    let mut chars = visible.chars();
    let mut summary: String = chars.by_ref().take(599).collect();
    if chars.next().is_some() {
        summary.push('…');
    }
    summary
}

fn tail(text: &str, bytes: usize) -> &str {
    &text[text.ceil_char_boundary(text.len().saturating_sub(bytes))..]
}

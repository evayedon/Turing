//! Rust-owned supervised agent.

pub(crate) mod checkpoint;
pub(crate) mod model;
pub(crate) mod policy;
pub(crate) mod tools;

#[allow(
    dead_code,
    reason = "The complete error contract is shared by later agent tasks"
)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentError {
    WorkspaceDenied,
    Busy,
    InvalidRequest,
    ModelUnavailable,
    ModelCannotCallTools,
    InferenceFailed,
    CloudConsentDeclined,
    CloudKeyRequired,
    CredentialStore,
    ProviderUnauthorized,
    ProviderRateLimited,
    ProviderUnavailable,
    ProviderNoPrivateRoute,
    PlanDeclined,
    TaskNotFound,
    CheckpointIo,
    RollbackIncomplete,
    Cancelled,
}

impl From<crate::ask::Error> for AgentError {
    fn from(error: crate::ask::Error) -> Self {
        use crate::ask::Error;
        match error {
            Error::InvalidLocalServer => Self::InvalidRequest,
            Error::ModelUnavailable => Self::ModelUnavailable,
            Error::CloudKeyRequired | Error::InvalidCloudKey => Self::CloudKeyRequired,
            Error::CredentialStore => Self::CredentialStore,
            Error::ProviderUnauthorized => Self::ProviderUnauthorized,
            Error::ProviderRateLimited => Self::ProviderRateLimited,
            Error::ProviderUnavailable => Self::ProviderUnavailable,
            Error::ProviderNoPrivateRoute => Self::ProviderNoPrivateRoute,
            _ => Self::InferenceFailed,
        }
    }
}

#[allow(
    dead_code,
    reason = "The native task entry points are wired in Task 11"
)]
pub(crate) mod task;

use checkpoint::{ChangeKind, RollbackReport};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum AgentEvent {
    Planning,
    Plan {
        plan: PlanView,
        verification: Option<Vec<String>>,
        limits: Limits,
        cloud: Option<CloudScope>,
    },
    Executing {
        network: bool,
        sandbox: SandboxView,
    },
    Approval {
        reason: &'static str,
        summary: String,
        granted: bool,
    },
    Read {
        relative_path: String,
        start_line: usize,
        end_line: usize,
    },
    Edit(ChangedFile),
    Command {
        argv: Vec<String>,
        tests: bool,
        outcome: crate::execution::argv::ArgvOutcome,
        network: bool,
    },
    ModelCall {
        number: u32,
        sources: Vec<crate::ask::Source>,
        input_tokens: Option<u64>,
        output_tokens: Option<u64>,
    },
    Refused {
        tool: String,
        reason: &'static str,
    },
    Error {
        code: AgentError,
    },
    Review(ReviewView),
    Finished {
        outcome: ReviewDecision,
        report: Option<RollbackReport>,
    },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PlanView {
    pub summary: String,
    pub steps: Vec<String>,
    pub files: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SandboxView {
    pub sandboxed: bool,
    pub label: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudScope {
    pub model: &'static str,
    pub provider: &'static str,
    pub max_calls: u32,
    pub max_tokens: u64,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Limits {
    pub model_calls: u32,
    pub total_tokens: u64,
    pub tool_calls: u32,
    pub wall_clock_secs: u64,
    pub command_secs: u64,
}

impl Limits {
    pub const MAX: Limits = Limits {
        model_calls: 30,
        total_tokens: 400_000,
        tool_calls: 60,
        wall_clock_secs: 1200,
        command_secs: 300,
    };

    pub fn within(self, requested: Option<&tools::LimitsRequest>) -> Limits {
        let Some(requested) = requested else {
            return self;
        };
        Limits {
            model_calls: requested
                .model_calls
                .unwrap_or(self.model_calls)
                .min(self.model_calls),
            total_tokens: requested
                .total_tokens
                .unwrap_or(self.total_tokens)
                .min(self.total_tokens),
            tool_calls: requested
                .tool_calls
                .unwrap_or(self.tool_calls)
                .min(self.tool_calls),
            wall_clock_secs: requested
                .wall_clock_secs
                .unwrap_or(self.wall_clock_secs)
                .min(self.wall_clock_secs),
            command_secs: self.command_secs,
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangedFile {
    pub relative_path: String,
    pub change: ChangeKind,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewView {
    pub reason: ReviewReason,
    pub files: Vec<ChangedFile>,
    pub untracked_changes: Vec<String>,
    pub verification: Verification,
    pub sandboxed: Option<bool>,
    pub summary: Option<String>,
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum ReviewReason {
    Finished,
    Cancelled,
    Limit { limit: &'static str },
    GaveUp,
    Failed { code: AgentError },
}

#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum Verification {
    Passed,
    Failed {
        exit_code: Option<i32>,
        timed_out: bool,
    },
    NotRun,
    NoCommand,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReviewDecision {
    Keep,
    RollBack,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanAdjustments {
    pub verification: Option<Vec<String>>,
    pub allow_network: bool,
}

//! Model tool schemas and validation. `agent::task` executes the calls.
#![allow(dead_code)]

use super::{model::ToolCall, policy::Denial};
use crate::workspace::WorkspaceError;
use serde::Deserialize;
use serde_json::{json, Value};

const PATH_BYTES: usize = 4096;
const TEXT_BYTES: usize = 256 * 1024;
const MAX_LINES: usize = 400;
const MAX_ARGV: usize = 64;
const SUMMARY_CHARS: usize = 4000;
const MAX_STEPS: usize = 30;
const MAX_FILES: usize = 100;

macro_rules! arguments {
    ($name:ident { $($field:ident: $ty:ty),* $(,)? }) => {
        #[derive(Debug, Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        pub(crate) struct $name { $(pub $field: $ty),* }
    };
}

arguments!(Empty {});
arguments!(ListArgs { path: Option<String> });
arguments!(ReadArgs { path: String, start_line: Option<usize>, end_line: Option<usize> });
arguments!(SearchArgs { query: String });
arguments!(SymbolArgs { query: String });
arguments!(EditArgs {
    path: String,
    old: String,
    new: String
});
arguments!(WriteArgs {
    path: String,
    text: String
});
arguments!(RenameArgs {
    from: String,
    to: String
});
arguments!(PathArgs { path: String });
arguments!(CommandArgs { argv: Vec<String> });
arguments!(FinishArgs { summary: String });
arguments!(PlanArgs {
    summary: String, steps: Vec<String>, files: Vec<String>,
    verification: Option<Vec<String>>, limits: Option<LimitsRequest>,
});

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LimitsRequest {
    pub model_calls: Option<u32>,
    pub total_tokens: Option<u64>,
    pub tool_calls: Option<u32>,
    pub wall_clock_secs: Option<u64>,
}

#[derive(Debug)]
pub(crate) enum ToolArgs {
    ListFiles(ListArgs),
    ReadFile(ReadArgs),
    SearchText(SearchArgs),
    FindSymbols(SymbolArgs),
    SubmitPlan(PlanArgs),
    EditFile(EditArgs),
    WriteFile(WriteArgs),
    RenamePath(RenameArgs),
    DeletePath(PathArgs),
    RunTests(Empty),
    RunCommand(CommandArgs),
    Finish(FinishArgs),
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name, "description": description,
            "parameters": {"type":"object", "properties": properties, "required": required, "additionalProperties": false}
        }
    })
}

fn string_schema(max: usize) -> Value {
    json!({"type": "string", "maxLength": max})
}

fn argv_schema() -> Value {
    json!({"type": "array", "minItems": 1, "maxItems": MAX_ARGV, "items": string_schema(PATH_BYTES)})
}

fn read_tools() -> Vec<Value> {
    vec![
        tool("list_files", "List files in a workspace directory. Omit path for the workspace root.", json!({"path": string_schema(PATH_BYTES)}), &[]),
        tool("read_file", "Read text from a workspace file. Line numbers are one-based and inclusive. The default range is up to 400 lines.", json!({
            "path": string_schema(PATH_BYTES), "startLine": {"type":"integer","minimum":1},
            "endLine": {"type":"integer","minimum":1}
        }), &["path"]),
        tool("search_text", "Search workspace files for literal text.", json!({"query": string_schema(PATH_BYTES)}), &["query"]),
        tool("find_symbols", "Find workspace symbols by name.", json!({"query": string_schema(PATH_BYTES)}), &["query"]),
    ]
}

pub(crate) fn planning_tools() -> Value {
    let mut tools = read_tools();
    tools.push(tool("submit_plan", "Submit the plan for the developer to review. Include the intended verification command as argv when known.", json!({
        "summary": string_schema(SUMMARY_CHARS),
        "steps": {"type": "array", "minItems": 1, "maxItems": MAX_STEPS, "items": string_schema(SUMMARY_CHARS)},
        "files": {"type": "array", "maxItems": MAX_FILES, "items": string_schema(PATH_BYTES)},
        "verification": argv_schema(),
        "limits": {"type":"object", "additionalProperties":false, "properties":{
            "modelCalls":{"type":"integer","minimum":1}, "totalTokens":{"type":"integer","minimum":1},
            "toolCalls":{"type":"integer","minimum":1}, "wallClockSecs":{"type":"integer","minimum":1}
        }}
    }), &["summary", "steps", "files"]));
    Value::Array(tools)
}

pub(crate) fn execution_tools() -> Value {
    let mut tools = read_tools();
    tools.extend([
        tool("edit_file", "Replace exactly one occurrence of old text in a workspace file.", json!({"path": string_schema(PATH_BYTES), "old": string_schema(TEXT_BYTES), "new": string_schema(TEXT_BYTES)}), &["path", "old", "new"]),
        tool("write_file", "Write a whole workspace text file.", json!({"path": string_schema(PATH_BYTES), "text": string_schema(TEXT_BYTES)}), &["path", "text"]),
        tool("rename_path", "Rename a workspace path, subject to developer approval.", json!({"from": string_schema(PATH_BYTES), "to": string_schema(PATH_BYTES)}), &["from", "to"]),
        tool("delete_path", "Delete a workspace file, subject to developer approval.", json!({"path": string_schema(PATH_BYTES)}), &["path"]),
        tool("run_tests", "Run the developer-approved verification command.", json!({}), &[]),
        tool("run_command", "Request approval to run a command as an argv array.", json!({"argv": argv_schema()}), &["argv"]),
        tool("finish", "End execution with a factual summary and leave changes for review.", json!({"summary": string_schema(SUMMARY_CHARS)}), &["summary"]),
    ]);
    Value::Array(tools)
}

fn bounded(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.contains('\0')
}

fn path(value: &str) -> bool {
    bounded(value, PATH_BYTES)
}

fn summary(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= SUMMARY_CHARS
}

pub(crate) fn valid_argv(value: &[String]) -> bool {
    (1..=MAX_ARGV).contains(&value.len())
        && !value[0].trim().is_empty()
        && value
            .iter()
            .all(|arg| arg.len() <= PATH_BYTES && !arg.contains('\0'))
}

pub(crate) fn parse(call: &ToolCall) -> Result<ToolArgs, ToolRefusal> {
    let invalid = ToolRefusal::InvalidArguments;
    macro_rules! read {
        ($variant:ident) => {
            ToolArgs::$variant(serde_json::from_str(&call.arguments).map_err(|_| invalid)?)
        };
    }
    let parsed = match call.name.as_str() {
        "list_files" => read!(ListFiles),
        "read_file" => read!(ReadFile),
        "search_text" => read!(SearchText),
        "find_symbols" => read!(FindSymbols),
        "submit_plan" => read!(SubmitPlan),
        "edit_file" => read!(EditFile),
        "write_file" => read!(WriteFile),
        "rename_path" => read!(RenamePath),
        "delete_path" => read!(DeletePath),
        "run_tests" => read!(RunTests),
        "run_command" => read!(RunCommand),
        "finish" => read!(Finish),
        _ => return Err(invalid),
    };
    let valid = match &parsed {
        ToolArgs::ListFiles(args) => args.path.as_deref().is_none_or(path),
        ToolArgs::ReadFile(args) => {
            let start = args.start_line.unwrap_or(1);
            path(&args.path)
                && start > 0
                && args
                    .end_line
                    .is_none_or(|end| end >= start && end - start < MAX_LINES)
        }
        ToolArgs::SearchText(args) => bounded(&args.query, PATH_BYTES),
        ToolArgs::FindSymbols(args) => bounded(&args.query, PATH_BYTES),
        ToolArgs::SubmitPlan(args) => {
            summary(&args.summary)
                && (1..=MAX_STEPS).contains(&args.steps.len())
                && args.steps.iter().all(|step| summary(step))
                && args.files.len() <= MAX_FILES
                && args.files.iter().all(|file| path(file))
                && args.verification.as_deref().is_none_or(valid_argv)
                && args.limits.as_ref().is_none_or(|limit| {
                    limit.model_calls != Some(0)
                        && limit.total_tokens != Some(0)
                        && limit.tool_calls != Some(0)
                        && limit.wall_clock_secs != Some(0)
                })
        }
        ToolArgs::EditFile(args) => {
            path(&args.path)
                && !args.old.is_empty()
                && args.old.len() <= TEXT_BYTES
                && args.new.len() <= TEXT_BYTES
        }
        ToolArgs::WriteFile(args) => path(&args.path) && args.text.len() <= TEXT_BYTES,
        ToolArgs::RenamePath(args) => path(&args.from) && path(&args.to),
        ToolArgs::DeletePath(args) => path(&args.path),
        ToolArgs::RunTests(_) => true,
        ToolArgs::RunCommand(args) => valid_argv(&args.argv),
        ToolArgs::Finish(args) => summary(&args.summary),
    };
    valid.then_some(parsed).ok_or(invalid)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ToolRefusal {
    InvalidArguments,
    Policy(Denial),
    OutsideWorkspace,
    NotFound,
    NotText,
    FileConflict,
    OldTextNotFound,
    OldTextNotUnique,
    ApprovalDeclined,
    WorkspaceError,
}

impl ToolRefusal {
    pub(crate) fn reason_code(self) -> &'static str {
        match self {
            Self::InvalidArguments => "INVALID_ARGUMENTS",
            Self::Policy(Denial::SecretFile) => "SECRET_FILE",
            Self::Policy(Denial::GitDirectory) => "GIT_DIRECTORY",
            Self::Policy(Denial::DirtyInEditor) => "DIRTY_IN_EDITOR",
            Self::Policy(Denial::NotInPhase) => "NOT_IN_PHASE",
            Self::Policy(Denial::DeniedGit) => "DENIED_GIT",
            Self::Policy(Denial::ShellInterpreter) => "SHELL_INTERPRETER",
            Self::Policy(Denial::UnknownGitSubcommand) => "UNKNOWN_GIT_SUBCOMMAND",
            Self::Policy(Denial::EmptyArgv) => "EMPTY_ARGV",
            Self::Policy(Denial::TestsNotApproved) => "TESTS_NOT_APPROVED",
            Self::Policy(Denial::ShortName) => "SHORT_NAME",
            Self::OutsideWorkspace => "OUTSIDE_WORKSPACE",
            Self::NotFound => "NOT_FOUND",
            Self::NotText => "NOT_TEXT",
            Self::FileConflict => "FILE_CONFLICT",
            Self::OldTextNotFound => "OLD_TEXT_NOT_FOUND",
            Self::OldTextNotUnique => "OLD_TEXT_NOT_UNIQUE",
            Self::ApprovalDeclined => "APPROVAL_DECLINED",
            Self::WorkspaceError => "WORKSPACE_ERROR",
        }
    }
}

impl From<Denial> for ToolRefusal {
    fn from(value: Denial) -> Self {
        Self::Policy(value)
    }
}

impl From<WorkspaceError> for ToolRefusal {
    fn from(value: WorkspaceError) -> Self {
        match value {
            WorkspaceError::OutsideWorkspace | WorkspaceError::PermissionDenied => {
                Self::OutsideWorkspace
            }
            WorkspaceError::NotFound => Self::NotFound,
            WorkspaceError::NotFile
            | WorkspaceError::InvalidEncoding
            | WorkspaceError::FileTooLarge => Self::NotText,
            WorkspaceError::FileConflict
            | WorkspaceError::SaveRace
            | WorkspaceError::EntryChanged
            | WorkspaceError::NameTaken => Self::FileConflict,
            _ => Self::WorkspaceError,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_json(name: &str, arguments: Value) -> Result<ToolArgs, ToolRefusal> {
        parse(&ToolCall {
            id: "fixture".into(),
            name: name.into(),
            arguments: arguments.to_string(),
        })
    }

    #[test]
    fn rejects_unknown_tool_fields_and_names() {
        for (name, input) in [
            ("read_file", json!({"path":"a","approved":true})),
            ("run_tests", json!({"skipApproval":true})),
            ("sudo", json!({})),
        ] {
            assert_eq!(
                parse_json(name, input).unwrap_err(),
                ToolRefusal::InvalidArguments
            );
        }
    }

    #[test]
    fn enforces_argument_limits() {
        for (name, input) in [
            ("read_file", json!({"path":"a".repeat(PATH_BYTES + 1)})),
            ("read_file", json!({"path":"a","startLine":4,"endLine":404})),
            ("run_command", json!({"argv":vec!["a";MAX_ARGV+1]})),
            (
                "submit_plan",
                json!({"summary":"work","steps":vec!["a";MAX_STEPS+1],"files":[]}),
            ),
        ] {
            assert_eq!(
                parse_json(name, input).unwrap_err(),
                ToolRefusal::InvalidArguments
            );
        }
        assert!(parse_json(
            "read_file",
            json!({"path":"a".repeat(PATH_BYTES),"startLine":4,"endLine":403})
        )
        .is_ok());
        assert!(parse_json("run_command", json!({"argv":vec!["a";MAX_ARGV]})).is_ok());
        assert!(parse_json("submit_plan", json!({"summary":"work","steps":vec!["a";MAX_STEPS],"files":[], "limits":{"modelCalls":3}})).is_ok());
    }

    #[test]
    fn refusal_reason_codes_are_stable() {
        for (refusal, code) in [
            (ToolRefusal::InvalidArguments, "INVALID_ARGUMENTS"),
            (Denial::SecretFile.into(), "SECRET_FILE"),
            (Denial::DirtyInEditor.into(), "DIRTY_IN_EDITOR"),
            (Denial::NotInPhase.into(), "NOT_IN_PHASE"),
            (Denial::DeniedGit.into(), "DENIED_GIT"),
            (ToolRefusal::OutsideWorkspace, "OUTSIDE_WORKSPACE"),
            (ToolRefusal::OldTextNotFound, "OLD_TEXT_NOT_FOUND"),
            (ToolRefusal::OldTextNotUnique, "OLD_TEXT_NOT_UNIQUE"),
            (ToolRefusal::ApprovalDeclined, "APPROVAL_DECLINED"),
        ] {
            assert_eq!(refusal.reason_code(), code);
        }
    }
}

use super::super::checkpoint::ChangeKind;
use super::*;
use crate::workspace::{ask::excluded_content, relative_parts, TextFile, WorkspaceError};

const RESULT_FILES: usize = 60;
const RESULT_TEXT_BYTES: usize = 12 * 1024;
const READ_LINES: usize = 400;

impl Task<'_> {
    pub(super) fn dispatch(
        &mut self,
        phase: Phase,
        args: ToolArgs,
        checkpoint: Option<&mut Checkpoint>,
    ) -> Result<ToolResult, ToolRefusal> {
        let value = match args {
            ToolArgs::ListFiles(args) => {
                let path = canonical(args.path.as_deref().unwrap_or(""), true)?;
                self.authorize_action(phase, &Action::List { path: &path })?;
                let rows = self
                    .registry()?
                    .list(self.ctx.owner, self.ctx.workspace_id, &path)?;
                let rows = rows
                    .into_iter()
                    .filter(|row| readable(&row.relative_path))
                    .map(|row| json!({"path":row.relative_path,"kind":row.kind}));
                bounded_rows(rows)
            }
            ToolArgs::ReadFile(args) => {
                let path = canonical(&args.path, false)?;
                self.authorize_action(phase, &Action::Read { path: &path })?;
                self.read_file(&path, args.start_line.unwrap_or(1), args.end_line)?
            }
            ToolArgs::SearchText(args) => {
                self.authorize_action(phase, &Action::Search)?;
                let search = self.registry()?.agent_search(
                    self.ctx.owner,
                    self.ctx.workspace_id,
                    search::SearchOptions::literal(args.query),
                )?;
                let result = search.run()?;
                let registry = self.registry()?;
                let rows = result.files.into_iter().filter_map(|file| {
                    let saved = read_safe(
                        &registry,
                        self.ctx.owner,
                        self.ctx.workspace_id,
                        &file.relative_path,
                    )
                    .ok()?;
                    let lines = file
                        .matches
                        .iter()
                        .filter_map(|item| {
                            saved
                                .content
                                .lines()
                                .nth(item.line.checked_sub(1)?)
                                .map(|_| item.line)
                        })
                        .take(20)
                        .collect::<Vec<_>>();
                    // Search returns paths and line numbers only. A read_file call
                    // will report the exact content and version sent to the model.
                    Some(json!({"path":file.relative_path,"lines":lines}))
                });
                bounded_rows(rows)
            }
            ToolArgs::FindSymbols(args) => {
                self.authorize_action(phase, &Action::Symbols)?;
                let mut registry = self.registry()?;
                let mut response = registry.query_symbols(
                    self.ctx.owner,
                    self.ctx.workspace_id,
                    &args.query,
                    RESULT_FILES,
                )?;
                response.symbols.retain(|symbol| {
                    read_safe(
                        &registry,
                        self.ctx.owner,
                        self.ctx.workspace_id,
                        &symbol.relative_path,
                    )
                    .is_ok()
                });
                bounded_rows(response.symbols.into_iter().map(|symbol| json!(symbol)))
            }
            ToolArgs::SubmitPlan(mut plan) => {
                self.authorize_action(phase, &Action::SubmitPlan)?;
                for path in &mut plan.files {
                    *path = canonical(path, false)?;
                }
                return Ok(ToolResult::Plan(plan));
            }
            ToolArgs::EditFile(args) => {
                let path = canonical(&args.path, false)?;
                self.authorize_action(phase, &Action::Edit { path: &path })?;
                self.mutate(
                    checkpoint,
                    Mutation::Edit {
                        path,
                        old: args.old,
                        new: args.new,
                    },
                )?
            }
            ToolArgs::WriteFile(args) => {
                let path = canonical(&args.path, false)?;
                self.authorize_action(
                    phase,
                    &Action::Write {
                        path: &path,
                        exists: false,
                    },
                )?;
                self.mutate(
                    checkpoint,
                    Mutation::Write {
                        path,
                        text: args.text,
                    },
                )?
            }
            ToolArgs::RenamePath(args) => {
                let from = canonical(&args.from, false)?;
                let to = canonical(&args.to, false)?;
                self.authorize_action(
                    phase,
                    &Action::Rename {
                        from: &from,
                        to: &to,
                    },
                )?;
                self.mutate(checkpoint, Mutation::Rename { from, to })?
            }
            ToolArgs::DeletePath(args) => {
                let path = canonical(&args.path, false)?;
                self.authorize_action(phase, &Action::Delete { path: &path })?;
                self.mutate(checkpoint, Mutation::Delete { path })?
            }
            ToolArgs::RunTests(_) => {
                let approved = self.verification.clone().unwrap_or_default();
                self.execute_command(phase, &approved, true)?
            }
            ToolArgs::RunCommand(args) => self.execute_command(phase, &args.argv, false)?,
            ToolArgs::Finish(args) => {
                self.authorize_action(phase, &Action::Finish)?;
                return Ok(ToolResult::Finish(args.summary));
            }
        };
        Ok(ToolResult::Value(value))
    }

    fn read_file(
        &mut self,
        path: &str,
        start: usize,
        end: Option<usize>,
    ) -> Result<Value, ToolRefusal> {
        let file = {
            let registry = self.registry()?;
            read_safe(&registry, self.ctx.owner, self.ctx.workspace_id, path)?
        };
        let count = end.map_or(READ_LINES, |end| end - start + 1);
        let mut text = String::new();
        let mut end_line = start - 1;
        for line in file.content.split('\n').skip(start - 1).take(count) {
            if text.len() + line.len() + 1 > RESULT_TEXT_BYTES {
                break;
            }
            if end_line >= start {
                text.push('\n');
            }
            text.push_str(line.trim_end_matches('\r'));
            end_line += 1;
        }
        if end_line < start {
            return Err(ToolRefusal::InvalidArguments);
        }
        let result = json!({"path":path,"startLine":start,"endLine":end_line,"text":text});
        if result.to_string().len() > 32 * 1024 {
            return Err(ToolRefusal::InvalidArguments);
        }
        self.sources.push(Source {
            relative_path: path.into(),
            version: file.version,
            start_line: start,
            end_line,
        });
        self.emit(AgentEvent::Read {
            relative_path: path.into(),
            start_line: start,
            end_line,
        })
        .map_err(|_| ToolRefusal::WorkspaceError)?;
        Ok(result)
    }

    fn mutate(
        &mut self,
        checkpoint: Option<&mut Checkpoint>,
        mutation: Mutation,
    ) -> Result<Value, ToolRefusal> {
        let checkpoint = checkpoint.ok_or(ToolRefusal::Policy(policy::Denial::NotInPhase))?;
        self.verify_pending = true;
        let registry = self.registry()?;
        let owner = self.ctx.owner;
        let id = self.ctx.workspace_id;
        let mut edits = Vec::new();
        match mutation {
            Mutation::Edit { path, old, new } => {
                let file = read_safe(&registry, owner, id, &path)?;
                let modified = replace_once(&file.content, &old, &new)?;
                update(
                    checkpoint,
                    &registry,
                    (owner, id),
                    &mut edits,
                    path,
                    file,
                    modified,
                )?;
            }
            Mutation::Write { path, text } => match read_safe(&registry, owner, id, &path) {
                Ok(file) => update(
                    checkpoint,
                    &registry,
                    (owner, id),
                    &mut edits,
                    path,
                    file,
                    text,
                )?,
                Err(ToolRefusal::NotFound) => {
                    create(checkpoint, &registry, owner, id, &mut edits, path, text)?
                }
                Err(error) => return Err(error),
            },
            Mutation::Delete { path } => {
                let file = read_safe(&registry, owner, id, &path)?;
                delete(checkpoint, &registry, owner, id, &mut edits, path, file)?;
            }
            Mutation::Rename { from, to } => {
                if policy::dirty_key(&from) == policy::dirty_key(&to) {
                    return Err(ToolRefusal::FileConflict);
                }
                let file = read_safe(&registry, owner, id, &from)?;
                match registry.read(owner, id, &to) {
                    Err(WorkspaceError::NotFound) => {}
                    Ok(_) => return Err(ToolRefusal::FileConflict),
                    Err(error) => return Err(error.into()),
                }
                record(checkpoint, &from, Some(&file))?;
                create(
                    checkpoint,
                    &registry,
                    owner,
                    id,
                    &mut edits,
                    to,
                    file.content.clone(),
                )?;
                let removed = delete(checkpoint, &registry, owner, id, &mut edits, from, file);
                if let Err(error) = removed {
                    // Both paths are recorded if the create succeeds. Report the
                    // partial edit immediately so it stays visible for review.
                    drop(registry);
                    self.emit_edits(edits)?;
                    return Err(error);
                }
            }
        }
        drop(registry);
        self.emit_edits(edits)?;
        Ok(json!({"status":"applied"}))
    }

    fn emit_edits(&self, edits: Vec<ChangedFile>) -> Result<(), ToolRefusal> {
        for mut edit in edits {
            edit.before = edit.before.filter(|text| !excluded_content(text));
            edit.after = edit.after.filter(|text| !excluded_content(text));
            self.emit(AgentEvent::Edit(edit))
                .map_err(|_| ToolRefusal::WorkspaceError)?;
        }
        Ok(())
    }
}

enum Mutation {
    Edit {
        path: String,
        old: String,
        new: String,
    },
    Write {
        path: String,
        text: String,
    },
    Rename {
        from: String,
        to: String,
    },
    Delete {
        path: String,
    },
}

fn canonical(path: &str, allow_root: bool) -> Result<String, ToolRefusal> {
    let parts = relative_parts(path)?;
    if parts.is_empty() && !allow_root {
        return Err(ToolRefusal::OutsideWorkspace);
    }
    Ok(parts.join("/"))
}

fn readable(path: &str) -> bool {
    policy::decide(
        Phase::Planning,
        &Scope {
            tests: None,
            sandboxed: false,
        },
        &Action::Read { path },
        &HashSet::new(),
    ) == Decision::Allow
}

fn read_safe(
    registry: &Registry,
    owner: &str,
    id: &str,
    path: &str,
) -> Result<TextFile, ToolRefusal> {
    let check = policy::decide(
        Phase::Planning,
        &Scope {
            tests: None,
            sandboxed: false,
        },
        &Action::Read { path },
        &HashSet::new(),
    );
    if let Decision::Deny(denial) = check {
        return Err(denial.into());
    }
    let file = registry.read(owner, id, path)?;
    if excluded_content(&file.content) {
        return Err(policy::Denial::SecretFile.into());
    }
    Ok(file)
}

fn record(
    checkpoint: &mut Checkpoint,
    path: &str,
    file: Option<&TextFile>,
) -> Result<(), ToolRefusal> {
    checkpoint
        .record(
            path,
            file.map(|file| (file.content.as_bytes(), file.version.as_str())),
        )
        .map_err(|_| ToolRefusal::WorkspaceError)
}

fn update(
    checkpoint: &mut Checkpoint,
    registry: &Registry,
    registration: (&str, &str),
    edits: &mut Vec<ChangedFile>,
    path: String,
    file: TextFile,
    text: String,
) -> Result<(), ToolRefusal> {
    if file.content == text {
        return Ok(());
    }
    crate::workspace::validate_save_content(&text)?;
    record(checkpoint, &path, Some(&file))?;
    let (owner, id) = registration;
    let version = registry.write(owner, id, &path, &file.version, &text)?;
    checkpoint
        .note_write(&path, Some(&version))
        .map_err(|_| ToolRefusal::WorkspaceError)?;
    edits.push(ChangedFile {
        relative_path: path,
        change: ChangeKind::Modified,
        before: Some(file.content),
        after: Some(text),
    });
    Ok(())
}

fn create(
    checkpoint: &mut Checkpoint,
    registry: &Registry,
    owner: &str,
    id: &str,
    edits: &mut Vec<ChangedFile>,
    path: String,
    text: String,
) -> Result<(), ToolRefusal> {
    crate::workspace::validate_save_content(&text)?;
    record(checkpoint, &path, None)?;
    let (version, dirs) = registry.agent_create(owner, id, &path, &text)?;
    checkpoint
        .note_created_dirs(&dirs)
        .and_then(|()| checkpoint.note_write(&path, Some(&version)))
        .map_err(|_| ToolRefusal::WorkspaceError)?;
    edits.push(ChangedFile {
        relative_path: path,
        change: ChangeKind::Created,
        before: None,
        after: Some(text),
    });
    Ok(())
}

fn delete(
    checkpoint: &mut Checkpoint,
    registry: &Registry,
    owner: &str,
    id: &str,
    edits: &mut Vec<ChangedFile>,
    path: String,
    file: TextFile,
) -> Result<(), ToolRefusal> {
    record(checkpoint, &path, Some(&file))?;
    registry.agent_delete(owner, id, &path, &file.version)?;
    checkpoint
        .note_write(&path, None)
        .map_err(|_| ToolRefusal::WorkspaceError)?;
    edits.push(ChangedFile {
        relative_path: path,
        change: ChangeKind::Deleted,
        before: Some(file.content),
        after: None,
    });
    Ok(())
}

fn replace_once(text: &str, old: &str, new: &str) -> Result<String, ToolRefusal> {
    let start = text.find(old).ok_or(ToolRefusal::OldTextNotFound)?;
    let advance = old
        .chars()
        .next()
        .ok_or(ToolRefusal::InvalidArguments)?
        .len_utf8();
    if text[start + advance..].contains(old) {
        return Err(ToolRefusal::OldTextNotUnique);
    }
    Ok(format!(
        "{}{new}{}",
        &text[..start],
        &text[start + old.len()..]
    ))
}

fn bounded_rows(rows: impl Iterator<Item = Value>) -> Value {
    let mut result = Vec::new();
    let mut budget = 28 * 1024;
    for row in rows.take(RESULT_FILES) {
        let bytes = row.to_string().len() + 1;
        if bytes > budget {
            break;
        }
        budget -= bytes;
        result.push(row);
    }
    Value::Array(result)
}

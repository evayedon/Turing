use super::{
    did_change, did_close, did_open, same_uri, supported, Error, Position, Result, Session,
};
use crate::workspace::{EntryKind, Registry, MAX_TEXT_BYTES};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;

const MAX_FILES: usize = 24;
const MAX_EDITS: usize = 512;
const MAX_EDIT_BYTES: usize = 256 * 1024;
const MAX_MIRROR_BYTES: usize = 4 * 1024 * 1024;

pub(super) struct Snapshot {
    pub uri: String,
    pub text: String,
    pub version: String,
    lsp_version: u32,
}

#[derive(Deserialize)]
struct Range {
    start: Position,
    end: Position,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextEdit {
    range: Range,
    new_text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FileEdit {
    path: String,
    base_version: String,
    document_version: Option<u32>,
    edits: Vec<Edit>,
}

#[derive(Serialize)]
struct Edit {
    start: usize,
    end: usize,
    position: Position,
    before: String,
    after: String,
}

#[derive(Serialize)]
pub(super) struct Preview {
    pub files: Vec<FileEdit>,
}

#[derive(Serialize)]
pub(super) struct Prepared {
    pub placeholder: String,
}

#[derive(Serialize)]
pub(super) struct Failure {
    pub error: Error,
}

#[cfg(test)]
pub(super) fn assert_preview_contract() {
    use crate::contract_fixtures as fixture;
    fixture::assert_payload(
        "RenamePreview",
        0,
        &Preview {
            files: vec![
                FileEdit {
                    path: "src/main.cpp".into(),
                    base_version: "v1".into(),
                    document_version: Some(4),
                    edits: vec![Edit {
                        start: 4,
                        end: 8,
                        position: Position {
                            line: 0,
                            character: 4,
                        },
                        before: "item".into(),
                        after: "renamed".into(),
                    }],
                },
                FileEdit {
                    path: "src/utils.hpp".into(),
                    base_version: "v2".into(),
                    document_version: None,
                    edits: vec![Edit {
                        start: 4,
                        end: 8,
                        position: Position {
                            line: 0,
                            character: 4,
                        },
                        before: "item".into(),
                        after: "renamed".into(),
                    }],
                },
            ],
        },
    );
    fixture::assert_case_count("RenamePreview", 1);
}

struct Coordinates {
    text: Vec<u16>,
    lines: Vec<(usize, usize)>,
}

impl Coordinates {
    fn new(text: &str) -> Self {
        let text: Vec<_> = text.encode_utf16().collect();
        let mut lines = Vec::new();
        let mut start = 0;
        let mut index = 0;
        while index < text.len() {
            let ch = text[index];
            if ch == 13 || ch == 10 {
                lines.push((start, index));
                if ch == 13 && text.get(index + 1) == Some(&10) {
                    index += 1;
                }
                start = index + 1;
            }
            index += 1;
        }
        lines.push((start, text.len()));
        Self { text, lines }
    }

    fn offset(&self, position: Position) -> Result<usize> {
        let &(start, end) = self
            .lines
            .get(position.line as usize)
            .ok_or(Error::InvalidWorkspaceEdit)?;
        let column = position.character as usize;
        if column > end - start {
            return Err(Error::InvalidWorkspaceEdit);
        }
        let index = start + column;
        if index < end && (0xdc00..=0xdfff).contains(&self.text[index]) {
            return Err(Error::InvalidWorkspaceEdit);
        }
        Ok(index)
    }
}

pub(super) fn prepare(value: &Value, text: &str, position: Position) -> Result<String> {
    let range: Range = serde_json::from_value(value.get("range").unwrap_or(value).clone())
        .map_err(|_| Error::InvalidWorkspaceEdit)?;
    let coordinates = Coordinates::new(text);
    let start = coordinates.offset(range.start)?;
    let end = coordinates.offset(range.end)?;
    let cursor = coordinates.offset(position)?;
    if start >= end || !(start..=end).contains(&cursor) || end - start > 256 {
        return Err(Error::InvalidWorkspaceEdit);
    }
    let original = String::from_utf16(&coordinates.text[start..end])
        .map_err(|_| Error::InvalidWorkspaceEdit)?;
    if original.contains(['\r', '\n', '\0']) {
        return Err(Error::InvalidWorkspaceEdit);
    }
    Ok(original)
}

impl Session {
    // clangd has no recursive project indexing in this session. Give it a
    // bounded set of neighboring files and retain the exact snapshots it saw.
    pub(super) fn stage_rename_neighbors(
        &mut self,
        registry: &Registry,
        owner: &str,
        path: &str,
    ) -> Result<()> {
        let parent = path.rsplit_once('/').map_or("", |(parent, _)| parent);
        let Ok(entries) = registry.list(owner, &self.workspace_id, parent) else {
            return Ok(());
        };
        let mut bytes: usize = self.neighbors.values().map(|file| file.text.len()).sum();
        let mut staged = Vec::new();
        let mut neighbor_count = self.neighbors.len();
        let mut known_paths: HashSet<_> = self
            .documents
            .keys()
            .chain(self.neighbors.keys())
            .map(|path| path.to_lowercase())
            .collect();
        let mut messages = Vec::new();
        for entry in entries
            .into_iter()
            .filter(|entry| entry.kind == EntryKind::File && supported(&entry.relative_path))
            .take(MAX_FILES * 2)
        {
            let path = entry.relative_path;
            let old = self.neighbors.get(&path);
            let folded = path.to_lowercase();
            if old.is_none() && (neighbor_count >= MAX_FILES || known_paths.contains(&folded)) {
                continue;
            }
            let Ok((file, uri)) = self.mirror(&path) else {
                continue;
            };
            let Ok(snapshot) = registry.read(owner, &self.workspace_id, &path) else {
                continue;
            };
            if old.is_some_and(|old| old.version == snapshot.version) {
                continue;
            }
            let old_size = old.map_or(0, |file| file.text.len());
            if snapshot.content.len() > MAX_MIRROR_BYTES - bytes + old_size {
                continue;
            }
            let lsp_version = match old {
                Some(old) => old
                    .lsp_version
                    .checked_add(1)
                    .filter(|version| *version <= i32::MAX as u32)
                    .ok_or(Error::Busy)?,
                None => 0,
            };
            if file
                .parent()
                .is_some_and(|parent| std::fs::create_dir_all(parent).is_ok())
                && std::fs::write(file, &snapshot.content).is_ok()
            {
                bytes = bytes - old_size + snapshot.content.len();
                messages.push(if old.is_some() {
                    did_change(&uri, lsp_version, &snapshot.content)
                } else {
                    did_open(&path, &uri, lsp_version, &snapshot.content)
                });
                if old.is_none() {
                    neighbor_count += 1;
                    known_paths.insert(folded);
                }
                staged.push((
                    path,
                    Snapshot {
                        uri,
                        text: snapshot.content,
                        version: snapshot.version,
                        lsp_version,
                    },
                ));
            }
        }
        if !messages.is_empty() {
            // Refresh the source AST after staging. The original preamble
            // may have cached failed includes while these files were absent.
            if let Some(source) = self.documents.get(path) {
                messages.push(did_close(&source.uri));
                messages.push(did_open(path, &source.uri, source.version, &source.text));
            }
            if let Err(error) = self.process.batch(messages) {
                for (path, _) in staged {
                    if let Ok((file, _)) = self.mirror(&path) {
                        if let Some(old) = self.neighbors.get(&path) {
                            let _ = std::fs::write(file, &old.text);
                        } else {
                            let _ = std::fs::remove_file(file);
                        }
                    }
                }
                return Err(error);
            }
            self.neighbors.extend(staged);
            self.revision += 1;
        }
        Ok(())
    }

    pub(super) fn workspace_edit(
        &self,
        value: &Value,
        registry: &Registry,
        owner: &str,
    ) -> Result<Vec<FileEdit>> {
        let invalid = Error::InvalidWorkspaceEdit;
        let object = value.as_object().ok_or(invalid)?;
        // Reject annotations and anything beyond plain text edits.
        if object.len() != 1 {
            return Err(invalid);
        }
        let mut targets = Vec::new();
        if let Some(changes) = object.get("changes").and_then(Value::as_object) {
            if changes.len() > MAX_FILES {
                return Err(invalid);
            }
            targets.extend(
                changes
                    .iter()
                    .map(|(uri, edits)| (uri.as_str(), None, edits)),
            );
        } else if let Some(changes) = object.get("documentChanges").and_then(Value::as_array) {
            if changes.len() > MAX_FILES {
                return Err(invalid);
            }
            for change in changes {
                if change.get("kind").is_some() {
                    return Err(invalid);
                }
                let document = change.get("textDocument").ok_or(invalid)?;
                let uri = document.get("uri").and_then(Value::as_str).ok_or(invalid)?;
                let version = match document.get("version") {
                    Some(Value::Null) => None,
                    Some(version) => {
                        Some(u32::try_from(version.as_u64().ok_or(invalid)?).map_err(|_| invalid)?)
                    }
                    None => return Err(invalid),
                };
                targets.push((uri, version, change.get("edits").ok_or(invalid)?));
            }
        } else {
            return Err(invalid);
        }

        let mut result: Vec<FileEdit> = Vec::new();
        let mut remaining_count = MAX_EDITS;
        let mut remaining_bytes = MAX_EDIT_BYTES;
        for (uri, version, edits) in targets {
            let (path, base_version, text, lsp_version, document_version) = self
                .documents
                .iter()
                .find(|(_, doc)| same_uri(&doc.uri, uri))
                .map(|(path, doc)| {
                    (
                        path,
                        &doc.base_version,
                        doc.text.as_str(),
                        doc.version,
                        Some(doc.version),
                    )
                })
                .or_else(|| {
                    self.neighbors
                        .iter()
                        .find(|(_, file)| same_uri(&file.uri, uri))
                        .map(|(path, file)| {
                            (
                                path,
                                &file.version,
                                file.text.as_str(),
                                file.lsp_version,
                                None,
                            )
                        })
                })
                .ok_or(invalid)?;
            if version.is_some_and(|version| version != lsp_version)
                || result.iter().any(|file| file.path == *path)
            {
                return Err(invalid);
            }
            registry
                .language_file(owner, &self.workspace_id, path)
                .map_err(|_| invalid)?;
            let edits = edits
                .as_array()
                .filter(|edits| !edits.is_empty() && edits.len() <= remaining_count)
                .ok_or(invalid)?;
            remaining_count -= edits.len();
            let coordinates = Coordinates::new(text);
            let mut validated = Vec::with_capacity(edits.len());
            let mut output_bytes = text.len() as i64;
            for edit in edits {
                if edit.get("annotationId").is_some() {
                    return Err(invalid);
                }
                let edit: TextEdit = serde_json::from_value(edit.clone()).map_err(|_| invalid)?;
                let start = coordinates.offset(edit.range.start)?;
                let end = coordinates.offset(edit.range.end)?;
                if start > end || end - start > remaining_bytes || edit.new_text.contains('\0') {
                    return Err(invalid);
                }
                let before =
                    String::from_utf16(&coordinates.text[start..end]).map_err(|_| invalid)?;
                remaining_bytes = remaining_bytes
                    .checked_sub(before.len() + edit.new_text.len())
                    .ok_or(invalid)?;
                output_bytes += edit.new_text.len() as i64 - before.len() as i64;
                validated.push(Edit {
                    start,
                    end,
                    position: edit.range.start,
                    before,
                    after: edit.new_text,
                });
            }
            validated.sort_unstable_by_key(|edit| (edit.start, edit.end));
            if validated
                .windows(2)
                .any(|pair| pair[0].end > pair[1].start || pair[0].start == pair[1].start)
            {
                return Err(invalid);
            }
            if output_bytes > MAX_TEXT_BYTES as i64 {
                return Err(invalid);
            }
            result.push(FileEdit {
                path: path.clone(),
                base_version: base_version.clone(),
                document_version,
                edits: validated,
            });
        }
        result.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        Ok(result)
    }
}

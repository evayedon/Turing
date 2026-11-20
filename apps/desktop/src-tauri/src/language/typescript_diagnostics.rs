use super::{notify, Document, Error, Event, Position, Process, Result, REQUEST_TIMEOUT};
use serde_json::{json, Value};
use std::{collections::HashMap, time::Instant};

/// The TypeScript server's push diagnostics lack an LSP document version.
/// Request only the two synchronous, read-only tsserver operations. FIFO
/// delivery puts them after this version's didOpen/didChange.
#[derive(Default)]
pub(super) struct Diagnostics {
    sequence: i64,
    dispatched: HashMap<String, u32>,
    pending: Option<Pending>,
}

struct Pending {
    ids: [i64; 2],
    received: [Option<Vec<Value>>; 2],
    path: String,
    version: u32,
    started: Instant,
}

impl Diagnostics {
    pub fn schedule(
        &mut self,
        process: &Process,
        documents: &HashMap<String, Document>,
    ) -> Result<()> {
        self.dispatched
            .retain(|path, _| documents.contains_key(path));
        if let Some(pending) = &self.pending {
            if pending.started.elapsed() < REQUEST_TIMEOUT
                && documents
                    .get(&pending.path)
                    .is_some_and(|document| document.version == pending.version)
            {
                return Ok(());
            }
            let _ = process.batch(
                pending
                    .ids
                    .map(|id| notify("$/cancelRequest", json!({"id":id})))
                    .into(),
            );
            self.pending = None;
        }
        let Some((path, document)) = documents
            .iter()
            .find(|(path, document)| self.dispatched.get(*path) != Some(&document.version))
        else {
            return Ok(());
        };
        let ids = [self.sequence - 1, self.sequence - 2];
        let commands = ["syntacticDiagnosticsSync", "semanticDiagnosticsSync"];
        let messages = ids.into_iter().zip(commands).map(|(id, command)| json!({
            "jsonrpc":"2.0", "id":id, "method":"workspace/executeCommand",
            "params":{"command":"typescript.tsserverRequest", "arguments":[command,{"file":document.uri}]}
        })).collect();
        match process.batch(messages) {
            Ok(()) => {}
            Err(Error::Busy) => return Ok(()),
            Err(error) => return Err(error),
        }
        self.sequence = ids[1];
        self.dispatched.insert(path.clone(), document.version);
        self.pending = Some(Pending {
            ids,
            received: [None, None],
            path: path.clone(),
            version: document.version,
            started: Instant::now(),
        });
        Ok(())
    }

    pub fn receive(
        &mut self,
        id: i64,
        message: &Value,
        documents: &HashMap<String, Document>,
    ) -> Option<Event> {
        let pending = self.pending.as_mut()?;
        let index = pending.ids.iter().position(|known| *known == id)?;
        if pending.received[index].is_some() {
            return None;
        }
        let Some(body) = message.pointer("/result/body").and_then(Value::as_array) else {
            self.pending = None;
            return None;
        };
        pending.received[index] = Some(body.iter().take(200).filter_map(convert).collect());
        if pending.received.iter().any(Option::is_none) {
            return None;
        }
        let pending = self.pending.take()?;
        let document = documents.get(&pending.path)?;
        if document.version != pending.version {
            return None;
        }
        Some(Event::Diagnostics {
            path: pending.path,
            version: document.version,
            diagnostics: pending
                .received
                .into_iter()
                .flatten()
                .flatten()
                .take(200)
                .collect(),
        })
    }
}

fn convert(value: &Value) -> Option<Value> {
    let position = |point: &Value| -> Option<Position> {
        Some(Position {
            line: u32::try_from(point.get("line")?.as_u64()?)
                .ok()?
                .checked_sub(1)?,
            character: u32::try_from(point.get("offset")?.as_u64()?)
                .ok()?
                .checked_sub(1)?,
        })
    };
    let start = position(value.get("start")?)?;
    let end = position(value.get("end")?)?;
    let severity = match value.get("category").and_then(Value::as_str) {
        Some("error") => 1,
        Some("warning") => 2,
        _ => 3,
    };
    let message: String = value.get("text")?.as_str()?.chars().take(2000).collect();
    Some(json!({"range":{"start":start,"end":end},"severity":severity,"message":message}))
}

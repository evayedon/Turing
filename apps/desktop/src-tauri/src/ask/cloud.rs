use super::{prompt, Error, Event, Passage};
use reqwest::header::HeaderValue;
use serde::Deserialize;
use tauri::{ipc::Channel, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(crate) const MODEL: &str = "qwen/qwen3-coder";
pub(super) const ID: &str = "openrouter-qwen3-coder";
pub(crate) const ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";

// The native review lists every shared file range; the payload carries those lines.
const CLOUD_BYTES: usize = 24 * 1024;
const REVIEW_TEXT_CHARS: usize = 600;
const SERVICE: &str = "dev.turingcore.ide";
const ACCOUNT: &str = "ask-openrouter";

fn entry() -> Result<keyring::Entry, Error> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| Error::CredentialStore)
}

pub(crate) fn authorization() -> Result<HeaderValue, Error> {
    let key = match entry()?.get_password() {
        Ok(key) => key,
        Err(keyring::Error::NoEntry) => return Err(Error::CloudKeyRequired),
        Err(_) => return Err(Error::CredentialStore),
    };
    let mut value =
        HeaderValue::from_str(&format!("Bearer {key}")).map_err(|_| Error::InvalidCloudKey)?;
    value.set_sensitive(true);
    Ok(value)
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum CredentialAction {
    Status,
    Save { key: String },
    Remove,
}

#[tauri::command]
pub async fn ask_cloud_credential(
    window: WebviewWindow,
    action: CredentialAction,
) -> Result<bool, Error> {
    crate::windows::workbench(&window).map_err(|_| Error::WorkspaceDenied)?;
    tauri::async_runtime::spawn_blocking(move || {
        let entry = entry()?;
        match action {
            CredentialAction::Status => match entry.get_password() {
                Ok(_) => Ok(true),
                Err(keyring::Error::NoEntry) => Ok(false),
                Err(_) => Err(Error::CredentialStore),
            },
            CredentialAction::Save { key } => {
                let key = key.trim();
                if key.is_empty()
                    || key.len() > 512
                    || !key.bytes().all(|byte| byte.is_ascii_graphic())
                {
                    return Err(Error::InvalidCloudKey);
                }
                entry
                    .set_password(key)
                    .map_err(|_| Error::CredentialStore)?;
                Ok(true)
            }
            CredentialAction::Remove => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(false),
                Err(_) => Err(Error::CredentialStore),
            },
        }
    })
    .await
    .map_err(|_| Error::CredentialStore)?
}

pub(super) fn prepare(
    question: &str,
    conventions: Option<&str>,
    passages: &mut Vec<Passage>,
    partial: &mut bool,
    selected: bool,
) -> Result<String, Error> {
    loop {
        let payload = prompt(question, conventions, passages, selected);
        if payload.len() <= CLOUD_BYTES {
            return Ok(payload);
        }
        // Trim retrieved passages only; the user's selection is never dropped.
        if passages.len() <= usize::from(selected) {
            return Err(Error::CloudQuestionTooLong);
        }
        passages.pop();
        *partial = true;
    }
}

pub(super) async fn approve(
    window: &WebviewWindow,
    events: &Channel<Event>,
    payload: String,
    question: &str,
    conventions: Option<&str>,
    passages: &[Passage],
    check: &impl Fn() -> Result<(), Error>,
) -> Result<String, Error> {
    events
        .send(approval_event(passages, payload.len()))
        .map_err(|_| Error::Cancelled)?;
    let review = review(question, conventions, passages, payload.len());
    let window = window.clone();
    approved_payload(payload, review, check, |preview| async move {
        tauri::async_runtime::spawn_blocking(move || {
            window
                .dialog()
                .message(preview)
                .title("Send this Ask request to OpenRouter?")
                .parent(&window)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Send once".into(),
                    "Cancel".into(),
                ))
                .blocking_show()
        })
        .await
        .map_err(|_| Error::InferenceFailed)
    })
    .await
}

/// A rough pre-send estimate (about four bytes per token); OpenRouter reports measured usage.
fn estimated_tokens(bytes: usize) -> usize {
    bytes.div_ceil(4)
}

fn approval_event(passages: &[Passage], bytes: usize) -> Event {
    Event::AwaitingCloudApproval {
        sources: passages
            .iter()
            .map(|passage| passage.source.clone())
            .collect(),
        estimated_input_tokens: estimated_tokens(bytes),
    }
}

fn review(question: &str, conventions: Option<&str>, passages: &[Passage], bytes: usize) -> String {
    let clip = |text: &str| {
        let mut clipped: String = text.chars().take(REVIEW_TEXT_CHARS).collect();
        if clipped.len() < text.len() {
            clipped.push('…');
        }
        dialog_text(&clipped)
    };
    let mut review = format!(
        "OpenRouter ({MODEL}) and its hosting provider will receive the question, the full text of the workspace lines listed below, and any saved conventions. Providers that store or train on request data are excluded. This approval applies to one request ({} KB, ≈{} input tokens (estimate)).\n\nQuestion: {}",
        bytes.div_ceil(1024),
        estimated_tokens(bytes),
        clip(question)
    );
    if let Some(conventions) = conventions {
        review.push_str("\nConventions: ");
        review.push_str(&clip(conventions));
    }
    if passages.is_empty() {
        review.push_str("\n\nNo workspace lines are included.");
    } else {
        review.push_str("\n\nWorkspace lines:");
        for passage in passages {
            let source = &passage.source;
            review.push_str(&format!(
                "\n• {}:{}–{}",
                clip(&source.relative_path),
                source.start_line,
                source.end_line
            ));
        }
    }
    review
}

async fn approved_payload<F: std::future::Future<Output = Result<bool, Error>>>(
    payload: String,
    review: String,
    check: &impl Fn() -> Result<(), Error>,
    confirm: impl FnOnce(String) -> F,
) -> Result<String, Error> {
    check()?;
    if !confirm(review).await? {
        return Err(Error::CloudConsentDeclined);
    }
    check()?;
    Ok(payload)
}

pub(crate) fn dialog_text(payload: &str) -> String {
    let mut visible = String::with_capacity(payload.len());
    for ch in payload.chars() {
        // GTK's native message description is a printf format string.
        // Show bidi controls explicitly so they cannot reorder the preview.
        if matches!(ch, '%' | '<' | '>' | '\u{061c}' | '\u{200b}'..='\u{200f}' | '\u{2028}'..='\u{202e}' | '\u{2060}'..='\u{206f}')
        {
            visible.extend(ch.escape_unicode());
        } else {
            visible.push(ch);
        }
    }
    visible
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn renders_dialog_metacharacters_and_bidi_controls_as_literal_escapes() {
        assert_eq!(
            dialog_text("first 50% <tag> \u{202e}"),
            r"first 50\u{25} \u{3c}tag\u{3e} \u{202e}"
        );
    }

    #[test]
    fn includes_saved_conventions_inside_the_reviewed_cloud_payload() {
        let payload = prepare(
            "How?",
            Some("Use snake_case."),
            &mut Vec::new(),
            &mut false,
            false,
        )
        .unwrap();
        assert!(payload.contains("User-approved project conventions: \"Use snake_case.\""));
    }

    fn passage(path: &str, text: String) -> Passage {
        Passage {
            source: crate::ask::Source {
                relative_path: path.into(),
                version: "v1".into(),
                start_line: 1,
                end_line: 12,
            },
            text,
            score: 1,
        }
    }

    #[test]
    fn trims_cloud_payload_and_lists_every_shared_range_in_the_review() {
        let mut passages: Vec<_> = (0..8)
            .map(|index| passage(&format!("src/{index}%.rs"), "x".repeat(6 * 1024)))
            .collect();
        let mut partial = false;
        let payload = prepare("Where?", None, &mut passages, &mut partial, false).unwrap();
        assert!(payload.len() <= CLOUD_BYTES);
        assert!(partial);
        assert_eq!(passages.len(), 3);
        let review = review("50% <done>", Some("Tabs"), &passages, payload.len());
        assert!(review.contains("Question: 50\\u{25} \\u{3c}done\\u{3e}"));
        assert!(review.contains("Conventions: Tabs"));
        assert!(review.contains("Providers that store or train on request data are excluded."));
        for index in 0..3 {
            assert!(review.contains(&format!("• src/{index}{}.rs:1–12", r"\u{25}")));
        }
        assert!(!review.contains("src/3"));
        assert!(review.contains(&format!(
            "({} KB, ≈{} input tokens (estimate))",
            payload.len().div_ceil(1024),
            payload.len().div_ceil(4)
        )));
        let event = serde_json::to_value(approval_event(&passages, payload.len())).unwrap();
        assert_eq!(event["kind"], "awaitingCloudApproval");
        assert_eq!(event["estimatedInputTokens"], payload.len().div_ceil(4));
        assert_eq!(event["sources"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn keeps_the_selection_first_while_trimming_and_fails_when_it_alone_is_too_long() {
        let mut passages: Vec<_> = (0..8)
            .map(|index| passage(&format!("src/{index}.rs"), "x".repeat(6 * 1024)))
            .collect();
        let selection = passage("src/chosen.rs", "y".repeat(16 * 1024));
        assert!(crate::ask::with_selection(&mut passages, Some(selection)));
        let mut partial = false;
        let payload = prepare("Why?", None, &mut passages, &mut partial, true).unwrap();
        assert!(payload.len() <= CLOUD_BYTES);
        assert!(partial);
        assert_eq!(passages[0].source.relative_path, "src/chosen.rs");
        assert!(payload.contains(r#"{"endLine":12,"file":"src/chosen.rs","id":1"#));
        assert!(review("Why?", None, &passages, payload.len()).contains("• src/chosen.rs:1–12"));

        // JSON escaping doubles quotes, so this 16 KiB selection cannot fit by itself.
        let mut passages = vec![passage("src/chosen.rs", "\"".repeat(16 * 1024))];
        assert_eq!(
            prepare("Why?", None, &mut passages, &mut false, true),
            Err(Error::CloudQuestionTooLong)
        );
        assert_eq!(passages.len(), 1);
    }

    #[test]
    fn approval_binds_the_payload_and_rechecks_workspace_access() {
        tauri::async_runtime::block_on(async {
            let payload = String::from("Question and workspace excerpt");
            assert_eq!(
                approved_payload(payload.clone(), "Review".into(), &|| Ok(()), |_| async {
                    Ok(false)
                })
                .await,
                Err(Error::CloudConsentDeclined)
            );
            assert_eq!(
                approved_payload(
                    payload.clone(),
                    "Review".into(),
                    &|| Ok(()),
                    |preview| async move {
                        assert_eq!(preview, "Review");
                        Ok(true)
                    }
                )
                .await,
                Ok(payload.clone())
            );
            let revoked = Cell::new(false);
            let check = || {
                if revoked.get() {
                    Err(Error::WorkspaceDenied)
                } else {
                    Ok(())
                }
            };
            assert_eq!(
                approved_payload(payload, "Review".into(), &check, |_| async {
                    revoked.set(true);
                    Ok(true)
                })
                .await,
                Err(Error::WorkspaceDenied)
            );
        });
    }
}

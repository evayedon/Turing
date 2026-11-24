use super::{prompt, Error, Event, Passage};
use reqwest::header::HeaderValue;
use serde::Deserialize;
use tauri::{ipc::Channel, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

pub(super) const MODEL: &str = "qwen/qwen3-coder";
pub(super) const ID: &str = "openrouter-qwen3-coder";
pub(super) const ENDPOINT: &str = "https://openrouter.ai/api/v1/chat/completions";

// Bound the content shown in the native dialog. The same payload goes to OpenRouter.
const PREVIEW_BYTES: usize = 1800;
const SERVICE: &str = "dev.turingcore.ide";
const ACCOUNT: &str = "ask-openrouter";

fn entry() -> Result<keyring::Entry, Error> {
    keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| Error::CredentialStore)
}

pub(super) fn authorization() -> Result<HeaderValue, Error> {
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
    passages: &mut Vec<Passage>,
    partial: &mut bool,
) -> Result<String, Error> {
    loop {
        let payload = prompt(question, passages);
        if payload.len() <= PREVIEW_BYTES && dialog_text(&payload).len() <= PREVIEW_BYTES {
            return Ok(payload);
        }
        if passages.pop().is_none() {
            return Err(Error::CloudQuestionTooLong);
        }
        *partial = true;
    }
}

pub(super) async fn approve(
    window: &WebviewWindow,
    events: &Channel<Event>,
    payload: String,
    check: &impl Fn() -> Result<(), Error>,
) -> Result<String, Error> {
    events
        .send(Event::AwaitingCloudApproval)
        .map_err(|_| Error::Cancelled)?;
    let window = window.clone();
    approved_payload(payload, check, |preview| async move {
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

async fn approved_payload<F: std::future::Future<Output = Result<bool, Error>>>(
    payload: String,
    check: &impl Fn() -> Result<(), Error>,
    confirm: impl FnOnce(String) -> F,
) -> Result<String, Error> {
    check()?;
    let visible = dialog_text(&payload);
    let preview = format!(
        "OpenRouter ({MODEL}) and its hosting provider will receive the question and workspace excerpts below. This approval applies to one request.\n\n{visible}"
    );
    if !confirm(preview).await? {
        return Err(Error::CloudConsentDeclined);
    }
    check()?;
    Ok(payload)
}

fn dialog_text(payload: &str) -> String {
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
    fn rejects_questions_that_do_not_fit_the_review_dialog() {
        let question = "%".repeat(PREVIEW_BYTES / 2);
        assert_eq!(
            prepare(&question, &mut Vec::new(), &mut false),
            Err(Error::CloudQuestionTooLong)
        );
    }

    #[test]
    fn approval_binds_the_payload_and_rechecks_workspace_access() {
        tauri::async_runtime::block_on(async {
            let payload = String::from("Question and workspace excerpt");
            assert_eq!(
                approved_payload(payload.clone(), &|| Ok(()), |_| async { Ok(false) }).await,
                Err(Error::CloudConsentDeclined)
            );
            assert_eq!(
                approved_payload(payload.clone(), &|| Ok(()), |preview| async move {
                    assert!(preview.ends_with("Question and workspace excerpt"));
                    Ok(true)
                })
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
                approved_payload(payload, &check, |_| async {
                    revoked.set(true);
                    Ok(true)
                })
                .await,
                Err(Error::WorkspaceDenied)
            );
        });
    }
}

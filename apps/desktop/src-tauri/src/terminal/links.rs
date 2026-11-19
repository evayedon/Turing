use super::{in_terminal, Result, TerminalError};
use tauri::{Url, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

fn external_url(input: &str) -> Result<Url> {
    if input.len() > 2048 || input.chars().any(char::is_control) {
        return Err(TerminalError::InvalidLink);
    }
    let url = Url::parse(input).map_err(|_| TerminalError::InvalidLink)?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(TerminalError::InvalidLink);
    }
    Ok(url)
}

#[tauri::command]
pub async fn terminal_open_link(window: WebviewWindow, target: String) -> Result<()> {
    let url = external_url(&target)?;
    in_terminal(window, move |window| {
        let approved = window
            .dialog()
            .message(format!("Open this address in your browser?\n\n{url}"))
            .title("Open Terminal Link")
            .parent(&window)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show();
        if approved {
            crate::windows::resource(&window).map_err(|_| TerminalError::PermissionDenied)?;
            open(url.as_str())?;
        }
        Ok(())
    })
    .await
}

#[cfg(unix)]
fn open(url: &str) -> Result<()> {
    let opener = if cfg!(target_os = "macos") {
        "/usr/bin/open"
    } else {
        "/usr/bin/xdg-open"
    };
    let status = std::process::Command::new(opener)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|_| TerminalError::IoError)?;
    if status.success() {
        Ok(())
    } else {
        Err(TerminalError::IoError)
    }
}

#[cfg(windows)]
fn open(url: &str) -> Result<()> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    let target: Vec<u16> = url.encode_utf16().chain([0]).collect();
    let outcome = unsafe {
        ShellExecuteW(
            null_mut(),
            null(),
            target.as_ptr(),
            null(),
            null(),
            SW_SHOWNORMAL,
        )
    };
    if outcome as isize > 32 {
        Ok(())
    } else {
        Err(TerminalError::IoError)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_links_without_credentials_can_reach_the_native_prompt() {
        for input in [
            "file:///etc/passwd",
            "https://user:pass@example.test",
            "https://example.test/\n",
            "javascript:alert(1)",
            "--help",
        ] {
            assert_eq!(external_url(input), Err(TerminalError::InvalidLink));
        }
        assert_eq!(
            external_url("https://example.test/a?q=1")
                .unwrap()
                .host_str(),
            Some("example.test")
        );
    }
}

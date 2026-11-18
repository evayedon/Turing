# Architecture

| Path                        | Responsibility                                              |
| --------------------------- | ----------------------------------------------------------- |
| `apps/desktop/src/shell`    | React workbench and panel placeholders                      |
| `apps/desktop/src/editor`   | Monaco models, tabs, unsaved state, and editor actions      |
| `apps/desktop/src/explorer` | Explorer UI, navigation state, and typed native IPC adapter |
| `apps/desktop/src/state`    | Zustand layout state and state transition tests             |
| `apps/desktop/src-tauri`    | Native window, native pickers, and scoped file operations   |
| `packages/contracts`        | Shared TypeScript types and workspace command contracts     |
| `packages/design-system`    | Turing Nebula color and typography tokens                   |

The workbench uses the same React entry point in Tauri and browser preview.
Its File menu can open a folder or an individual file, create an untitled
document, save, save as, or close a tab. Folder changes affect workspace tabs.
Standalone files and untitled documents keep their own tabs. Browser preview
supports in-memory untitled editing with filesystem actions disabled. Monaco
and its workers are bundled locally and loaded on demand. Each tab keeps a
Monaco model separate from its saved snapshot. Terminal, Git, and AI remain
placeholder surfaces.

## Workspace authorization

The local `main` webview has explicit permissions for workspace commands,
selected-file commands, and editor lifecycle commands. The pickers and
confirmation dialogs run in Rust. The webview has no generic dialog,
filesystem, or shell permissions. Production uses embedded assets and a content security policy that
allows Tauri IPC and same-origin workers, permits Monaco's dynamic styles, and
blocks other outbound connections. The Vite dev server binds to loopback.

Rust creates one in-memory registration from the native picker result. It
canonicalizes the selection, opens the canonical directory without following
replacement symlinks, and retains its directory handle. Operations check the
Tauri-supplied caller and active registration together. Closing or replacing the
registration invalidates its old ID. Canceling the picker leaves the
registration as it was.

Client paths use slash-separated workspace-relative components, with an empty
path for the workspace root. Traversal, absolute paths, Windows stream syntax,
and symbolic links are rejected. Handle-relative opens disable symlink following
at each component. Listings omit links, special entries, and names the IPC
cannot represent, and are limited to 10,000 entries per folder. Reads return
regular UTF-8 text up to 2 MiB with an opaque version based on file identity, modification time, and content.

## Individual files and Save As

Opening a native file selection registers one filename within a retained parent
directory handle. The opaque, caller-bound grant supports reading and saving
that file independently of any workspace. Closing its last tab revokes the
grant. No IPC command accepts an absolute path for file authority.

Saving an untitled document and Save As use the native destination picker.
Rust asks for explicit confirmation before replacing an existing file and
binds that confirmation to the observed destination version. A new file is
staged and published only while the destination name is vacant. A competing
creation or a changed confirmed version leaves the editor draft intact.

## Editor saves and conflicts

Ordinary saves apply to existing workspace and individually approved text files. Rust verifies the caller, path,
write access, size, encoding, and expected version. The replacement is staged
and synced in the same directory. Rust revalidates the target and parent
identity before publishing. On macOS and Linux an atomic, handle-relative swap
keeps the displaced entry available for verification. On Windows the original
moves to a recovery name and a hard link publishes the staged file only while
the destination is vacant. That sequence can briefly leave the target name
absent. Filesystems lacking the required primitives report an error.

A concurrent change can leave `.turing-save-*` recovery files next to the
document. The editor retains its draft and reports the conflict. Ordinary Unix
permission bits are carried forward. Replacement creates a new inode, so hard
link associations, extended attributes, and custom ACLs are outside the current
save guarantees. File checks on focus and every four seconds cover the active
tab. Each save checks its version independently.

The File menu's Auto Save setting is off at startup and applies for the current
session. It waits one second before saving changed, already named desktop tabs
through the same version-checked commands. Edits made during a write remain in
the draft. Failed writes stay dirty and pause automatic retries for that tab.
Known disk conflicts require the normal reload or Save As workflow. Untitled
documents still use the native picker on explicit Save, and browser preview
keeps its drafts in memory.

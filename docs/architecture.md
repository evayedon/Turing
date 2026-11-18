# Architecture

| Path                        | Responsibility                                              |
| --------------------------- | ----------------------------------------------------------- |
| `apps/desktop/src/shell`    | React workbench and panel placeholders                      |
| `apps/desktop/src/explorer` | Explorer UI, navigation state, and typed native IPC adapter |
| `apps/desktop/src/state`    | Zustand layout state and state transition tests             |
| `apps/desktop/src-tauri`    | Native window, folder picker, and read-only registry        |
| `packages/contracts`        | Shared TypeScript types and workspace command contracts     |
| `packages/design-system`    | Turing Nebula color and typography tokens                   |

The workbench runs in a browser for development and uses the same React entry
point inside Tauri. The desktop Explorer browses an approved workspace one
directory at a time. Browser preview shows that native workspace access is
unavailable. Monaco, Terminal, Git, and AI remain placeholder surfaces.

## Workspace authorization

The local `main` webview has explicit permissions for `workspace_open`,
`workspace_close`, `fs_list_directory`, and `fs_read_file`. The native picker is
called from Rust. The webview has no generic dialog, filesystem, or shell
permissions. Production uses embedded assets and a content security policy that
allows Tauri IPC and blocks other outbound connections. The Vite dev server
binds to loopback.

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
regular UTF-8 text up to 2 MiB with an opaque content version. The read command
is available through the typed bridge and the Explorer displays directory entries.

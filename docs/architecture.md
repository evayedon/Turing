# Architecture

| Path                        | Responsibility                                              |
| --------------------------- | ----------------------------------------------------------- |
| `apps/desktop/src/shell`    | React workbench and panel placeholders                      |
| `apps/desktop/src/editor`   | Monaco models, tabs, unsaved state, and editor actions      |
| `apps/desktop/src/explorer` | Explorer UI, navigation state, and typed native IPC adapter |
| `apps/desktop/src/search`   | Workspace search form, cancellation and grouped results     |
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
Monaco model separate from its saved snapshot. Git and AI remain placeholder
surfaces.

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

## Workspace search

The Search activity view submits a literal, single-line query within the active
folder. Match Case and Whole Word are optional; word boundaries treat Unicode
letters and numbers and underscore as word characters. The optional filename
filter is a case-insensitive basename substring such as `.tsx`. Path syntax
and glob expansion are unsupported. Query and filter each accept up to
256 UTF-8 bytes. Search reads disk snapshots, so unsaved editor text is
excluded. Clicking a result opens the authorized relative file in Monaco at
the reported one-based line and UTF-16 column. Monaco clamps coordinates if the
file or its open draft has since changed.

The local main webview may reserve, execute, or cancel a search through an
explicit Tauri capability. Every command requires an active caller-bound
workspace. Rust clones the approved directory handle for a blocking worker,
releases the registry lock before scanning, and rechecks authorization before
returning results. Closing or replacing the workspace revokes the search.
Closing the sidebar also cancels the current UI request. Traversal skips links
and special entries, revalidates parent directory identity around reads, and
uses the existing 2 MiB UTF-8 text snapshot checks. Unreadable, unsupported
or changing entries are skipped and counted when encountered as read errors.
Browser preview has no workspace-search IPC access.

Search skips directories named `.git`, `.hg`, `.svn`, `node_modules`,
`target`, `dist`, `build`, `.next`, `.nuxt`, `.venv`, `venv`,
`__pycache__`, `coverage`, or `.cache` at any depth, case-insensitively.
It also omits Turing save staging and recovery entries prefixed with
`.turing-save-`. This fixed list does not interpret `.gitignore`.
One scan runs at a time, with at most 500 matches, 50,000 entries, 32 levels
of subdirectories, 128 MiB read, and a cooperative 10-second time budget.
The scanner reserves up to one maximum-size read before visiting the next entry.
Search reports partial results when it hits a limit. Cancellation and the
deadline are checked during scanning. An OS filesystem call already in progress
can delay either. Results are grouped by file and include short snippets.

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

## Workbench layout

Nebula styling uses the shared design tokens. The File menu and command palette
share editor actions. Explorer expands the current branch in place using scoped
directory listings. Monaco reports the active language, line ending, and caret
position when available. Panel dimensions and visibility use versioned local
preferences. These preferences contain only layout values.

The bottom dock offers Terminal, Problems, and Output views and uses the same
layout controls as the side panels. Problems and Output display availability
messages.

## Integrated terminal

The bottom dock starts collapsed for new profiles and honors saved visibility
and tab preferences. A restored Terminal tab shows an inactive state with
**Start terminal**. Selecting Terminal, revealing it with the activity control,
or invoking **Open Terminal** (Ctrl+backtick) opens and focuses one interactive
session. Layout restoration and workspace changes leave an idle shell stopped. Switching dock tabs or hiding the dock keeps the
session and its scrollback. **Close terminal** ends the shell. Shell exit leaves
output visible until the next start, and failed startup offers a retry. Browser
preview has no terminal access.

Rust chooses the executable, arguments and working directory. On macOS and Linux,
it tries an absolute configured shell, then the platform's system shell and
`/bin/sh`. The child uses `fchdir` on the active workspace's authorized directory
handle, so path replacement cannot redirect it. Windows uses system PowerShell
or Command Prompt and starts in the user's profile directory or the system
directory as a fallback. ConPTY's path-based launch cannot consume the retained
workspace handle. Without a workspace, Unix starts in the user's home or root
directory. Changing workspaces leaves an existing shell in its current directory.

The local main webview capability allows only terminal start, input, output,
resize and close. Rust checks the caller, the session ID, and any requested
workspace grant. It accepts terminal bytes and dimensions with explicit limits.
There is no process-launch IPC taking an executable, arguments, environment or
filesystem path. The shell runs with the user's OS privileges. Any future AI
terminal access requires its own authorization and integration.

xterm.js is loaded on explicit start. The renderer reads one batch at a time and
waits for xterm to process each batch. Rust buffers up to 32 output chunks of
8 KiB with PTY backpressure and queues up to 16 input chunks of 8 KiB. The
renderer bounds pending input and retains 2,000 lines of scrollback. Each session
owns its input and output workers, and closing it releases both queues. The
application closes sessions when the main window is destroyed or the app exits.
Unix signals the foreground and shell process groups during explicit close,
hangs up the PTY and reaps the shell. Detached Unix processes can outlive the
session. Windows assigns the shell to a kill-on-close Job Object after ConPTY
starts it, so processes created before assignment or detached outside the job
can outlive it.

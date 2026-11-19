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
layout controls as the side panels. Output shows Run & Build progress.
Problems remains an availability surface.

## Integrated terminal

The bottom dock starts collapsed for new profiles and honors saved visibility
and tab preferences. A restored Terminal tab shows an inactive state with
**Start terminal**. Selecting Terminal, revealing it with the activity control,
or invoking **Open Terminal** (Ctrl+backtick) starts or focuses the selected
session. Layout restoration and workspace changes leave idle shells stopped.
Switching dock tabs or hiding the dock keeps the sessions and scrollback. **Close terminal** ends the shell. Shell exit leaves
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

The local workbench and dedicated terminal webview capabilities grant terminal
start, input, output, resize and close. Rust checks the window owner, the
session ID, and any requested window-specific workspace grant. It accepts terminal bytes and dimensions with explicit limits.
There is no process-launch IPC taking an executable, arguments, environment or
filesystem path. The shell runs with the user's OS privileges. Any future AI
terminal access requires its own authorization and integration.

xterm.js is loaded on explicit start. The renderer reads one batch at a time and
waits for xterm to process each batch. Rust buffers up to 32 output chunks of
8 KiB with PTY backpressure and queues up to 16 input chunks of 8 KiB. The
renderer bounds pending input and retains 2,000 lines of scrollback. Each session
owns its input and output workers, and closing it releases both queues. The application closes each window's sessions when it is destroyed and
cleans up remaining sessions at application exit.
Unix signals the foreground and shell process groups during explicit close,
hangs up the PTY and reaps the shell. Detached Unix processes can outlive the
session. Windows assigns the shell to a kill-on-close Job Object after ConPTY
starts it, so processes created before assignment or detached outside the job
can outlive it.

## Run & Build

Use **Run File** or F5 in the desktop workbench to run the active saved source.
Save changes before running. Untitled files must acquire an authorized file
through Save As. If the saved revision changes on disk, reload the file first.
One Run & Build job per workbench can be active while its terminal sessions
continue.

Supported sources are Python 3.7+ (`.py`) and single-file C++17 (`.cpp`,
`.cc`, `.cxx`). The application looks for Python and for clang++ or g++ in
absolute directories on its inherited PATH. These tools must be installed and
functional on the host, including any system C++ headers and linker. On Windows,
use an installed compiler with its target toolchain available. Project build
systems, sibling imports or headers, custom flags, external libraries that
require extra link arguments, and multiple source files are outside this
workflow.

Rust checks caller ownership and reads the versioned source through the existing
workspace or standalone file grant. It stages those exact bytes in a unique
OS temporary directory and constructs process arguments itself. A successful C++
compile runs the binary created for that run. Failure leaves the compiler's
diagnostics in Output. Scratch files are cleaned up when the worker finishes.
Python's `__file__` and compiler diagnostic paths point at staged files.
On Unix the child starts through the retained workspace root or standalone
parent directory handle. On Windows the child starts in the scratch directory
because standard process launch accepts a path for its working directory.

Output distinguishes compiler stdout and stderr from program stdout and stderr.
It reports phase, exit code, elapsed time, and Stop. Output retains at most
256 KiB per run and decodes UTF-8 with replacement for invalid bytes, including
legacy compiler encodings. Compiler diagnostics remain text in Output.
Stdin is closed, so programs receive EOF. Use the integrated terminal to run
programs that need interactive input.

The dedicated local-workbench capability accepts only a saved file grant and
version, then an opaque Run ID for reading and stopping. Phase notifications
use a per-run Tauri channel. The shell terminal and any future AI integration
have separate authorization paths. Code executes with the user's OS privileges.
The compiler is limited to 60 seconds and the program to 30 seconds. Stop and
normal app shutdown cancel active subprocesses. Unix uses a process group for
cancellation and disables core dumps. Windows uses a Job Object. On Unix, a program that exits normally can leave
children running. Processes that escape cancellation or start before Windows
job assignment can also outlive a run. An app crash can leave scratch files
for OS cleanup.

## Explorer naming and language modes

**New File** in the File menu still opens an untitled buffer. Its editor
toolbar uses **Save As…** and the native picker supplies the first saved name.
For an untitled buffer with strong syntax evidence or an explicitly chosen
language, the picker can suggest an extension. The tab gains a native file
grant only after the save succeeds.

**New workspace file** in Explorer creates an empty named file in the current
folder using exclusive creation. F2 or the row's **Rename** action edits a file
or folder name inline. Rust accepts a single new name and checks the caller,
root, parent, and listed entry identity. Rename stays within the original
parent and never replaces a destination. On Unix it verifies the source in
a private staging directory before publishing the new name. Windows uses a
source handle and a parent-relative rename with replacement disabled. Refresh
the listing if another operation replaces an entry. If a concurrent operation
also prevents an exclusive Unix rollback, the entry is retained in a
`.turing-save-*.rename` recovery directory.

A successful Explorer rename changes the paths of workspace tabs in the
renamed subtree while keeping the existing buffer, saved revision, and model.
Separate standalone picker grants do not move with Explorer entries. Reopen a
standalone file through its new path if the original grant becomes stale.

The status-bar language menu can switch between automatic and explicit
per-document modes. Saved files use filename metadata from the bundled Monaco
language definitions. Untitled files use a small set of conservative content
suggestions. Monaco changes tokenization on the existing model to retain undo
and cursor state. The model's synthetic URI is stable, so filename-sensitive
worker diagnostics can still use the original extension until the tab is
reopened. Run File uses the authorized saved extension independently of the
editor's language mode.

## Workbench commands

The Nebula menu bar, command palette, and workbench shortcuts share typed
command identifiers and availability checks. Save, Run, and Stop reuse the
editor and execution handlers. Monaco owns its editor bindings, clipboard
commands, and undo stack. Symbol navigation appears when Monaco reports an
available provider. System clipboard commands depend on the WebView's
clipboard capabilities.

Go to File lists open editors and scans the approved workspace using bounded
directory listings. It skips generated dependency folders and also offers the
native file picker. Close All asks once before discarding dirty editors and
releases standalone native file grants. Show Terminal reveals the dock
without starting a session. Open Terminal explicitly starts or focuses the
selected session, and Clear Terminal clears its visible buffer through xterm.

## Workbench windows and terminal sessions

**New Window** opens a separate local Tauri workbench. The app registers its
opaque window label before creation and keeps a distinct workspace registry,
execution service, and terminal service for that window. The frontends keep
their editor and dock state in separate webviews. Local preferences and
recent history are shared. A workbench closes through its own unsaved-change
flow. Destroying a window revokes its grants and cleans up its runs and PTYs.
The app allows up to twelve windows.

**Open Recent** stores up to twenty recent native workspace and standalone file
paths in local preferences. Entries only seed a native picker. The user must
make a fresh selection, and Rust then performs its normal authorization. If a
resource moved or was deleted, select its new location or clear the history.

**New Terminal** adds an independent PTY tab. **Split Terminal** shows two
independent panes and permits keyboard or pointer resizing. The renderer keeps
each PTY's measured dimensions in sync and can remove a tab without closing
its neighbors. There are at most four sessions per window. **New Terminal
Window** opens an idle terminal-only application window with no workspace,
editor, or Run & Build capability. Use **Start terminal** or **New terminal
session** in that window to start a shell. Closing it cleans up its sessions.
PTYs execute with the user's operating-system privileges.

## Code navigation and debugging status

Definition, declaration, implementation, and references use Monaco's
registered providers. The menu disables operations when the active model has
no provider. Cross-file destinations must belong to an already-open document
or use the active workspace's synthetic model URI. New workspace reads still
go through Rust's authorized file command. Monaco's bundled providers may be
limited to loaded models. Full project navigation for Python and C++ needs a
language-server integration.

F5 is **Run Without Debugging**. Debugging remains unavailable until Turing
has a scoped debug-adapter transport, authorized launch and stop handling,
verified breakpoint mapping, and paused-process controls. No generic debugger
launch command or debugger shortcut is registered.

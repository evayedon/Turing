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

## IPC contract fixtures

`packages/contracts/fixtures/ipc-contract.json` is the shared description of
values that cross the Tauri IPC boundary: every native error code per domain
(plus client-only codes such as the terminal's `START_TIMEOUT`), serialized
enum values, and representative payloads, including nulls and Unicode text.

- Rust `contract_tests` modules serialize native values and require exact
  equality with each fixture case, so renamed fields, casing changes, extra
  fields and `null`-versus-omitted drift fail. Each error and enum list also
  has an exhaustive `match`, so a new Rust variant does not compile until it is
  added to the test and the fixture. Fixture cases without native coverage
  fail as well.
- `apps/desktop/src/contracts/ipc-contract.test.ts` describes each TypeScript
  contract with compile-checked shapes. Changing a contract's fields,
  optionality, nullability or error union fails typecheck until the shape is
  updated, and a shape that disagrees with the fixtures fails the test.

Change a contract by updating the Rust type, the TypeScript type and the
fixture together. Request argument types are not covered yet.

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

## Workspace symbols

**Go → Go to Symbol in Workspace** (Ctrl+T or Cmd+T) opens a searchable
quick-pick. It debounces queries, refreshes while open, and discards replies
when the query, workspace, or picker changes. Selecting a symbol opens its
authorized file and reveals its zero-based line and UTF-16 character offset
through the editor's location navigation.

`workspace_symbols_query` is an explicit workbench-only permission. Rust
checks the caller and workspace registration before reading the index and
checks the approved root identity before issuing a reply. Each response carries
the registration generation, a `complete` flag for the current indexing pass,
and a `truncated` flag for scan or result limits. Queries match case-insensitive
terms against declaration names, prefer prefixes, and return up to 100 results.
An empty query lists the first symbols in path and source order.

The first query starts a native worker for the registration. It extracts
single-line declarations from saved TypeScript, JavaScript, Rust, Python,
and C/C++ files. Extraction is lexical and best-effort. Overloads are listed
individually, and declarations that require multiline or semantic analysis may
be missed. The index works independently of the managed clangd session.

The worker reuses Search's directory walker, exclusions, entry and depth limits,
and handle-relative snapshots. Each pass can read up to 12,000 source files,
256 KiB per file and 128 MiB total. It stops parsing a file at any source line
larger than 16 KiB. The index stores at most 256 declarations per
file and 30,000 overall. It checks for cancellation between entries and source
lines, with a cooperative 10-second budget per pass. A filesystem call in
progress can delay cancellation. Closing or replacing a workspace, reloading
the page, and destroying the window all cancel and discard its worker.

The watcher coalesces an independent copy of change hints for the index.
Updates replace or remove the affected file or directory subtree using
authorized reads. A rescan hint triggers a full pass. Global truncation remains
visible until a full pass can cover the workspace. While a pass is running,
queries return an incomplete response without entries from the prior pass. If
the OS watcher cannot start, the worker rescans every 15 seconds. An index
test scans 4,000 files within the traversal budget and switches workspaces
halfway through a second scan to verify cancellation and stale registration
denial.

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
tab, and workspace watcher events revalidate every touched tab (see
[Workspace watcher](#workspace-watcher)). Each ordinary save checks its version
independently. When the target of a workspace tab has disappeared, explicit
Save offers native confirmation to recreate it.
The authorized write rechecks the root and parent and publishes the staged
text only if the destination is still vacant. A process that restores the
name first keeps its file.

The File menu's Auto Save setting is off at startup and applies for the current
session. It waits one second before saving changed, already named desktop tabs
through the same version-checked commands. Edits made during a write remain in
the draft. Failed writes stay dirty and pause automatic retries for that tab.
Known disk conflicts require explicit resolution. Keep mine leaves the
draft and conflict in place. Compare with disk reads an authorized snapshot
and shows it beside the editor text. Reload asks before discarding dirty text.
Save As can preserve the draft in a separate file. Untitled
documents still use the native picker on explicit Save, and browser preview
keeps its drafts in memory.

### Document identity and revisions

Every tab carries a canonical `uri` for its current source
(`turing-workspace://<workspace>/<path>`, `turing-file://<grant>`, or
`untitled:<name>`) and a `revision` that advances whenever that source or its
saved state changes: open, save, reload, rename and Save As. Typing changes
only `editRevision`. Asynchronous replies (saves, reloads and disk checks)
apply only while the tab still has the revision they were issued for, so a
late reply cannot overwrite a renamed, reloaded or re-saved document.

User actions that arrive while Auto Save is writing (close, rename, reload,
Save, Save As and workspace changes) wait for that write and then act on the
latest tabs, instead of being dropped. All tab changes go through one commit
path that keeps a synchronous copy of the latest state, so resumed work never
writes back a stale snapshot. A file read or creation that finishes after its
workspace was closed or replaced is discarded instead of opening a tab, and a
revoked grant surfaces as a save error that keeps the draft.

### Editor groups

The editor area starts with one group. Split Editor Right opens the current
document in a new group beside the source. Explorer and navigation open
documents in the active group. Move Editor into Next Group moves the active
tab to the group on its right, creating one when the source has other tabs
and is already at the right edge. View → Editor Layout and the command
palette expose the split, move, close and focus commands.

`editor-groups.ts` tracks each group's ordered document keys and selected tab,
plus the active group. `use-editor.ts` owns one document record per key,
including its URI, revision, draft, dirty state and save lifecycle. Closing a
tab or group prompts for unsaved changes only for documents that would lose
their last tab. Workspace changes remove the departing workspace's documents
from every group.

The editor workspace owns a Monaco model registry keyed by document key.
Each group has its own editor instance and saves its own cursor, selection
and scroll for each document. Views share model content, undo history and
Problems markers. A shared edit updates the document record once per model
version. The registry retains models for open tabs, including inactive tabs,
and disposes them after the last group drops the tab and the views have
detached. The primary group registers language providers for all visible
models. Editor commands, status and Problems navigation (including F8)
follow the active group.

### Draft recovery

Rust owns the journal under the directory returned by Tauri’s
`app_local_data_dir()`, in `draft-recovery-default` for the current profile.
Unix directory and file permissions are `0700` and `0600`. Records use a
versioned header, length and SHA-256 checksum. Rust writes and syncs a
temporary file in the journal directory, renames it into place, and syncs
the directory on Unix. It ignores stale temporary files.
Record file names are Rust-derived 64-character SHA-256 keys. Any other
ID is rejected before it reaches the filesystem. Damaged records
are skipped with a workbench notice and count toward the cap until they
expire. The journal contains unsaved source text,
and the application excludes it from logs.

A document is keyed by the approved root’s filesystem identity and its
workspace-relative URI, or by its selected-file URI or generated untitled
URI. A Rust-generated workbench instance ID scopes writes, so two windows
may independently edit the same document. Groups within a workbench share
one document and one snapshot. One native process holds the profile journal
lock. Additional app processes using that profile get a recovery storage
error while the lock is held. After relaunch, the first workbench to list
orphaned drafts claims them. Other windows can claim unresolved drafts on
their next list after that workbench closes or reloads.

React coalesces updates into one snapshot per buffer per 400 ms and requests
a flush on hide or page unload. A forced termination can lose edits made
since the last durable snapshot. Drafts at or above 131,072 UTF-16 code units
skip snapshotting. The journal caps records at 1 MiB each, 32 MiB total, and
256 records. Orphaned, unclaimed drafts expire after 30 days and are removed
oldest first. Active and claimed drafts are retained. When a size limit or
write error blocks a snapshot, the editor identifies the affected document
and keeps the in-memory draft and any previous durable snapshot. A normal
close after confirmed discard clears that workbench’s own records.

On startup, the workbench validates and imports legacy WebView localStorage
drafts. Rust uses a deterministic ID to make retrying the import safe. The
workbench deletes a legacy key only after Rust acknowledges the durable
write.

**Recover unsaved drafts** offers Restore and Discard. Workspace drafts
stay pending until the original workspace is approved in the receiving
workbench. Rust checks the approved root identity for native snapshots and
the approved display path for legacy entries. This lookup grants no file
access. Restore uses the normal authorized read and compares base versions.
A version mismatch preserves the newer disk text and offers Compare and
Save As. Missing or renamed files recover as untitled copies with a notice.
Standalone and untitled drafts also recover as untitled copies. Recovered
tabs are unsaved, and Auto Save skips them. Save, successful reload, or
confirmed discard resolves the snapshot. Restoring opens the draft in the
active editor group and replaces the old record only after the new snapshot
is durable. Closing a group with a remaining view keeps the draft.

## Workspace watcher

Rust starts one recursive OS watcher (the `notify` crate: FSEvents, inotify or
ReadDirectoryChangesW) for each approved workspace registration when
`workspace_open` succeeds. The watcher is created without holding the registry
lock and is attached only if the same caller and registration are still
active, so a watcher that finishes starting after a close or replacement is
dropped. Watching is best effort: if it cannot start, the workspace still
opens and the views keep their manual and periodic checks.

**Security model.** Events are hints, never grants. The webview can only poll
`workspace_watch_poll` (permission `allow-workspace-watch`) for the caller's
active registration; any other ID is `PERMISSION_DENIED`. The watcher does not
follow symbolic links. OS event paths are converted to workspace-relative
paths under the canonical root and dropped if they lie outside it, contain a
non-normal or unrepresentable component, or fall inside `.turing-save-*`
staging. At poll time each path is checked against the retained root handle,
and paths below an existing link or reparse point are dropped. Each poll also
compares the canonical root path with the approved handle. If the root was
moved, deleted or replaced, the watcher stops and reports one rescan, so
events from an unapproved directory at the old path are never forwarded.
Views act on hints only through the authorized listing and read commands.

**Coalescing.** Pending paths form a set in which a path stands for itself and
everything below it, so an ancestor absorbs its descendants. A burst is
delivered once no event has arrived for 150 ms or its first event is one
second old. Reads and opens are ignored.

**Overflow.** A queue overflow, any watcher error, an event without paths, a
change to the root itself, or more than 256 distinct pending paths replaces
the per-path set with a single `rescan` signal. On rescan the Explorer
re-lists every loaded folder and the editor revalidates every workspace tab.

**Lifecycle.** Each watcher belongs to one registration. Closing or replacing
the workspace, a page load and window destruction or app exit drop it. Before
the OS watcher stops, its inbox is closed, so late callbacks are discarded and
cannot reach a later registration.

**Frontend.** The workbench polls every 500 ms while the document is visible,
backs off to 2 s after a transient failure and stops on `PERMISSION_DENIED`.
Replies for a workspace that is no longer current are dropped. Explorer
re-lists each loaded or pending folder that contains a changed path or lies
below one. A newer listing supersedes earlier reads of the same folder.
When a folder disappears, Explorer forgets that subtree and returns to its
surviving parent.

The editor checks each affected document once per batch. It compares the
current disk version to the saved base and ignores a reply superseded by a
newer check, tab revision, or workspace registration. All groups share the
result. Clean tabs offer explicit reload, and dirty tabs keep their draft.
An external rename or removal marks the original tab **Deleted on disk**.
A temp-file replacement at the original path is seen as a version change
when the path exists at revalidation. A later event clears the deleted
status if the path reappears. Search runs independently of polling and reads
the workspace as it traverses the filesystem.

The active-tab check on focus and every four seconds remains as a fallback.
`notify` cannot report a ReadDirectoryChangesW buffer overflow on Windows, and
network or virtual filesystems may not deliver events. Runtime behavior on
Linux and Windows is covered only by CI unit tests, not GUI smoke tests.
See the [macOS watcher acceptance steps](testing/file-watcher-manual.md).

## Workbench layout

Nebula styling uses the shared design tokens. The File menu and command palette
share editor actions. Explorer expands the current branch in place using scoped
directory listings. Monaco reports the active language, line ending, and caret
position when available. Panel dimensions and visibility use versioned local
preferences. These preferences contain only layout values.

The bottom dock offers Terminal, Problems, and Output views and uses the same
layout controls as the side panels. Output shows Run & Build progress.
Problems displays Monaco worker diagnostics, live clangd diagnostics and recognized C++ compiler diagnostics.

## Integrated terminal

The bottom dock starts collapsed for new profiles and honors saved visibility
and tab preferences. Whenever the Terminal tab is visible, including a
restored layout, a terminal that has never run starts on its own without
taking focus, so no **Start terminal** click is needed. Selecting Terminal,
revealing it with the activity control, or invoking **Open Terminal**
(Ctrl+backtick) also starts the selected session if needed and focuses it. A
killed or exited terminal stays stopped until it is explicitly reopened or
restarted.
Switching dock tabs or hiding the dock keeps the sessions and scrollback.

The panel header follows VS Code: text tabs on the left and the active
terminal's actions on the right: its name (or a session list beside the
terminals once there are several), **New Terminal**, a **Launch profile** menu
that opens a terminal with a chosen shell, **Split**, **Kill Terminal** and
**More** (Rename, Split Down, Find, Copy, Paste, Clear). A split uses the same
shell as the terminal it splits. Splits form VS Code-style groups: each split
adds a pane beside the active terminal, with no small cap on terminals, the
group's panes share one row or column with a resizable divider between each
pair, and the session list ties grouped terminals together with tree lines.
Kill removes the active terminal when others remain, handing its space and
focus to a neighbouring pane, and otherwise ends its shell.

A page load or reload in a window ends that window's terminal sessions and
language session in Rust. The reloaded page has lost their IDs, so the shells
would otherwise keep running unseen and count against the session ceiling. The terminal-only window shows the same
actions above its terminals. Shell exit leaves
output visible until the next start, and failed startup offers a retry. New zsh
sessions report prompt and command status through OSC 133. A hollow circle marks
the current command, a lavender circle marks exit code zero, and a filled red
circle with a white × marks a nonzero exit code. Completed indicators stay
with their command rows in scrollback. Shells without status reporting show
a hollow input-row indicator. Browser preview has no terminal access.

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

Run discovers tools in inherited PATH order, ignoring relative directories and
WindowsApps aliases. Within a directory it tries the names in the order shown
below (with `.exe` on Windows). Bounded tool probes check that the selected
installation can start. C and C++ discovery try the next allowed driver if
a candidate cannot start or rejects the probe. Keep the executable name
when launching a symlink so drivers such as `clang++` retain their mode.
Install the toolchain on the host and expose it on Turing’s PATH. Missing
installations return language-specific errors with installation guidance.
Process launch errors and probe timeouts can be reported separately.
For Rust's MSVC targets, Turing passes the absolute linker path and library
search paths from a registered Visual Studio and Windows SDK installation.

| Source                             | Tool and execution                                                                                                                                                                                                                                              |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Python (`.py`)                     | `python3`, then `python` (`python` first on Windows). Runs isolated Python 3.7+.                                                                                                                                                                                |
| C (`.c`)                           | `clang`, then `gcc`. Compiles C17 and runs the staged binary.                                                                                                                                                                                                   |
| C++ (`.cpp`, `.cc`, `.cxx`, `.C`)  | `clang++`, then `g++`. Compiles C++17 and runs the staged binary.                                                                                                                                                                                               |
| Rust (`.rs`)                       | `rustc`. Compiles one Rust 2021 source with an explicit crate name and runs the staged binary.                                                                                                                                                                  |
| Go (`.go`)                         | `go`. Builds the staged file, then invokes `go run` from scratch using that build cache. Clears GOFLAGS, keeps Go caches and temp files in scratch, and disables module/toolchain downloads and cgo.                                                            |
| Java (`.java`)                     | `java` and `javac` (next to the selected `java` if present, then on PATH). Uses javac for build diagnostics when available. Java 11+ launches the staged source directly. Earlier versions run the compiled class matching the filename, including its package. |
| JavaScript (`.js`, `.mjs`, `.cjs`) | `node`. Checks syntax and runs the staged source.                                                                                                                                                                                                               |
| TypeScript (`.ts`, `.mts`, `.cts`) | `node --experimental-strip-types`. Requires a Node installation with a working strip-types loader and supports only erasable TypeScript syntax.                                                                                                                 |
| C# (`.cs`)                         | `dotnet`. Requires a local .NET 6+ SDK and targeting packs. Builds a generated console project with NuGet package sources cleared, then runs the resulting DLL.                                                                                                 |

Use self-contained source with the host toolchain’s standard library and, for
native compilers, an installed linker and system headers. Project build
systems, sibling imports or headers, custom flags, external packages, and
multiple source files are outside this workflow.

Rust checks caller ownership and reads the versioned source through the existing
workspace or standalone file grant. It stages those exact bytes in a unique
OS temporary directory and constructs process arguments itself. Scratch files
are cleaned up when the worker finishes. Builds and tool probes run in scratch
with an allowlist of environment variables. On Unix, programs normally start
through the retained workspace root or standalone parent directory handle. Go
and the Java source launcher start in scratch. On Windows, all processes start
in scratch because standard process launch accepts a path for its working directory.

Output distinguishes build stdout and stderr from program stdout and stderr.
It reports phase, exit code, elapsed time, and Stop. Output retains at most
256 KiB per run and decodes UTF-8 with replacement for invalid bytes. The
Problems panel maps recognized C, C++, Rust, Go, Java, Node syntax, TypeScript,
and C# diagnostics for the staged file back to the exact saved revision.
Byte and scalar columns are converted to UTF-16 for the editor. Java source
launch and Node’s TypeScript loader combine build and run in one process, so
their diagnostics can arrive on program stderr. Other messages remain in Output.
Stdin is closed, so programs receive EOF. Use the integrated terminal to run
programs that need interactive input.

The dedicated local-workbench capability accepts only a saved file grant and
version, then an opaque Run ID for reading and stopping. Phase notifications
use a per-run Tauri channel. The shell terminal and any future AI integration
have separate authorization paths. Code executes with the user's OS privileges.
Tool probes are limited to five seconds each, builds to 60 seconds, and programs to 30 seconds. Stop and
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

Workbench commands are declared once in `apps/desktop/src/shell/command-registry.ts`.
Each declaration names its label, optional shortcut and hint, its `enabled`
and `visible` rules, an optional keyboard policy, and its run function. The
rules read a single `CommandState` object. Run functions call a small
`CommandActions` interface. `Workbench.tsx` supplies both objects on every
render. `commands.ts` keeps the command identifiers, menu structure, shortcut
matching, and Monaco action metadata.

`describeCommands` resolves labels, hints, and availability once per render.
The menu bar, command palette, Keyboard Shortcuts dialog, and editor controls
all render from that result. The menu bar, palette, workbench buttons, and
window shortcut handler all invoke commands through the same `dispatch`
function, and `resolveInvocation` holds the availability rules for every
entry point. Unavailable or hidden commands do nothing. Shortcuts follow
extra rules from the same declaration. They are ignored while a workbench
popup or dialog is open. While focus is in a terminal, only Open Terminal,
New Terminal, and Command Palette keep their shortcuts. The browser preview
leaves F5 to the browser. The native app reserves F5 even when Run is
unavailable. A key event is consumed only when dispatch runs or reserves its
command. Save, Run, and Stop reuse the editor and execution handlers. Monaco owns its editor bindings, clipboard
commands, and undo stack. Symbol navigation appears when Monaco reports an
available provider. System clipboard commands depend on the WebView's
clipboard capabilities.

Go to File lists open editors and scans the approved workspace using bounded
directory listings. It skips generated dependency folders and also offers the
native file picker. Close All asks once before discarding dirty editors and
releases standalone native file grants. Show Terminal reveals the dock,
which starts a never-run terminal without focusing it. Open Terminal starts or
focuses the
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
its neighbors. A window may hold up to 64 sessions; this is only a safety
ceiling against runaway loops exhausting file descriptors, not a product
limit. **New Terminal
Window** opens a terminal-only application window with no workspace,
editor, or Run & Build capability, and starts and focuses a shell in it.
Closing it cleans up its sessions.
PTYs execute with the user's operating-system privileges.

### Native lifecycle smoke harness

Tauri's WebDriver does not support macOS, so a Rust-driven harness checks the
native window lifecycle on all three CI platforms. It is compiled only with
the non-default `smoke` cargo feature and runs only when `TURING_SMOKE=1` is
set. Normal and release builds contain no harness code, readiness script or
extra IPC command, and a smoke build started without the variable behaves like
a normal build. The harness adds no command, permission or capability.

Run it locally after building the frontend:

```sh
pnpm build
cd apps/desktop/src-tauri
cargo build --release --features smoke,tauri/custom-protocol
TURING_SMOKE=1 ./target/release/turing-core   # turing-core.exe on Windows
```

`tauri/custom-protocol` makes Cargo embed `dist` the same way `tauri build`
does; without it the binary points at the dev server. Use
`TURING_SMOKE_OUTPUT=<file>` to also write the summary to a file, which is
useful where a GUI-subsystem Windows build has no console, and
`TURING_SMOKE_TIMEOUT_SECS` to change the 180-second overall limit.

The harness waits for the main page to load. It then opens two workbench
windows and two terminal windows, one after another, through
`windows::build`, the code behind **New Window** and **New Terminal Window**. For
each window it waits for the page-load `Finished` event and for the frontend to
mount. A smoke-only initialization script sets a sentinel document title once
React renders into `#root`, and Rust observes the title. In each terminal window it waits until the
frontend has started a PTY through the normal `terminal_start` IPC and
`TerminalService`. It then closes every window the normal way, so workbenches
go through the frontend's close flow and `editor_exit`. It checks that each
window's registry entry and PTY sessions are released and that the registry and
native window list hold only `main`. It prints one JSON line to stdout and exits
with code 0. A failure or timeout prints the same JSON with `"status":"failed"`
and an `error` message, and exits with code 1. Each step has a 60-second limit
and a watchdog enforces the overall limit.

The lifecycle summary reports timing in milliseconds. It includes
`mainPageLoadedMs` from harness initialization, and per window
`openToPageLoadedMs`, `openToReadyMs`, `readyToPtyMs` for terminals, and
`closeMs`. `totalMs` covers the whole run.

CI builds the harness without installers and runs it on macOS and Windows
directly and on Linux under `xvfb-run`. It verifies window creation, page load,
frontend mount, ACL-checked IPC from new windows, PTY start and teardown,
and resource cleanup. It does not check pixels, layout, focus, keyboard or
pointer interaction, editor behaviour, shell output, workspace access, or
dirty-document prompts. A passing run does not show that installers or signed
bundles launch.

### Performance baseline

The non-default `perf` cargo feature implies `smoke`. The Node driver enables
both harness modes (`TURING_SMOKE=1` and `TURING_PERF=1`) and launches the binary
sequentially, ten times by default. It reads each native smoke summary from a
private temporary path, prints a table and writes schema-versioned JSON with
raw captures and aggregates. Build without installers from the repository root:

```sh
pnpm build
CARGO_NET_OFFLINE=true cargo build --release --locked --features perf,tauri/custom-protocol --manifest-path apps/desktop/src-tauri/Cargo.toml
node apps/desktop/scripts/perf-baseline.mjs --output baseline.json
node apps/desktop/scripts/perf-baseline.mjs --compare baseline.json next.json
node --test apps/desktop/scripts/perf-metrics.node.mjs
```

Use `--runs N` to override the launch count and `--binary PATH` for an alternate
Cargo target directory. Run in a GUI session and leave the app focused during
the editor workload. Use the same machine, OS, build profile, run count and
display setup for both captures. Each launch starts a fresh app process with private
WebViews to isolate settings and recent workspaces. OS caches may warm across runs. Percentiles use nearest rank, so the default p95
is the maximum of ten samples. The comparison reports new minus old values
and percentage changes relative to the old baseline.

- **Startup.** Main page-load and initial React mount are measured from the
  beginning of Rust's `main`. Auxiliary windows are timed from the open
  request to the mount sentinel, with separate rows for the first and
  second window of each kind.
- **Memory.** RSS is sampled after main load and mount, after two workbenches
  and two terminal windows have opened and the latter have started PTYs,
  after the workloads immediately before auxiliary window teardown, and
  after teardown. The lifecycle check also waits for the last native
  strong reference to each closed window's resource owner to drop. macOS uses
  `proc_pidinfo(PROC_PIDTASKINFO)` and Linux uses `/proc/self/statm`. Windows
  RSS is unavailable because the existing `windows-sys` features omit
  ProcessStatus. Only the Turing app process is sampled. WebView processes
  and PTY shell processes are separate.
- **Editor.** A Rust-generated temporary workspace goes through the regular
  workspace registration path in one harness-owned workbench. An
  initialization script opens a 1,320,000-byte, 40,000-line text file through
  Explorer and times the first rendered Monaco view. It then sends 159
  characters through Monaco's platform input element in an empty text file.
  It repeats the burst in the large document after the symbol picker confirms
  indexing has started on a 2,048-source-file fixture. The picker closes and
  releases focus while the native worker continues the scan. The harness
  reports dispatch time and elapsed time through the next frame separately for
  both bursts. A 250 ms frame deadline records a timeout if the WebView stops
  delivering frames. The harness checks the rendered text and verifies the
  saved bytes in both files. Results return through a document-title sentinel.
- **PTY.** A dedicated session in an auxiliary terminal window uses the
  production start, input and read handlers. The start clock ends when the
  first command's readiness marker arrives from the shell. The throughput
  clock covers command submission through receipt of 200,000 verified lines
  from `yes | head` on Unix and PowerShell on Windows. It counts 6,400,000
  payload bytes and excludes line endings, shell echo and terminal control
  bytes. This measures the PTY path through the Rust read handler. The
  frontend's xterm rendering and IPC serialization are outside that timing.

The **CI** workflow's manual dispatch runs the capture on macOS and Windows
directly and on Linux under Xvfb. Each successful capture uploads its JSON
as a platform-specific artifact. The capture and upload steps are optional
and use no performance thresholds.

#### Frontend bundle and startup

`index.html` loads only the `index` chunk and its stylesheet. The editor area
imports `MonacoHost` with `React.lazy` and shows a `role="status"` "Loading
editor…" placeholder until the chunk arrives, so the menus, activity bar,
Explorer and dock render first. Monaco fetches its workers (`?worker` imports)
and its 85 language and mode contributions as separate chunks when they are
first needed. `Workbench.lazy-editor.test.tsx` holds the editor chunk pending
and checks that the shell is already rendered. Measured with `pnpm build` on
Vite 7 (sizes in kB, raw / gzip):

| Chunk                                           | Loaded           | Before              | After               |
| ----------------------------------------------- | ---------------- | ------------------- | ------------------- |
| `index` JS + CSS                                | startup          | 446.06 / 135.38     | 446.06 / 135.38     |
| `MonacoHost` JS + CSS                           | first editor tab | 4,229.69 / 1,075.70 | 4,229.69 / 1,075.70 |
| Monaco language/mode chunks (85)                | on demand        | 477.31 total        | 477.31 total        |
| Workers (`ts`, `css`, `html`, `json`, `editor`) | on demand        | 9,488.52 total      | 9,488.52 total      |
| `terminal-view` JS + CSS                        | first terminal   | 338.20 / 86.11      | 338.20 / 86.11      |

Before and after are identical: Monaco has been lazy since the editor first
shipped, so no Monaco bytes are in the startup set. A `manualChunks` split of
the 4 MB chunk was not adopted. Monaco's language definitions are reachable
only through dynamic imports. Assigning `monaco-editor` modules to a manual
chunk folded all 85 back into one 4,515.70 kB chunk in a trial build. The remaining split candidates
(core versus editor contributions) load together on the first tab, so they
would not shorten time to editor.

#### Budgets and macOS findings

- At **131,072 UTF-16 code units** (128 KiB for ASCII on disk), the workbench
  uses Monaco's plain text mode, disables folding, word-based suggestions
  and validation decorations, and skips clangd sync, compiler Problems
  conversion, and draft snapshots. Minimap and word wrap are off throughout
  the workbench. The active file's status bar shows **Large file: some
  features off**. Explicit save and Auto Save remain available.
- Regular Monaco edits update the shared draft from edit ranges. Whole-model
  reads occur when a model is initialized, externally replaced, or emits a
  flush or EOL change. Shared groups apply each model version once. Compiler
  Problems reuse their conversion while the compiled tab and run are
  unchanged. When there are no diagnostic batches, typing reuses the empty
  Problems list and avoids reapplying Monaco markers. Clangd waits for
  **250 ms** without edits, checks every **120 ms**, and attempts at most
  **three** document syncs per poll. Recovery
  coalesces eligible edits over **400 ms**.
- The symbol worker walks and parses outside the registry lock. It pauses for
  **2 ms** at a safe checkpoint after **32 entries**, **256 KiB of reads**,
  or **4 ms of work**, whichever budget it hits first. Extraction checks
  time and cancellation between lines. A filesystem operation or single
  source line may run past a checkpoint. Existing per-pass and per-file caps
  still apply. The capture target for the 159-character loaded burst is
  **100 ms p95 dispatch**, **150 ms p95 through the next frame**, and zero
  frame timeouts. These are review targets for a focused GUI capture.
- The checked-in Apple M4 capture recorded 66 ms p50 and 14,198 ms p95. The
  outlier occurred in the short empty-file burst and included a wait for
  `requestAnimationFrame`. It contained no large draft, compiler run, or
  active symbol scan. The old measurement cannot distinguish synchronous
  editor work from delayed frame delivery. Source inspection found a full
  model read on every edit and another on React reconciliation. The updated
  harness separates the phases so the next capture can identify which one
  stalls. A frame timeout in the new capture makes that burst's elapsed time
  a deadline measurement rather than a measured paint.
- App-process RSS was 115 MiB after opening windows and 129 MiB after both
  the workloads and window close. The old sampling points cannot distinguish
  allocations from the editor/PTY exercise, allocator or framework retention,
  or a leak. Existing destruction removes the native resource registration,
  revokes language and workspace access, closes PTY sessions, and cancels
  symbol workers. A picker that was already in flight could register a
  new workspace on an owner retained past destruction. Closing the registry
  now blocks late grants and watcher attachment. The React registry disposes
  models when their last tab closes or the editor unmounts. The audit did not connect the late-picker
  race to the checked-in RSS sample. Native re-capture is still required to measure the
  before/after teardown delta and verify typing under load.

## Code navigation and debugging status

Definition, declaration, implementation, and references use Monaco's
registered providers. The Go menu reads provider availability from the active
editor when opened, including providers loaded lazily by Monaco. In the bundled
TypeScript and JavaScript services, Definition and References are available.
Declaration and Implementation require their own providers. Python has
syntax highlighting and no bundled navigation provider. Cross-file destinations must belong to an already-open document
or use the active workspace's synthetic model URI. New workspace reads still
go through Rust's authorized file command. Monaco's bundled providers may be
limited to loaded models. Full project navigation for Python and C++ needs a
language-server integration.

F5 is **Run Without Debugging**. Debugging remains unavailable until Turing
has a scoped debug-adapter transport, authorized launch and stop handling,
verified breakpoint mapping, and paused-process controls. No generic debugger
launch command or debugger shortcut is registered.

## Managed language intelligence and Problems

Open an approved workspace and use the **Problems** server controls to enable
clangd, TypeScript/JavaScript, Pyright, or rust-analyzer. **Settings → Diagnostics**
also provides the original clangd controls. The active document's server state
appears in the status bar. Problems shows each server's state and Enable, Stop,
or Retry action. Output displays bounded per-server stderr and version logs.

Rust resolves an installed executable from the descriptor's allowlist. Discovery
uses absolute PATH entries and platform LLVM, nvm, Cargo, and installed rustup
toolchain directories. The npm-backed servers are started through an absolute
Node executable with a fixed script entry and `--stdio`. On Windows, direct
Node invocation avoids npm's shell wrappers. TypeScript language server 6.1
requires a compatible `tsserver.js`. Turing looks for it alongside the Node
installation or, in development, in the app's existing dependencies. TypeScript
7's native CLI alone does not supply that entry. Pyright is preferred when both
Pyright and basedpyright are installed.

The native confirmation identifies the executable, related runtime files, and
workspace access. Turing fingerprints those paths around confirmation and again
before launch. Only after approval does it run a `--version` probe with a
three-second deadline and bounded output. Pyright's probe uses the bundled CLI
since its LSP entry does not implement the flag. Approval is scoped to the window,
workspace, descriptor, executable paths and fingerprints, and Rust execution
options. It is cleared on workspace revocation and never persisted. clangd still
asks for confirmation each time. For the other descriptors, the renderer retries
a crashed process at 500 ms and 1 s, using the cached native approval if it still
matches. Stop or workspace replacement cancels pending retries.

There is no download, renderer-supplied executable path, shell invocation, or
generic JSON-RPC command. Only workbench windows have the four language IPC
permissions. Rust owns at most one live session per server kind for the active
workspace in each workbench. Each session has an opaque ID. For clangd, Rust
reuses handle-relative file checks and publishes a limited temporary mirror of
open C/C++ sources and headers. Rename can
also stage authorized neighboring C/C++ files as described below. Saved file copies
are obtained through the authorized file API. Unsaved drafts are sent over
stdio. The mirror is owner-only on Unix and inherits the user temp directory's ACL on
Windows. The server runs with the user's OS privileges and can read include
files outside the mirror. The mirror limits the workspace data Turing hands to clangd;
it does not provide OS-level process isolation. Definitions only return
mapped open files, revalidated against the active workspace. Project settings,
compilation databases, query-driver execution, clang-tidy and background
indexing are disabled. There is no recursive workspace discovery.

The client negotiates UTF-16 positions and tracks monotonic document versions
separately from saved file versions. Opening, editing, saving, renaming and
closing tabs drive LSP document notifications. Renaming an Explorer item closes the old URI
and opens the new path without replacing the Monaco model. The bridge accepts
hover, completion, location queries, workspace symbols, rename and cancellation
according to the negotiated server capabilities. It rejects stale and unversioned
push diagnostics, and bounds frame size, queues and pending requests. Renderer results
are checked against the current editor revision before they reach Monaco.
Monaco completion supports plain-text insertions; additional source edits,
commands and snippets are excluded. Missing or crashed servers show a retry
action. Requests that are cancelled, or that expire after 10 seconds, send
`$/cancelRequest`; late replies are dropped. Server messages pass through a
bounded queue with backpressure, so a burst slows the server instead of
ending the session. Explicit Stop sends `shutdown` and waits up to 750 ms for
a successful reply, then sends `exit`, closes the server's input, and waits
up to 3 s for the process to terminate. Failed or unresponsive shutdowns
fall back to forced cleanup. Workspace replacement, workspace close and
window destruction revoke the session and force process cleanup. Unix uses
a process group, signalled before the child is reaped so the group ID cannot
be reused. Windows uses a kill-on-close Job Object. A desktop crash can leave
temporary files behind. Ubuntu's clangd 18 sometimes outlives that budget after a
successful `shutdown` reply; Turing then force-stops it, so Stop never hangs.

### Project-aware server access

TypeScript, Pyright, and rust-analyzer receive the approved real root in
`rootUri` and `workspaceFolders` so they can resolve imports, tsconfig/jsconfig,
Python project configuration, and Cargo projects. The process starts in a private
working directory, with an allowlisted environment. Servers run with the user's
OS privileges and can read files, run subprocesses, and act outside the workspace
under those privileges. Only enable these servers in trusted workspaces. Turing
does not mediate the server's ambient filesystem access. TypeScript's automatic
typing acquisition is disabled. Rust uses offline Cargo resolution and disables
check-on-save, Cargo build scripts, and procedural macros by default. The
workspace-scoped Rust opt-in enables build scripts and macros after a distinct
native confirmation, because both can execute workspace or dependency code. Cargo
project discovery and metadata still run in the default configuration.

The bridge rechecks the workspace root identity and revalidates returned locations
through the authorized registry. Definition, declaration, implementation,
references, workspace symbols, edit targets, and diagnostics can refer only to
authorized workspace files. Symlinks, traversal, paths outside the active root,
and stale workspaces are refused. Diagnostics omit related locations. clangd
continues to return locations from its mapped mirror. Workspace symbols merge with
the existing Go to Symbol in Workspace index. For a project-aware Rename Symbol,
Turing captures bounded, authorized closed-file snapshots before the request and
revalidates their disk versions when the result returns. Targets outside those
snapshots and the synced documents cause the preview to be rejected.

For Pyright, Turing discovers platform site-packages directories in the workspace's
`.venv` or `venv`, including in-project Poetry and uv environments. Pyright can
execute the path it receives as `python.pythonPath` to inspect interpreter search
paths. Turing therefore uses its private working directory as a non-executable
sentinel and provides the discovered package directories through
`python.analysis.extraPaths`. Turing does not invoke the workspace interpreter.

The project-aware descriptors answer `workspace/configuration` from fixed host
settings and acknowledge `window/workDoneProgress/create`, which grants no access
and starts no local work. They leave dynamic watcher registration disabled.
Project-aware servers can watch files directly with their OS privileges. The
workspace watcher exposes coalesced change hints rather than the typed create and
delete events needed for LSP watch subscriptions. Other inbound requests,
including `workspace/applyEdit`, are refused. clangd continues to reject all
server-initiated requests.

For TypeScript and JavaScript, a ready managed session switches its authorized
models to Monaco language IDs with the same syntax rules and separate provider
selectors. Built-in JS/TS providers and markers stay active for other models.
TypeScript language server pushes diagnostics without a document version. Turing
uses only its fixed synchronous syntactic and semantic diagnostics requests,
queued after document sync and correlated with that exact document version.
Pyright, rust-analyzer and clangd use versioned publish diagnostics. Responses
that arrive after a document change or request cancellation are discarded.

The stderr stream keeps up to 100 entries per server, drops overlong lines, and
redacts lines with secret markers such as Authorization headers, token names,
credential labels, and common token prefixes.

### Rename Symbol and workspace edits

With managed clangd enabled, **Edit → Rename Symbol** opens a rename dialog.
**F2** invokes it from Monaco. Explorer and terminal session names retain their
own F2 handlers. The dialog asks clangd to prepare the rename when supported
and uses the returned source range to prefill the name. It then shows every
returned file and replacement, with a line and column for each change and a
checkbox to exclude a file before applying.

Rename works with the open C/C++ documents known to clangd and a bounded set
of supported siblings in the source directory. Rust authorizes and loads
these neighbors through the workspace file API, stages their saved text for
clangd's open-file index, and retains up to 24 neighbors and 4 MiB per session.
Discovery stays within this mirror and clangd's available index. It can omit
references elsewhere in the project, so the dialog describes the set that
clangd found.

The client advertises document changes with an empty resource-operation list.
Rust accepts text edits in either WorkspaceEdit representation. It maps URI
strings back to registered mirror entries, revalidates each path against the
live workspace grant, checks document versions and UTF-16 boundaries, rejects
overlapping or duplicate edits, and limits a result to 24 files, 512 edits and
256 KiB of replacement and original snippet text. Every target carries the
disk version of its mirror snapshot. Open targets also carry the LSP version
of the draft used for the edit. Server-initiated workspace edits remain
rejected.

Apply uses the editor's current document identity and revision stamps and
checks each selected file's disk version. Changed editor documents,
watcher-flagged files, recovered drafts and disk conflicts are skipped.
Open targets are edited through their shared Monaco models, as one undo
step per file. Their drafts enter the normal recovery journal and wait for
explicit Save even when Auto Save is on. Unopened files use the same
version-checked write as Save, with the preview's base version as the
expected version. The results show drafts, saves, exclusions and skipped
files with their reasons. Successful changes remain applied when another
file conflicts.

Every problem flows through one diagnostic store
(`language/diagnostic-store.ts`). A producer (`clangd`, `typescript`, `pyright`, `rust-analyzer`, `compiler`, or `monaco` for Monaco's built-in JSON/CSS/HTML and unmanaged TS/JS markers)
publishes a batch per document, stamped with the document's `uri`,
`revision` and `editRevision` at the time it was computed. A batch is shown
only while its open document still has that exact stamp and has not changed
on disk, so edits, saves, reloads, renames and closes clear stale items
deterministically. A newer batch from the same producer replaces the older
one, and a stopped or crashed producer publishes nothing, which clears its
items. Output is ordered by open-tab order, position, severity and producer,
with IDs that do not depend on arrival order.

The primary Monaco view listens once for marker changes across the shared models,
including open background tabs. It coalesces updates in 100 ms windows and reads
up to 200 markers per affected document from its active bundled validator.
Large documents in plain-text mode skip marker collection. Monaco marker batches
also expire on a language override change. F8 and Shift+F8 use the combined store.
Bundled validators can emit markers without a model version. Those markers are
stamped when Monaco reports them, using the local model version and document stamp
to guard queued publication.

Monaco uses one overflow host per editor view, mounted at the workbench root.
Fixed overflow positioning uses the viewport for hover, suggest, and parameter
hints, with hovers preferring placement below their anchor. Widgets inherit
the Nebula theme and render above the editor panes.

Problems groups errors, warnings and informational messages. The Severity
filter is under **Settings → Diagnostics**. Rows open the
corresponding editor and location. Each server has its own Monaco marker owner, alongside `compiler`. Compiler entries come from recognized C++ build stderr for the
current, unchanged single-file Run snapshot. Output retains raw logs.
Compiler columns are converted from UTF-8 bytes to Monaco's UTF-16 columns
using the compiled text. They never land inside a character or past the end
of a line, and a line outside the compiled text keeps its reported column for
the editor to clamp. Clang reports byte columns. GCC 11 and later is detected
from `--version` output (bounded to 2 seconds) and given
`-fdiagnostics-column-unit=byte`. Older GCC and Clang already use bytes and
reject that flag.

**Go → Next Problem** (F8) and **Previous Problem** (Shift+F8) visit problems
in open-tab order, then by position, wrapping at either end. An unvisited
problem under the cursor is shown first. Problems sharing a position are
visited in turn, and problems for closed tabs are skipped. Each jump is
announced in a polite live region as "Error 1 of 2: message (file:line:col)".
Selecting a row in Problems continues from that problem. The existing Python and C++ Run pipelines remain
unchanged.

The pilot tracks up to 24 open documents and 200 diagnostics per document.
Standalone files and untitled buffers are excluded until they belong to an
authorized workspace. Opening a header makes it available in the mirror.
Unopened project files, project compiler flags and build-aware indexing are
follow-up work. Cross-platform CI and native GUI tests should verify executable
discovery, approval, and shutdown on each platform.

The default Rust suite has framing, authorization and malformed-server cleanup
tests, plus `lifecycle_tests`: a scripted LSP server over OS pipes that
checks initialize and UTF-16 negotiation, server-request refusal, open, change,
save and close sync, stale diagnostic and response filtering, cancellation
and expiry, burst backpressure, crash detection, and each shutdown outcome.
They need no external tools, so CI runs them on macOS, Windows and Linux.
Linux CI also installs trusted server versions and runs the ignored integration
suite. These tests open two-file projects for each language and check diagnostics,
hover, cross-file navigation, references, rename and workspace symbols.

```sh
export TURING_TEST_CLANGD="$(command -v clangd)"
export TURING_TEST_TSLS="$(command -v typescript-language-server)"
export TURING_TEST_PYRIGHT="$(command -v pyright-langserver)"
export TURING_TEST_RUST_ANALYZER="$(rustup which rust-analyzer)"
CARGO_NET_OFFLINE=true cargo test --locked \
  --manifest-path apps/desktop/src-tauri/Cargo.toml language:: -- --ignored
```

Protocol and configuration references are the [LSP specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) and [clangd configuration manual](https://clangd.llvm.org/config).

## Milestone 4B terminal reliability

Terminal startup reserves a window-owned slot before opening the PTY and
releases the registry lock during the platform launch. Existing sessions
can keep reading, resizing, or closing while another session starts. The
renderer gives startup 12 seconds and then offers Retry. Cancel and timeout
mark the reservation for disposal, and any successful late IPC reply is
closed. A pending reservation counts against the per-window session ceiling until
its platform call returns. Removing a tab frees its
display number independently of its internal session key and native UUID.

The session toolbar selects an installed system profile, renames tabs, and
splits right or down. A two-pane group retains its layout when another session
is selected. The divider accepts arrow keys in the direction of its resize.
The pane toolbar offers text search within rendered scrollback rows, copy
selection, paste into the active shell, and clear. Web links and OSC 8 links
go through a native confirmation for a parsed credential-free HTTP(S)
address. Turing uses the system browser association and does not navigate its
own webview. The native bridge still has no arbitrary executable or argument
interface.

The design follows the public terminal process and lifecycle findings in the
[terminal research](research/rea-vscode-xcode/05_Terminal_Debugging_and_Build_Systems.md),
and the existing owner checks are verified in the Rust and frontend tests.
The VS Code artifact material with recorded integrity contradictions did not
inform these implementation decisions.

| Limitation and evidence                                                                                                                                                                                 | Severity, impact and resolution                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The native PTY open/spawn call is synchronous. Controlled delay tests show the renderer can recover and sibling sessions remain responsive, while the cancelled call retains its slot until it returns. | Medium. A permanently stalled start consumes a slot until the app exits. A separate PTY helper with a supervised process would provide harder isolation, at the cost of a new IPC and ownership boundary. Defer until a platform trace justifies it. Introducing the helper is a separate architecture decision.                                                                                  |
| Windows still starts outside the workspace because ConPTY does not consume the approved directory handle. Unix process groups and Windows Job Objects have the descendant limitations documented above. | Medium. Working-directory and cleanup behavior can differ by OS now. Keep the existing safe fallback and investigate a handle-aware launcher in a separate security review. Passing the workspace path directly would weaken the directory replacement guarantee. No approval is needed for keeping the fallback.                                                                                 |
| Built-in choices use system paths, each group has two panes, and search and plain-text link detection operate per rendered row.                                                                         | Low. Nonstandard shell installs, deeper split trees, and matches crossing wrapped rows are follow-ups. A permissioned custom profile workflow and a maintained search/link provider are alternatives if demand warrants them. The current IDs, group metadata and native profiles are replaceable without changing existing session ownership. No approval is needed to defer these enhancements. |

The workbench and platform verification gates still apply to the terminal
before proceeding to the Run console. Later slices follow the existing
[roadmap](research/rea-vscode-xcode/11_Prioritized_Implementation_Roadmap.md)
for managed language tooling, shared project context, editor workflows,
Git, testing and debugging, extension isolation, and supervised AI.

## Accessibility

The workbench exposes named title, activity, sidebar, editor, dock, and status
regions. F6 and Shift+F6 move between visible regions, including when Monaco
or xterm owns keyboard input. Ctrl+F6 and Ctrl+Shift+F6 still switch editor
groups. Tab moves among controls, and arrow keys operate menus, Explorer rows,
and editor, dock, and terminal tabs. Dialogs use the webview's modal dialog
behavior. The command and symbol pickers expose the active result through the
combobox, and Escape restores opener focus. Live status text includes save
state and the severity, index, message, and location reached with F8.

The Vitest integration suites use axe-core against rendered jsdom states,
including the empty shell, workspace Explorer, Search results, Source Control,
editor tabs and groups, Problems and Output, terminal sessions and splits,
menu and dialog states, symbol results, inline rename, and draft recovery.
Keyboard tests exercise focus order, region cycling, composite navigation,
dismissal, and status text. The Nebula contrast unit tests read the actual CSS
token values and check 4.5:1 for body text and 3:1 for large text and focus
indicators. Axe color contrast is disabled because jsdom cannot paint. The
landmark containment rule runs on full-workbench scans and is skipped for
isolated component fixtures.

jsdom does not provide the platform accessibility tree, rendered focus
indicators, native dialogs, or screen-reader speech. Monaco and xterm use
test doubles for the app integration checks. Contrast tests cover specified
token pairs rather than rendered syntax highlighting, terminal ANSI colors,
or OS overrides. Roadmap qualification requires a human to complete all three
platform runs in the [screen-reader smoke checklist](accessibility/screen-reader-smoke.md).

### Local Ask Mode foundation

The native Ask commands currently expose retrieval and local streaming inference
through the typed desktop service. To exercise the adapter, start
`llama-server -m /path/to/instruct-model.gguf --host 127.0.0.1 --port 8080`
with at least a 4096-token context. The adapter uses the local server's
`/v1/chat/completions` endpoint with proxies and redirects disabled. Use a trusted
server on that port because it receives the question and the retrieved source
passages. The server and model are installed separately. Open Turing AI from the activity rail with a workspace folder open. The pane
streams the latest answer, offers Stop, and rechecks the saved file version
and open edits when you follow a source. The answer is cleared when you change
workspaces.

Retrieval scans the active workspace on demand using the handle-relative search
walker. It ranks bounded passages by keyword matches and returns relative
paths, file versions, and one-based line ranges. It skips hidden files and
directories, known generated directories, common sensitive filenames, and
unsupported file types. These rules catch common cases. Source files can still
contain secrets, so the local adapter does not establish a cloud-sharing policy.
Cancellation drops the model request and stops the scan. Workspace replacement
or closure revokes the request. Check the reported freshness before navigating
to a passage.

Run the opt-in model check with
`cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml answers_a_workspace_question_with_a_real_local_model -- --ignored`.

### Ask answer rendering

Answers render a safe Markdown subset as React elements: headings, ordered and
unordered lists, paragraphs, inline code, bold, italic, and fenced code blocks.
Raw HTML in model output stays literal text. A citation such as `[2]` becomes a
button that opens the second cited source at its line range. The thread follows
streaming text only while the reader is at the bottom of the conversation.

### Model availability

The model picker shows whether each Ask model can answer before a request is
sent. **Local server** in Turing AI sets the local OpenAI-compatible server
address and an optional model name. They are saved once per device in local
storage, not per folder, because the server belongs to the machine. The default
is `127.0.0.1:8080` with no model name (llama-server). Ollama
(`127.0.0.1:11434`) needs a model name, which Turing sends as the request's
`model` field; LM Studio uses `127.0.0.1:1234`. Rust revalidates the address on
every call: only `http://` with host `127.0.0.1`, `localhost`, or `[::1]` and an
explicit port from 1 to 65535. Userinfo, paths, and queries are rejected with
`INVALID_LOCAL_SERVER`, and Rust appends fixed paths.

Rust probes `GET /health` with a one-second timeout when the panel opens, when
the picker gains focus, when the address changes, and after a local model
failure. A 404 falls back to `GET /v1/models` because Ollama has no `/health`.
It reports `ready`, `loading` (HTTP 503 from `/health`), or `offline`.
The cloud model reports **key needed** when no OpenRouter key is saved. Status
is advisory: a request can still be attempted and reports its own error.

### Auto model routing

**Auto (local first)** is the default model for folders without a saved model
preference. For each request, Rust probes the configured local server as above. A ready local
server answers the request. Otherwise Auto routes to Qwen3-Coder via OpenRouter,
which still requires a saved key and the per-request **Send once** approval, so
source never leaves the machine silently. The panel shows the choice while the
answer streams and labels each answer with the model that produced it.

### OpenRouter (Qwen3-Coder) in Ask Mode

Select **Qwen3-Coder via OpenRouter** in Turing AI and save an OpenRouter API key in
the panel. Rust stores it in macOS Keychain, Windows Credential Manager, or the
Linux desktop Secret Service. Linux requires an available, unlocked Secret
Service. The webview can save, remove, and check for a key.

Each request opens a native confirmation that names the question, any saved
conventions, the request size, and every workspace file range Turing proposes to
send to `openrouter.ai`, which forwards it to a hosting provider. The request
sets OpenRouter's `provider.data_collection` to `deny`, so providers that store
or train on request data are excluded. When no such provider is available,
OpenRouter returns 404 and Ask reports `PROVIDER_NO_PRIVATE_ROUTE`. The request
carries the full text of those ranges, up to 24 KiB; lower-ranked excerpts are
dropped to fit and the answer reports limited context. While the dialog is open,
the Turing AI panel shows the same ranges as source chips that open the cited
lines. Clicking **Send once** authorizes that
payload for one HTTPS request. Closing or canceling the dialog prevents sending.
Turing rechecks workspace authorization after approval and uses the same stream
and source navigation as local Ask. When OpenRouter reports token counts, the panel
shows them with the answer.

### Cloud budget

When **Qwen3-Coder via OpenRouter** or **Auto** is selected, **Cloud budget**
sets an optional daily token limit (input plus output, a whole number from 1 to
100,000,000) for this device. The limit and per-day measured usage, keyed by
local date and pruned to the last 31 days, live in webview `localStorage` under
`turing:ask-cloud-budget:v1`. Only usage that OpenRouter reports for a completed
cloud answer is recorded; answers show it as measured. Before the native review,
Rust sends `estimatedInputTokens` (payload bytes / 4, rounded up) in the
`awaitingCloudApproval` event, and both the review text and the panel label it as
an estimate. Once today's measured usage reaches the limit, the panel asks
**Send anyway** or **Cancel** inline before a cloud request; Cancel keeps the
question in the composer. Auto's route is chosen natively, so the panel asks when
the local server is not reported ready. Local requests are never blocked. The
budget is advisory and frontend-enforced; the per-request native consent still
gates every cloud send.

### Ask about selection

Select lines in a saved workspace file and choose **Ask Turing AI About
Selection** from the editor context menu, the **Selection** menu, or the command
palette. The command opens the Turing AI panel, attaches the range to the
composer as a removable chip, and focuses the composer. The menu item stays
disabled, with its reason, until the active document is a saved, unmodified
workspace file with a non-empty selection; the context-menu item is hidden in
that case. There is no keyboard shortcut. A selection ending at column 1 of a
line excludes that line, as in other editors.

The webview sends only a reference: `selection` in `AskRequest` holds the
relative path, the saved file version, and one-based inclusive lines. Rust reads
the lines itself with `Registry::read` for the calling window and workspace, so
the frontend path is never proof of access. It rejects a path the registry
cannot read (`SELECTION_UNAVAILABLE`, or `WORKSPACE_DENIED` for another window's
workspace), a version that no longer matches the file on disk
(`SELECTION_STALE`), a reversed or out-of-range span (`SELECTION_INVALID`), and
more than 200 lines or 16 KiB (`SELECTION_TOO_LARGE`). Unsaved edits are never
sent: the command requires a saved file, and the version check catches a file
that changed on disk after selection.

The selection becomes passage 1 of the prompt, so the model cites it as [1],
and the prompt says the user selected it. Retrieved passages that overlap the
range are dropped and the rest follow it. For cloud requests the selection is
listed in the consent review like any other range. Trimming to the 24 KiB cloud
cap removes retrieved passages only; when the selection alone does not fit,
Ask fails with `CLOUD_QUESTION_TOO_LONG` instead of dropping it. The selection
appears in the completed answer's sources and freshness check. Unlike retrieved
passages, a selected file is not filtered by the secret-file heuristics, because
the user chose it explicitly.

### Workspace index for Ask

Ask builds an in-memory index for the active desktop workspace. The index uses
the authorized directory handle and the same file exclusions as on-demand
retrieval. It keeps up to 4,096 files and 16 MiB of text. An independent watcher
inbox refreshes changed paths and their descendants, and watcher overflow
rebuilds the index. The index is discarded with the workspace registration.

Open **Workspace index** inside Turing AI to see its phase and file count, or
to pause, resume, rebuild, or disable it. Ask can still scan on demand while
the index is unavailable, paused, disabled, or refreshing. Cached passages
are version-checked through safe file reads before they are offered to a model.

Passages are ranked by question terms in 12-line blocks. A block that defines
a question term ranks above blocks that only mention it. Definitions come from
two sources. A declaration keyword (`fn`, `def`, `class`, `struct`,
`function`, `func`, `interface`, `type`, `const` and similar, after optional
modifiers such as `pub`, `export` or `async`) always counts. When a managed
language server is already running for the workspace and window and supports
`workspace/symbol`, Ask also sends one query per question term (at most four)
and waits up to 1.5 seconds. The workbench poll loop reads the replies. Each
reported location is mapped through the same root, traversal and symlink checks
as other language results. A symbol whose name equals a term marks its starting
line as a definition, but only when the indexed block still contains that term.
This catches C-style declarations such as `int helper(int)`. Ask never starts a
server or asks for approval. With no server, an unsupported server, a timeout,
an error or cancellation, ranking falls back to the keyword rule alone. Symbols
only adjust ranking, and passage text still comes from authorized, version-checked
reads. When no block matches, the first block of up to four files is offered so
broad questions still have workspace context.

### Ask project preferences and retention

Ask remembers the last model chosen in the picker for each folder as soon as it
changes. Inside Turing AI, **Project preferences and history** saves
conventions for this folder with **Save conventions**. A saved convention is included in the
next Ask request and appears in the cloud review. Conversation retention is off
by default. Opting in keeps the last 20 completed answers, source references,
and feedback ratings in the local desktop profile for that folder. Turning it
off removes the saved conversation. **Clear conversation** also clears the open
thread. Answer ratings remain local.

The v0.2 autocomplete foundation uses the existing Monaco completion provider
and managed language servers. Completion waits for the exact edited document
revision to reach the server, then checks cancellation and capability before
using the response. Diagnostics, definitions, references, and completions are
available where the installed server advertises them.

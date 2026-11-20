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

## Workbench layout

Nebula styling uses the shared design tokens. The File menu and command palette
share editor actions. Explorer expands the current branch in place using scoped
directory listings. Monaco reports the active language, line ending, and caret
position when available. Panel dimensions and visibility use versioned local
preferences. These preferences contain only layout values.

The bottom dock offers Terminal, Problems, and Output views and uses the same
layout controls as the side panels. Output shows Run & Build progress.
Problems displays live clangd diagnostics and recognized C++ compiler diagnostics.

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

## Managed C/C++ language intelligence and Problems

Open a workspace and select **Settings → Diagnostics → Enable clangd**. The native dialog
identifies the exact executable and asks for permission for this session.
Rust discovers an installed `clangd` from platform LLVM locations or absolute
PATH entries. It fingerprints the executable before and after confirmation.
The approval is never restored on launch or carried across workspace changes.
There is no download, frontend-supplied process path, shell invocation, or
generic JSON-RPC forwarding command. Only workbench windows have the four
language IPC permissions.

Rust owns one session per workbench with a live workspace grant and opaque
session ID. It reuses handle-relative file checks, and publishes a limited
temporary mirror of open C/C++ sources and headers to clangd. Saved file copies
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
closing tabs drive LSP document notifications. A rename closes the old URI
and opens the new path without replacing the Monaco model. The bridge accepts
hover, completion, definition and cancellation. It rejects stale or
unversioned diagnostics, ignores stale responses, rejects server-initiated
requests, and bounds frame size, queues and pending requests. Renderer results
are checked against the current editor revision before they reach Monaco.
Monaco completion supports plain-text insertions; additional source edits,
commands and snippets are excluded. Missing or crashed servers show a retry
action. Requests that are cancelled, or that expire after 10 seconds, send
`$/cancelRequest`; late replies are dropped. Server messages pass through a
bounded queue with backpressure, so a burst slows the server instead of
ending the session. Explicit Stop sends `shutdown` and waits up to 750 ms for
the reply, then sends `exit` and waits up to 750 ms for the server to close its
output. The result is reported as graceful, already exited, no reply or no
exit, and anything but graceful falls through to forced cleanup. Workspace
replacement, workspace close and window destruction revoke the session and
force process cleanup. Unix uses a process group, signalled before the
child is reaped so the group ID cannot be reused; Windows uses a
kill-on-close Job Object. A desktop crash can leave temporary files behind.

Every problem flows through one diagnostic store
(`language/diagnostic-store.ts`). A producer (`clangd` or `compiler`)
publishes a batch per document, stamped with the document's `uri`,
`revision` and `editRevision` at the time it was computed. A batch is shown
only while its open document still has that exact stamp and has not changed
on disk, so edits, saves, reloads, renames and closes clear stale items
deterministically. A newer batch from the same producer replaces the older
one, and a stopped or crashed producer publishes nothing, which clears its
items. Output is ordered by open-tab order, position, severity and producer,
with IDs that do not depend on arrival order.

Problems groups errors, warnings and informational messages. The Severity
filter is under **Settings → Diagnostics**. Rows open the
corresponding editor and location. The `clangd` marker owner is separate from
`compiler`. Compiler entries come from recognized C++ build stderr for the
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
They need no external tools, so CI runs them on macOS, Windows and Linux. An
opt-in integration test runs a trusted, already-installed clangd and requires
a graceful shutdown.

```sh
TURING_TEST_CLANGD=/absolute/path/to/clangd cargo test --release --locked \
  --manifest-path apps/desktop/src-tauri/Cargo.toml installed_clangd -- --ignored
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

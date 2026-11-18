# TURING — Technical Design Specification (TDS) v1.0

**Milestone:** Turing Core v0.1 Alpha  
**Date:** November 17, 2026  
**Status:** Proposed implementation blueprint  
**References:** PDR v1.0, SRS v1.0, SAD v1.0

## 1. Goal and release scope
Build the first functional cross-platform IDE without requiring AI. Deliver Tauri 2/React/TypeScript/Rust desktop shell; Nebula design system; Monaco tabs/splits; safe explorer; PTY terminal; local Git; initial language/debugger foundation; SQLite persistence; crash recovery; CI and automated tests. AI chat, agent, Graphify, Evolution, MCP and marketplace are out of scope.

## 2. Proposed technology choices
- Tauri 2, Rust, React, TypeScript, Monaco, Zustand and SQLite: confirmed baseline.
- Vite, Tailwind CSS/design tokens, xterm.js, portable-pty, Git CLI adapter, pnpm workspaces: proposed choices to validate.
- Vitest, React Testing Library, Cargo tests, appropriate desktop E2E automation and GitHub Actions: proposed testing stack.

## 3. v0.1 architecture
React UI (workspace, editor, explorer, terminal, Git, state) → typed Tauri command bridge → Rust permission/path policy → filesystem, PTY, Git, sessions → workspace files, shell, repository, SQLite. Do not expose generic arbitrary-command execution to untrusted content.

## 4. Repository structure
```text
turing/
  apps/desktop/
    src/app/{App.tsx,WorkspaceShell.tsx,providers/}
    src/components/{layout,common}/
    src/features/{editor,explorer,terminal,git,debugger,settings}/
    src/{services,stores,styles,main.tsx}
    src-tauri/src/{commands,filesystem,terminal,git,session,security,platform,lib.rs}
    src-tauri/{capabilities,migrations,Cargo.toml,tauri.conf.json}
  packages/{contracts,design-system}/
  docs/{PDR.md,SRS.md,SAD.md,TDS.md,adr/}
  tests/
  scripts/
  .github/workflows/
  pnpm-workspace.yaml
```
Frontend depends on typed service interfaces, native handlers on domain services, and services on testable adapters.

## 5. Nebula frontend
WorkspaceShell contains ActivityBar, ProjectExplorer, EditorWorkspace, TerminalPanel, GitPanel, ProblemsPanel, StatusBar, SettingsPanel. Dark midnight surfaces, violet/cyan accents, accessible focus, resizable panels, reduced motion. Stores hold UI metadata, not live Monaco model objects.

Illustrative editor types:
```typescript
interface EditorTab {
  id: string;
  workspaceId: string;
  path: string;
  dirty: boolean;
  viewState?: unknown;
}
interface EditorState {
  tabs: EditorTab[];
  activeTabId: string | null;
  openFile(path: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  markDirty(tabId: string, dirty: boolean): void;
}
```

## 6. Native command API
- workspace_open(directory) → workspace descriptor; workspace_close(id) → result.
- fs_list_directory(workspaceId,path) → entries.
- fs_read_file(workspaceId,path) → content, encoding, version.
- fs_write_file(workspaceId,path,content,expectedVersion) → updated version or conflict.
- fs_create_file, fs_create_directory, fs_rename, fs_delete → scoped results.
- fs_watch_start(workspaceId) → change events.
All paths are checked against trusted workspace registration and canonical filesystem targets, including symlinks. Define stable errors: NOT_FOUND, PERMISSION_DENIED, OUTSIDE_WORKSPACE, FILE_CONFLICT, INVALID_ENCODING, IO_ERROR.

Illustrative contract:
```typescript
interface FileSnapshot {
  workspaceId: string;
  relativePath: string;
  content: string;
  encoding: string;
  version: string;
  modifiedAt: number;
}
interface WriteFileRequest {
  workspaceId: string;
  relativePath: string;
  content: string;
  expectedVersion: string;
}
```

## 7. Editor file lifecycle
Open: select file → native validation/read → FileSnapshot → create/reuse Monaco model. Save: read editor model → validate path and expected version → reject conflicts or safely replace → update saved version → clear dirty flag only on confirmed success. Offer reload, compare or explicitly overwrite when external changes conflict.

## 8. Recovery
Maintain local recovery journal with workspace, path, base version, content/delta and timestamp. Debounce periodic snapshots; validate interval with performance tests. Do not discard recovery data until reconciled or explicitly rejected. Do not overwrite newer disk content during restoration.

## 9. Terminal
xterm.js → frontend terminal bridge → Rust PTY manager (portable-pty candidate) → OS shell. Commands: terminal_create, terminal_write, terminal_resize, terminal_close, terminal_list; terminal_output streams by session. Implement flow control, exit reporting, cleanup and cross-platform shell behavior. User terminal privileges are distinct from later agent command permissions.

## 10. Git
Use Rust adapter invoking Git executable with structured argument arrays, never shell-string concatenation. Commands: git_status, git_diff, git_stage, git_unstage, git_commit, git_branches, git_checkout, git_log. Handle unusual filenames, conflicts, uncommitted work and absent Git gracefully. Remote operations not required for v0.1.

## 11. Language intelligence and debugging
Monaco provides initial syntax support. Rust-managed LSP client + frontend adapter provides diagnostics/navigation where available. Proposed initial coverage: TypeScript/JavaScript, Python, Rust, JSON/HTML/CSS. DAP integration foundation and at least one validated debugging workflow; broader parity deferred.

## 12. Initial SQLite schema
```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);
CREATE TABLE settings (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  PRIMARY KEY(scope, scope_id, key)
);
CREATE TABLE editor_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  layout_json TEXT NOT NULL,
  active_tab_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);
CREATE TABLE editor_tabs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  group_id TEXT NOT NULL,
  tab_order INTEGER NOT NULL,
  view_state_json TEXT,
  FOREIGN KEY(session_id) REFERENCES editor_sessions(id) ON DELETE CASCADE
);
CREATE TABLE recovery_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  base_version TEXT NOT NULL,
  recovery_file_path TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
);
```
Enable foreign keys; apply transactional migrations; store large recovery content separately as appropriate; define retention and cleanup. Secrets never stored as plaintext settings.

## 13. Settings and security
Application/user/workspace settings have documented precedence. Sensitive credentials use OS-protected storage. Rust maintains trusted workspace registry and caller identity; frontend workspace IDs cannot grant permissions. Resource operations: ReadFile, WriteFile, CreateFile, DeleteFile, StartTerminal, ExecuteGit. Validate canonical targets and permissions at operation time.

## 14. Errors and diagnostics
- Missing file: preserve unsaved editor content.
- External change: offer conflict resolution.
- Permission denied: actionable scoped message.
- Terminal/Git unavailable: graceful degradation and retry.
- Migration failure: no destructive reset; recovery path.
- Language server failure: editor remains functional.
- Crash: restore recoverable session state.
Use structured errors and redacted diagnostic logs.

## 15. Tests and CI
- Vitest/React Testing Library: components, stores and interactions.
- Cargo tests: filesystem, Git, security and persistence.
- Desktop E2E: workspace, editor, terminal, Git, recovery.
- Security integration: symlinks, traversal, race conditions and denied paths.
- GitHub Actions: formatting/lint → tests → cross-platform builds → smoke tests → artifacts → release approval.
Test opening/saving, tabs, external changes, crash recovery, terminal, Git commit, unauthorized access, migration failures, keyboard navigation and resizing.

## 16. Work packages
1. Repository bootstrap: pnpm, Tauri, React, Rust, lint/test/CI.
2. Nebula shell: design tokens, navigation, command palette, layout persistence.
3. Workspace/filesystem: registry, explorer, watchers, safe read/write.
4. Monaco: models, tabs, splits, dirty state, conflict detection.
5. Terminal/Git: PTY, local Git workflows.
6. Persistence/recovery: migrations, settings, session restore, crash journal.
7. LSP/debug foundation: at least one validated language/debug path.
8. Alpha stabilization: security, performance, accessibility, platform smoke tests.

## 17. Definition of Done
v0.1 passes documented Windows/macOS/Linux development builds; file edit/save/recovery; interactive terminal; local Git workflow; initial language tooling/debugging; permission boundaries; required automated tests; reproducible build instructions.

## 18. Validation backlog
Prototype Monaco under each WebView, portable-pty shells, Git CLI availability, LSP adapters, SQLite recovery, Nebula accessibility/performance, packaging. Performance figures from the SRS remain targets, not measured results.

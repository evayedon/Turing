# Graph Report - Turing  (2026-11-18)

## Corpus Check
- Corpus is ~40,030 words - fits in a single context window. You may not need a graph.

## Summary
- 891 nodes · 1896 edges · 42 communities (35 shown, 7 thin omitted)
- Extraction: 94% EXTRACTED · 6% INFERRED · 0% AMBIGUOUS · INFERRED: 109 edges (avg confidence: 0.84)
- Token cost: 184,507 input · 0 output

## Community Hubs (Navigation)
- Atomic File Writes
- Editor State and Autosave
- Native Git Backend
- Terminal PTY Sessions
- Workspace Search Engine
- Workspace Authorization
- Desktop Dependencies
- Git Panel UI
- Product Spec Chain
- Tauri Command Layer
- Lint and Dev Tooling
- Frontend Test Suite
- Agent Rules and Design
- CI Workflow
- Tauri App Config
- Workbench Navigation UI
- Pane Layout Splitters
- PTY Process Guard
- Terminal Panel UI
- Workspace Error Types
- Workbench Shell Root
- Git Error Types
- TypeScript Base Config
- Monaco Editor Host
- Menus and Command Palette
- Bottom Dock Views
- Terminal Error Types
- Contracts Package
- App Icon Identity
- Design System Package
- Desktop TS Config
- Graph Intelligence Plans
- Persistence Schema Plans
- Contracts TS Config
- pnpm Workspace Config
- Performance Targets
- Architecture Decision Records
- Monorepo Layout Proposal
- AI Service Endpoints
- Rust Crate Manifest

## God Nodes (most connected - your core abstractions)
1. `useEditor()` - 32 edges
2. `Workbench()` - 31 edges
3. `Result` - 24 edges
4. `react` - 19 edges
5. `invokeWorkspace()` - 19 edges
6. `Result` - 17 edges
7. `WorkspaceError` - 17 edges
8. `Registry` - 17 edges
9. `in_workspace()` - 16 edges
10. `Result` - 16 edges

## Surprising Connections (you probably didn't know these)
- `UI/UX Design Authority` --conceptually_related_to--> `Turing Nebula v2 design spec`  [INFERRED]
  AGENTS.md → docs/Turing_Nebula_Design_v2.md
- `Turing Nebula v2 design spec` --implements--> `Milestone 2C: Turing Nebula UI/UX`  [EXTRACTED]
  docs/Turing_Nebula_Design_v2.md → AGENTS.md
- `Package responsibilities (shell, editor, explorer, search, state, src-tauri, contracts, design-system)` --conceptually_related_to--> `Tauri 2 / Rust / React / TypeScript / Vite / Zustand / Monaco stack`  [INFERRED]
  docs/architecture.md → AGENTS.md
- `Source of truth specifications (PDR, SRS, SAD, TDS)` --cites--> `Architecture notes`  [EXTRACTED]
  AGENTS.md → docs/architecture.md
- `Production CSP and explicit Tauri capabilities` --implements--> `Native security rules (default-deny, Rust-owned authorization)`  [INFERRED]
  docs/architecture.md → AGENTS.md

## Import Cycles
- 2-file cycle: `apps/desktop/src-tauri/src/workspace.rs -> apps/desktop/src-tauri/src/workspace/selected.rs -> apps/desktop/src-tauri/src/workspace.rs`
- 3-file cycle: `apps/desktop/src-tauri/src/workspace.rs -> apps/desktop/src-tauri/src/workspace/selected.rs -> apps/desktop/src-tauri/src/workspace/file.rs -> apps/desktop/src-tauri/src/workspace.rs`

## Hyperedges (group relationships)
- **Turing specification chain PDR -> SRS -> SAD -> TDS** — docs_turing_pdr_v1_0_pdr, docs_turing_srs_v1_0_srs, docs_turing_sad_v1_0_sad, docs_turing_tds_v1_0_tds [EXTRACTED 1.00]
- **Rust-owned authorization boundary for privileged operations** — docs_turing_pdr_v1_0_permission_gateway, docs_turing_sad_v1_0_policy_gateway, docs_turing_sad_v1_0_native_core, docs_turing_tds_v1_0_trusted_workspace_registry, docs_turing_tds_v1_0_native_command_api [INFERRED 0.85]
- **Editor open/save/recovery flow with version conflict detection** — docs_turing_tds_v1_0_editor_file_lifecycle, docs_turing_tds_v1_0_filesnapshot, docs_turing_tds_v1_0_writefilerequest, docs_turing_tds_v1_0_recovery_journal, docs_turing_tds_v1_0_sqlite_schema [INFERRED 0.85]
- **Caller-bound native authorization across workspace, search, file grants, and terminal** — docs_architecture_workspace_authorization, docs_architecture_workspace_search, docs_architecture_individual_file_grants, docs_architecture_integrated_terminal, agents_native_security_rules [INFERRED 0.85]
- **Nebula v2 workbench design system** — docs_turing_nebula_design_v2_design_tokens, docs_turing_nebula_design_v2_workbench_composition, docs_turing_nebula_design_v2_layout_rules, docs_turing_nebula_design_v2_welcome_surface, docs_turing_nebula_design_v2_command_palette [EXTRACTED 1.00]
- **Turing app icon multi-resolution set (same orbit design)** — apps_desktop_src_tauri_icons_icon_appicon, apps_desktop_src_tauri_icons_128x128_appicon, apps_desktop_src_tauri_icons_128x128_2x_appicon, apps_desktop_src_tauri_icons_32x32_appicon [INFERRED 0.95]

## Communities (42 total, 7 thin omitted)

### Community 0 - "Atomic File Writes"
Cohesion: 0.07
Nodes (35): assert_late_edit_is_preserved(), create(), link_based_replacement_preserves_a_competing_edit(), matches_version(), open_text(), preserves_an_edit_made_after_preflight(), read(), read_snapshot() (+27 more)

### Community 1 - "Editor State and Autosave"
Cohesion: 0.06
Nodes (53): AUTO_SAVE_DELAY_MS, DiscardAction, EditorLocation, loadAutoSave(), Operation, readFile(), SavedSource, selectedTab() (+45 more)

### Community 2 - "Native Git Backend"
Cohesion: 0.09
Nodes (56): accepts_ordinary_branch_names(), branches_at(), BranchInfo, checkout_at(), commit_at(), diff_at(), diffs_switches_and_lists_branches(), ensure_repo() (+48 more)

### Community 3 - "Terminal PTY Sessions"
Cohesion: 0.11
Nodes (25): CHUNK, closes_a_session_while_output_is_backpressured(), CONPTY_QUERIES, dimensions(), in_terminal(), OUTPUT_BATCH, output_until(), read_output() (+17 more)

### Community 4 - "Workspace Search Engine"
Cohesion: 0.09
Nodes (28): approved(), bounds_results_snippets_and_scan_budget(), cancellation_revokes_pending_and_running_jobs(), context(), IGNORED, matches_literals_with_unicode_columns_and_applies_options_and_exclusions(), MAX_DEPTH, MAX_DURATION (+20 more)

### Community 5 - "Workspace Authorization"
Cohesion: 0.10
Nodes (26): a_read_only_target_is_preserved_on_save_failure(), approved(), approved_handle_does_not_follow_a_replacement_at_the_original_path(), caller_and_active_registration_are_required_for_every_operation(), directory_at(), DirectoryEntry, EntryKind, Directory (+18 more)

### Community 6 - "Desktop Dependencies"
Cohesion: 0.06
Nodes (43): dependencies, lucide-react@^0.548.0, monaco-editor@^0.57.0, react@^19.2.0, react-dom@^19.2.0, @tauri-apps/api@^2.12.5, @turing/contracts@workspace:*, @turing/design-system@workspace:* (+35 more)

### Community 7 - "Git Panel UI"
Cohesion: 0.10
Nodes (33): gitErrorMessage(), invokeGit(), isGitError(), messages, badge, BranchBar(), ChangeGroup(), CommitBox() (+25 more)

### Community 8 - "Product Spec Chain"
Cohesion: 0.05
Nodes (43): Adaptive Intelligence (Token Efficiency), Extensions and Integrations (native, MCP, VS Code compat), Open-Core Editions (Community/Pro/Teams/Enterprise), Turing Product Design Requirements (PDR) v1.0, Native Permission Gateway, Incremental Release Roadmap (v0.1-v1.0), Security, Privacy and Reliability Requirements (SEC/REL), Supervised Agent Mode (+35 more)

### Community 9 - "Tauri Command Layer"
Cohesion: 0.13
Nodes (23): DiscardAction, Exit, Reload, Tab, Workspace, editor_confirm_discard(), editor_exit(), file_close() (+15 more)

### Community 10 - "Lint and Dev Tooling"
Cohesion: 0.08
Nodes (32): devDependencies, eslint@^9.39.0, @eslint/js@^9.39.0, eslint-plugin-react-hooks@^7.0.0, globals@^16.5.0, prettier@^3.6.0, typescript@~5.9.0, typescript-eslint@^8.46.0 (+24 more)

### Community 11 - "Frontend Test Suite"
Cohesion: 0.09
Nodes (22): @testing-library/react@^16.3.3, @testing-library/user-event@^14.6.12, vitest@^4.0.0, entries, ipc, openFile(), pickedFile, savedFile (+14 more)

### Community 12 - "Agent Rules and Design"
Cohesion: 0.10
Nodes (26): Milestone 2C: Turing Nebula UI/UX, Source of truth specifications (PDR, SRS, SAD, TDS), Tauri 2 / Rust / React / TypeScript / Vite / Zustand / Monaco stack, Turing Agent Development Instructions, Desktop index.html entry (root div + /src/main.tsx), Architecture notes, Auto Save (session-scoped, 1 s delay), Production CSP and explicit Tauri capabilities (+18 more)

### Community 13 - "CI Workflow"
Cohesion: 0.07
Nodes (27): NODE_OPTIONS, RUSTUP_TOOLCHAIN, jobs, verify, os, name, on, pull_request (+19 more)

### Community 14 - "Tauri App Config"
Cohesion: 0.10
Nodes (20): app, security, windows, withGlobalTauri, build, beforeBuildCommand, beforeDevCommand, devUrl (+12 more)

### Community 15 - "Workbench Navigation UI"
Cohesion: 0.22
Nodes (12): Explorer(), branch(), Props, MenuAction, ActivityBar(), destinations, RailButton(), fileActions() (+4 more)

### Community 16 - "Pane Layout Splitters"
Cohesion: 0.22
Nodes (12): clampSize(), fitColumns(), initialSizes, layoutKey, loadSizes(), maximumSizes, minimumSizes, Pane (+4 more)

### Community 17 - "PTY Process Guard"
Cohesion: 0.18
Nodes (8): guard(), ProcessGuard, reader(), Shell, spawn(), terminate(), UnixReader, File

### Community 18 - "Terminal Panel UI"
Cohesion: 0.31
Nodes (16): invokeTerminal(), terminalErrorMessage(), createTerminalView(), canMoveFocus(), closeNative(), Session, Status, stopWatching() (+8 more)

### Community 19 - "Workspace Error Types"
Cohesion: 0.12
Nodes (16): WorkspaceError, Busy, DirectoryTooLarge, FileConflict, FileTooLarge, InvalidEncoding, InvalidSearch, IoError (+8 more)

### Community 20 - "Workbench Shell Root"
Cohesion: 0.21
Nodes (9): root, BottomDock(), Panel(), Workbench(), onKey(), revealDock(), selectDock(), showPalette() (+1 more)

### Community 21 - "Git Error Types"
Cohesion: 0.17
Nodes (12): GitError, IdentityMissing, InvalidMessage, InvalidPath, InvalidRef, IoError, NoGit, NotARepository (+4 more)

### Community 22 - "TypeScript Base Config"
Cohesion: 0.17
Nodes (11): compilerOptions, isolatedModules, jsx, lib, module, moduleResolution, noEmit, skipLibCheck (+3 more)

### Community 23 - "Monaco Editor Host"
Cohesion: 0.29
Nodes (8): EditorInfo, EditorWorkspace(), MonacoHost, environment, languageFor(), MonacoHost(), OpenModel, EditorTab

### Community 24 - "Menus and Command Palette"
Cohesion: 0.27
Nodes (7): ActionMenu(), dismiss(), onClick(), onKey(), fixture(), CommandPalette(), close()

### Community 25 - "Bottom Dock Views"
Cohesion: 0.40
Nodes (7): details, DockView, dockViews, defaults, LayoutPreferences, LayoutState, SidebarView

### Community 26 - "Terminal Error Types"
Cohesion: 0.20
Nodes (10): TerminalError, AlreadyRunning, InputBusy, InputTooLarge, InvalidSize, IoError, PermissionDenied, PtyUnavailable (+2 more)

### Community 27 - "Contracts Package"
Cohesion: 0.25
Nodes (7): exports, name, private, scripts, typecheck, type, version

### Community 28 - "App Icon Identity"
Cohesion: 0.48
Nodes (7): Turing App Icon 128x128@2x, Turing App Icon 128x128, Turing App Icon 32x32, Turing App Icon (512 master), Nebula Icon Palette (lavender violet on near-black navy), Orbit Motif (tilted elliptical ring, central core, orbiting satellite), Rounded Square Dark Tile Shape

### Community 29 - "Design System Package"
Cohesion: 0.29
Nodes (6): exports, ./nebula.css, name, private, type, version

### Community 30 - "Desktop TS Config"
Cohesion: 0.50
Nodes (3): extends, include, ../../tsconfig.base.json

### Community 31 - "Graph Intelligence Plans"
Cohesion: 0.83
Nodes (4): Graphify (code-graph engine candidate), Project Context and Graph Intelligence, Code Intelligence Pipeline, Context Intelligence Requirements (CTX-001-008)

### Community 32 - "Persistence Schema Plans"
Cohesion: 0.50
Nodes (4): Persistence and Graph Data (SQLite tables), SRS Data Entities (Workspace, AgentTask, CodeRelation, ...), Recovery Journal, Initial SQLite Schema (workspaces, editor_sessions, recovery_entries)

### Community 33 - "Contracts TS Config"
Cohesion: 0.50
Nodes (3): extends, include, ../../tsconfig.base.json

### Community 34 - "pnpm Workspace Config"
Cohesion: 0.50
Nodes (3): allowBuilds, esbuild, packages

## Knowledge Gaps
- **74 isolated node(s):** `turing-core`, `Tab`, `Reload`, `Workspace`, `Exit` (+69 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 273 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **7 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `WorkspaceService` connect `Workspace Authorization` to `Tauri Command Layer`, `Native Git Backend`, `Terminal PTY Sessions`?**
  _High betweenness centrality (0.021) - this node is a cross-community bridge._
- **Are the 14 inferred relationships involving `useEditor()` (e.g. with `loadAutoSave()` and `changeWorkspace()`) actually correct?**
  _`useEditor()` has 14 INFERRED edges - model-reasoned connections that need verification._
- **What connects `turing-core`, `Tab`, `Reload` to the rest of the system?**
  _74 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Atomic File Writes` be split into smaller, more focused modules?**
  _Cohesion score 0.0715372907153729 - nodes in this community are weakly interconnected._
- **Why does `react` connect `Workbench Navigation UI` to `Editor State and Autosave`, `Desktop Dependencies`, `Git Panel UI`, `Frontend Test Suite`, `Pane Layout Splitters`, `Terminal Panel UI`, `Workbench Shell Root`, `Monaco Editor Host`?**
  _High betweenness centrality (0.016) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `Workbench()` (e.g. with `onKey()` and `toggleBottomFromControl()`) actually correct?**
  _`Workbench()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Should `Editor State and Autosave` be split into smaller, more focused modules?**
  _Cohesion score 0.0636523266022827 - nodes in this community are weakly interconnected._
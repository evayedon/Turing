# TURING — System Architecture Document (SAD) v1.0

**Date:** November 17, 2026  
**Status:** Proposed architecture baseline  
**References:** Turing PDR v1.0; SRS v1.0

## 1. Architecture principles

Turing shall be IDE-first, local-first, modular, secure under supervised autonomy, resource-aware, and cross-platform. Editing, Git, terminal and debugging must not require an AI service. Model providers, context indexes and extensions must be replaceable.

## 2. System decomposition

- **Presentation:** React/TypeScript, Monaco, Nebula workspace, Zustand, AI/graph panels.
- **Native core:** Tauri 2/Rust, command gateway, filesystem, Git, PTY, LSP/DAP managers, policy engine, extension manager.
- **AI runtime:** Python/FastAPI, orchestrator, adaptive router, context retrieval, Evolution (later phases). The v0.3 agent state machine runs in the Rust host (ADR-011).
- **Storage:** SQLite, text/vector indexes, code graph, OS credential store.
- **Providers:** local inference (Ollama/llama.cpp candidates), cloud APIs, future Turing LLM.
  All privileged agent actions must traverse the native policy gateway.

## 3. Process and lifecycle design

The Tauri/Rust process owns application lifecycle and managed subprocesses. React runs in the desktop WebView. A separately managed Python service provides AI and communicates over an authenticated local channel; loopback is the initial proposal, subject to security validation. LSP, DAP, extensions and model processes are separately managed where appropriate. AI service failure must not stop the IDE. For v0.3 the agent loop runs in the Rust process and exposes no authenticated local API; the Python service and its local channel remain later-phase.

## 4. Proposed monorepo

```text
turing/
  apps/desktop/
    src/{app,components,features,stores,services,hooks,styles}/
    src-tauri/src/{commands,services,security,extensions,platform}/
    src-tauri/capabilities/
  services/ai/app/{api,orchestration,models,agents,context,evolution,storage,security}/
  packages/{contracts,design-system,extension-sdk,shared-types}/
  extensions/examples/
  docs/{PDR.md,SRS.md,SAD.md,TDS.md,adr/,api/}
  scripts/
  tests/
  .github/
```

Dependency direction: UI → typed interfaces → native services; AI agents → policy gateway → native tools. Avoid exposing native privilege through unrestricted web APIs.

## 5. Frontend architecture

Components: TuringApp → WorkspaceShell → ActivityBar, ProjectExplorer, EditorWorkspace, AIAssistantPanel, TerminalPanel, StatusBar, GraphViewer and SettingsPanel. Feature-specific Zustand stores: workspace, editor, terminal, git, ai, agent, graph and settings. Monaco models are managed separately from serialized UI state. The UI does not directly execute OS commands or access arbitrary paths.

## 6. Rust native core

Modules: workspace, filesystem, terminal, git, debugger, language_servers, permissions, process_manager, extensions, platform and credentials. Native commands accept scoped operations and trusted session identity; the Rust core validates canonicalized resources and never treats caller-provided workspace IDs as sufficient authorization. The permission engine is centralized.

## 7. Python AI runtime

- Orchestrator: chat, context, streaming and cancellation.
- Router: model selection by task, user choice, privacy, latency and cost.
- Agent: plan, permission requests, execution, verification and history. _Superseded for v0.3 by ADR-011: the agent loop runs in the Rust host._
- Context: text/symbol/semantic/graph retrieval with source references.
- Evolution: local memory, feedback and evaluated improvement.
  Agent lifecycle (v0.3): Planning → AwaitingPlanApproval → Executing ⇄ Verifying → Review → Kept | RolledBack, plus Cancelled; cancellation and limit transitions are bounded.

  **ADR-011 (v0.3):** the agent loop runs in the Rust host. It supersedes the Python agent runtime for v0.3. The Python orchestrator, router and Evolution remain later-phase.

## 8. Security architecture

Default allow for authorized reads, searches and plans. Low-risk scoped edits require checkpoints and review. Explicit approval is required for destructive operations, dependency installation, remote pushes and outside-workspace access. Credentials are denied by default unless explicitly scoped and supported. No model may grant itself privileges; repository instructions and tool output are untrusted. Log approval scope and outcome; redact secrets; protect local AI service endpoints.

## 9. Persistence and graph data

SQLite tables proposed: workspaces, sessions, messages, agent_tasks, agent_steps, approvals, code_files, symbols, code_relations, model_profiles, usage_records, learning_memories and extensions. Keep credentials in OS protected storage. Version migrations, normalize paths, invalidate stale indexes and separate checkpoints from search indexes.

## 10. Code intelligence pipeline

File watcher → syntax parser/Tree-sitter and text search → symbols/relationships → replaceable graph adapter → optional embeddings/vector index → retrieval coordinator → context assembly → AI orchestrator. Evaluate Graphify for language support, accuracy, resource use, maintenance and integration before adoption. Retrieval results should include file references and freshness information.

## 11. Model provider abstraction

Provider interface concept: listModels(), generate(request) as a stream, cancel(requestId). Final contract must specify tool calling, error categories, context limits, privacy properties and usage accounting. Explicit user model choice and privacy restrictions override adaptive routing. Token efficiency cannot override correctness or hard budgets.

## 12. Extensions

Native-first, permissioned and versioned extension SDK. MCP adapters activate selectively. VS Code compatibility requires a dedicated host/API implementation and incremental validation; Monaco alone is insufficient.

## 13. Distribution and diagnostics

Windows: signed installer/package. macOS: signed/notarized application. Linux: packaging format after validation. Build and test per supported architecture; verify release integrity. Package Python service per OS; local model weights are configured separately. Structured diagnostics, redaction and optional telemetry.

## 14. Architecture decision records

ADR-001 Tauri/React/Rust; ADR-002 AI service lifecycle/IPC; ADR-003 SQLite migrations; ADR-004 permissions; ADR-005 model interface; ADR-006 context/graph; ADR-007 extension runtime; ADR-008 packaging/updates; ADR-009 licensing; ADR-010 LSP/DAP support; ADR-011 Rust agent loop for v0.3 (supersedes the Python agent runtime).

## 15. Implementation stages

1. Monorepo and Tauri shell.
2. Nebula UI, Monaco, files and recovery.
3. Terminal, Git, initial LSP/debugging.
4. AI runtime, model adapters, indexing.
5. Supervised agent and rollback (v0.3: Rust agent loop, ADR-011).
6. Extensions, MCP, memory and evaluations.
7. Production hardening across platforms.

## 16. Architecture readiness

Defined: subsystem responsibilities, process boundaries, security direction, repository layout and data entities. Pending: detailed API schemas, database migrations, benchmarks, packaging validation, licensing decision and extension isolation prototype.

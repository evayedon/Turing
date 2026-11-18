# TURING — Software Requirements Specification (SRS) v1.0

**Product:** Turing — AI-Native IDE  
**Date:** November 17, 2026  
**Status:** Engineering baseline; pending validation  
**References:** Turing PDR v1.0

## 1. Purpose and scope
This specification translates the Turing PDR into verifiable functional and non-functional requirements for a cross-platform AI-native IDE. MUST means required by the named release, SHOULD means recommended, and TBD denotes an unresolved engineering choice. Turing must remain a useful IDE without AI services.

## 2. Architecture baseline
- Desktop: Tauri 2, Rust native core, React/TypeScript, Monaco, Zustand, SQLite.
- AI: managed Python/FastAPI service, hybrid local/cloud providers, provider-independent routing.
- Context: local repository indexing, language-server information, syntax parsing, search and graph-based retrieval.
- Security: privileged operations mediated by a native permission gateway.
- Platforms: Windows, macOS and Linux; supported versions and architectures to be determined.

## 3. Functional requirements
### 3.1 Application and editor
- **APP-001 (v0.1):** Launch on supported Windows, macOS and Linux configurations.
- **APP-002 (v0.1):** Create, open, close and reopen workspaces.
- **APP-003 (v0.1):** Persist tabs, layout, themes and workspace preferences.
- **APP-004 (v0.1):** Restore recoverable unsaved content after a crash.
- **APP-005 (v0.1):** Provide configurable shortcuts and command palette.
- **APP-006 (v1.0):** Support multiple windows after platform validation.
- **EDT-001 (v0.1):** Integrate Monaco.
- **EDT-002 (v0.1):** Support syntax highlighting, indentation, line numbers, search and replace.
- **EDT-003 (v0.1):** Support tabs, split views and editor settings.
- **EDT-004 (v0.1–v0.2):** Integrate supported LSP diagnostics, definitions, references and completions.
- **EDT-005 (v0.3):** Show inline and side-by-side diffs.
- **EDT-006 (v0.1):** Detect external changes and prevent silent overwrites.
- **EDT-007 (v1.0):** Degrade gracefully for large files.

### 3.2 Filesystem
- **FS-001:** Create, rename, move, delete and navigate files/directories.
- **FS-002:** Respect OS permissions and canonical workspace boundaries.
- **FS-003:** Report conflicts and actionable filesystem errors.
- **FS-004:** Support indexing exclusions for binaries, secrets and generated content.
- **FS-005:** Restrict agent file access to authorized locations.
- **FS-006:** Require approval and audit for destructive agent operations.

### 3.3 Developer tools
- **DEV-001 (v0.1):** Provide interactive terminal sessions with OS-appropriate shells.
- **DEV-002 (v0.1):** Support terminal creation, termination, resizing and streamed output.
- **DEV-003 (v0.1):** Provide Git status, staging, commits, branches and diffs.
- **DEV-004 (v0.3):** Require authorization for agent-initiated remote Git operations.
- **DEV-005:** Establish debugging through supported DAP integrations; validate production support by v1.0.
- **DEV-006 (v0.1):** Execute configured test commands and report results.
- **DEV-007 (v0.3):** Let agents run approved tests and analyze failures.

### 3.4 AI modes and routing
- **AI-001 (v0.2):** Ask Mode for read-only assistance.
- **AI-002 (v0.3):** Edit Mode for proposed modifications.
- **AI-003 (v0.3):** Supervised Agent Mode.
- **AI-004 (v0.2 foundation):** Context-aware autocomplete.
- **AI-005 (v0.2):** Stream responses and support cancellation.
- **AI-006 (v0.2):** Select configured local/cloud models.
- **AI-007 (v0.2):** Show model availability, errors and usage.
- **AI-008 (v0.2):** Retain conversation history under user-controlled policies.
- **MODEL-001:** Provide a model-provider-independent inference interface.
- **MODEL-002:** Support model assignments by task type.
- **MODEL-003:** Route based on complexity, capability, latency, privacy and cost.
- **MODEL-004:** Do not silently transmit local source to cloud inference.
- **MODEL-005:** Handle provider failures and authorized fallback.
- **MODEL-006:** Store credentials securely, never as plaintext workspace settings.

### 3.5 Supervised agent
- **AGT-001:** Plan complex tasks.
- **AGT-002:** Read authorized workspace content without repeated approvals.
- **AGT-003:** Apply scoped low-risk edits with checkpoints and review.
- **AGT-004:** Require approval for sensitive or destructive actions.
- **AGT-005:** Display execution history and tool outcomes.
- **AGT-006:** Support cancellation and bounded execution.
- **AGT-007:** Create recoverable checkpoints before consequential edits.
- **AGT-008:** Run authorized verification and disclose failures.
- **AGT-009:** Treat repository content and tool results as untrusted instructions.
- **AGT-010:** Prevent approval bypass through prompt injection or tool chaining.
All AGT requirements target v0.3.

### 3.6 Context intelligence
- **CTX-001:** Index authorized project files locally with exclusions.
- **CTX-002:** Support symbol-aware retrieval via syntax/LSP information.
- **CTX-003:** Support text search and optional semantic retrieval.
- **CTX-004:** Represent detectable imports, references, calls and inheritance.
- **CTX-005:** Incrementally update indexes where feasible.
- **CTX-006:** Expose progress, pause, resume, rebuild and disable controls.
- **CTX-007:** Preserve source references and index freshness/coverage caveats.
- **CTX-008:** Make the graph engine replaceable; evaluate Graphify, do not assume suitability.

### 3.7 Adaptive Intelligence
- **OPT-001:** Default to Adaptive Intelligence.
- **OPT-002:** Remove redundant context without compromising completeness.
- **OPT-003:** Increase model capability/context when justified.
- **OPT-004:** Support user-defined budgets and usage limits.
- **OPT-005:** Ask before exceeding hard budgets.
- **OPT-006:** Distinguish measured tokens from estimated usage.
- **OPT-007:** Retain security requirements and unresolved errors during compression.
- **OPT-008:** Activate MCP tools on demand.
Acceptance: compare coding quality, completeness, latency and token usage; token savings alone do not establish success.

### 3.8 Turing Evolution
- **EVO-001 (v0.2):** Store authorized preferences and project conventions locally.
- **EVO-002 (v0.2):** Record developer feedback.
- **EVO-003 (v0.5):** Link learning examples to verified outcomes.
- **EVO-004 (v0.5):** Evaluate improved retrieval/tool strategies.
- **EVO-005 (v0.5):** Inspect, correct and clear learned preferences.
- **EVO-006 (v0.5):** Require explicit opt-in for shared learning.
- **EVO-007 (v0.5):** Filter sensitive data from training contributions.
- **EVO-008 (post-v0.5):** Controlled fine-tuning with benchmarks, versions and rollback.
- **EVO-009:** Prevent uncontrolled modification of executable code or model artifacts.
Memory-based adaptation does not modify model weights.

### 3.9 Extensions and UI
- **EXT-001–EXT-003:** Versioned native extension interfaces, capability declarations and permission management.
- **EXT-004–EXT-005:** MCP discovery with selective tool activation.
- **EXT-006–EXT-007:** Install, disable, update, remove and isolate extensions where feasible.
- **EXT-008–EXT-009:** Progressively validate VS Code extension compatibility; Monaco alone does not confer compatibility.
- **UI-001–UI-010:** Implement dark-first Turing Nebula, midnight/violet/cyan tokens, resizable panels, integrated AI workflows, optional graph view, keyboard navigation, accessible focus/contrast, reduced motion and performant visuals.

## 4. Non-functional requirements
### Performance — provisional targets
- **NFR-P01:** Warm startup <=3 seconds.
- **NFR-P02:** Typing latency P95 <=50 ms.
- **NFR-P03:** Idle IDE memory <=500 MB excluding AI processes.
- **NFR-P04:** Target 60 FPS for ordinary UI interaction.
- **NFR-P05–P07:** Editing remains responsive during background work; indexing and agents are cancellable and resource-bounded.
These targets require hardware- and repository-specific benchmarks.

### Reliability
- **NFR-R01–R06:** Recover user work after recoverable failures; report failed writes; avoid overwriting later edits during rollback; version database migrations; isolate AI failures; safely resume/rebuild indexes.

### Security
- **NFR-S01–S08:** Narrow native privilege interfaces, consistent model-independent policy, scoped approval audit, redacted diagnostics, isolated extension capabilities, authenticated local AI endpoints, authentic update packages, command/path/network safeguards.

### Privacy and portability
- **NFR-PR01–PR05:** Offline indexing; local learning by default; separate cloud inference from shared training; opt-out telemetry; documented retention and deletion.
- Support keyboard accessibility, readable contrast, scalable text, reduced motion and validated cross-platform adapters.

## 5. System interfaces
- Frontend/native: Tauri commands and events.
- Frontend/AI: authenticated local API and streaming.
- Agent/native: permission-checked tool gateway.
- AI/models: provider-independent inference adapters.
- AI/context: search, symbols, graph traversal and source retrieval.
- Extensions: versioned capability APIs and MCP.
Proposed AI endpoints: GET /v1/models; POST /v1/chat; POST /v1/agents/tasks; GET /v1/agents/tasks/{id}; POST /v1/agents/tasks/{id}/cancel; POST /v1/context/search; GET /v1/index/status; GET /v1/usage. Endpoints are preliminary, not finalized contracts.

## 6. Data requirements
Entities: Workspace, EditorSession, Conversation, AgentTask, AgentStep, Approval, CodeFile, Symbol, CodeRelation, ModelProfile, UsageRecord, LearningMemory, Extension. Use SQLite for structured metadata and local indexes/graph storage where appropriate. Keep secrets in OS-protected storage; use migrations and recovery policies.

## 7. Critical workflows
- Agent task: submit → inspect/context → plan → permission decision → approved execution → verification → diff/history → complete or iterate/cancel.
- Context query: identify workspace → retrieve symbols/search/graph → assemble referenced evidence → choose model → answer.
- Learning: capture authorized feedback → verify outcomes → update local memory or evaluated strategies → allow correction/rollback.

## 8. Verification and release gates
- Unit tests: Rust, TypeScript, Python.
- Integration tests: native bridge, storage, providers, permissions.
- End-to-end tests: editor, Git, terminal, agent.
- Security: prompt injection, path traversal, extension permissions.
- Reliability: crash recovery, interrupted writes, agent cancellation.
- Performance: startup, typing, memory, indexing.
- Cross-platform and accessibility tests for release candidates.
- **v0.1:** Usable editor, terminal, Git, workspace persistence and recovery.
- **v0.2:** At least one local and one cloud model, indexing and traceable context.
- **v0.3:** Supervised multi-file task with approvals, tests, diffs and rollback.
- **v0.4:** Permissioned native extensions and MCP.
- **v0.5:** Reversible, privacy-controlled evaluated learning.
- **v1.0:** Committed production requirements pass security, reliability, accessibility and cross-platform gates.

## 9. Outstanding decisions
Initial language coverage; extension isolation; Graphify feasibility; local/cloud providers; credential storage; update infrastructure; Apache 2.0 license proposal; packaging; accessibility benchmark. Record decisions as ADRs.

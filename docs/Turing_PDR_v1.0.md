# TURING — Product Design Requirements (PDR) v1.0

**Product:** Turing — AI-Native Integrated Development Environment  
**Version:** 1.0  
**Date:** November 17, 2026  
**Status:** Consolidated product baseline  
**Design system:** Turing Nebula  
**Inspiration:** Alan Turing

> **Product principle:** Turing is a complete, professional IDE with AI deeply integrated into software development—not simply a chatbot attached to an editor.

## 1. Executive Summary

Turing is a cross-platform, AI-native IDE for building, understanding, debugging, testing, and maintaining software. It combines a professional development environment with local/cloud AI, a supervised autonomous agent, graph-based code intelligence, adaptive inference efficiency, and privacy-first continuous learning.

Its key differentiators are a fully integrated AI workflow, project-wide code understanding, developer-controlled automation, and an open-core ecosystem. The first releases must remain useful even without a cloud AI subscription.

## 2. Product Vision and Objectives

**Vision:** Give developers an intelligent development environment capable of understanding and engineering complete software systems.

**Objectives:**

- Deliver a reliable editor with project management, Git, terminal, debugging, and testing.
- Support Windows, macOS, and Linux through a shared desktop architecture.
- Support local and cloud models, with a future independently improved Turing coding model.
- Enable multi-step, multi-file coding tasks with supervised autonomy, approvals, diffs, and rollback.
- Understand repository structure using syntax, language services, search, and code relationships.
- Optimize token usage without sacrificing correctness, context, or complete execution.
- Improve through authorized local experience and optional opt-in contributions.
- Support a useful open-source Community edition and optional commercial services.

## 3. Target Users

- Individual software developers and computer science students.
- Professional engineers maintaining medium-to-large repositories.
- Teams needing controlled AI-assisted development workflows.
- Privacy-conscious developers who prefer local AI models.
- Organizations needing policy controls and managed services in later editions.

## 4. Confirmed Product Decisions

| Area | Decision |
|---|---|
| Product name | Turing |
| Desktop framework | Tauri 2 |
| Supported operating systems | Windows, macOS, Linux |
| Frontend | React + TypeScript |
| Editor | Monaco Editor |
| Native core | Rust |
| AI orchestration | Python + FastAPI |
| Frontend state | Zustand |
| Local metadata | SQLite |
| AI strategy | Hybrid local/cloud; future Turing LLM |
| Agent | Supervised autonomy |
| Context engine | Local indexing, syntax/LSP/search, code graph |
| Graphify | Initial evaluation candidate; replaceable adapter |
| Token efficiency | Adaptive Intelligence by default |
| Learning | Turing Evolution, local-first |
| Shared learning | Explicit opt-in |
| Visual identity | Turing Nebula |
| Plugins | Native-first, MCP, progressive VS Code compatibility |
| Release strategy | Incremental releases |
| Business model | Open core |

## 5. Scope and Feature Requirements

### 5.1 Professional IDE Foundation

**IDE-001:** Create, open, edit, save, and manage files and project workspaces.  
**IDE-002:** Support syntax highlighting, code navigation, diagnostics, completions, tabs, split editors, and keyboard shortcuts.  
**IDE-003:** Integrate Git, interactive terminal, debugging, and test execution.  
**IDE-004:** Persist workspace state and recover unsaved work where technically feasible.  
**IDE-005:** Provide project search, file exclusions, settings, and a command palette.

### 5.2 AI Modes and Model Integration

**AI-001:** Provide Ask, Edit, Agent, and Autocomplete modes.  
**AI-002:** Offer model selection through a provider-independent router supporting local and cloud inference.  
**AI-003:** Stream AI output, support cancellation, and surface model errors and usage information.  
**AI-004:** Enable code explanation, generation, refactoring, debugging assistance, and project-aware responses.  
**AI-005:** Support separate model choices for latency-sensitive completion and complex agent tasks.

### 5.3 Supervised Agent Mode

**AGENT-001:** Automatically inspect authorized workspace files, search the codebase, and plan tasks.  
**AGENT-002:** Allow approved low-risk edits and commands within configured permissions.  
**AGENT-003:** Require approval for destructive operations, sensitive commands, dependency installation, remote pushes, and out-of-workspace access.  
**AGENT-004:** Display plans, execution steps, tool results, and reviewable multi-file diffs.  
**AGENT-005:** Support checkpoints, cancellation, verification, and rollback.  
**AGENT-006:** Treat repository content and external tool output as untrusted; enforce permissions independently of model instructions.

### 5.4 Project Context and Graph Intelligence

**CTX-001:** Index authorized projects locally by default with configurable exclusions.  
**CTX-002:** Combine Tree-sitter-style syntax parsing, LSP data, fast text search, and optional semantic retrieval.  
**CTX-003:** Support graph relationships such as imports, calls, references, and inheritance where detectable.  
**CTX-004:** Incrementally update indexes when feasible and display indexing progress.  
**CTX-005:** Let developers pause, rebuild, or disable indexing.  
**CTX-006:** Evaluate Graphify as a code-graph engine through a replaceable interface, not as a mandatory dependency.  
**CTX-007:** Retain traceable source references in retrieved context.

### 5.5 Adaptive Intelligence and Token Efficiency

**OPT-001:** Default to Adaptive Intelligence, balancing cost, capability, context, and complexity.  
**OPT-002:** Avoid redundant tokens, duplicated context, unnecessary tool definitions, and verbose irrelevant logs.  
**OPT-003:** Expand context, reasoning effort, and tool usage when necessary for correctness and completeness.  
**OPT-004:** Use prompt caching, selective retrieval, model routing, and tool-result compression where supported and safe.  
**OPT-005:** Display measured or clearly labeled estimated token usage and costs.  
**OPT-006:** Respect user-defined budgets and request permission rather than silently truncating required work.

**Guiding principle:** Token-conservative does not mean stingy: use every token necessary to solve the problem correctly, but waste none unnecessarily.

### 5.6 Turing Evolution — Self-Learning

**LEARN-001:** Learn developer preferences, coding conventions, and project decisions through authorized local memory.  
**LEARN-002:** Use accepted/rejected edits, test outcomes, and other verified signals to evaluate future strategies.  
**LEARN-003:** Improve context retrieval, model selection, and tool selection without requiring model-weight changes.  
**LEARN-004:** Allow developers to inspect, correct, and clear learned information.  
**LEARN-005:** Keep personal/project learning local by default.  
**LEARN-006:** Require explicit opt-in and approval for shared learning contributions; do not automatically contribute private code or credentials.  
**LEARN-007:** Support controlled dataset curation, fine-tuning, evaluation, versioning, and rollback in later phases.  
**LEARN-008:** Prevent uncontrolled self-modification of the application or deployed model.

### 5.7 Extensions and Integrations

**EXT-001:** Provide native Turing extension APIs with versioned contracts and scoped permissions.  
**EXT-002:** Support MCP integrations with on-demand discovery and activation.  
**EXT-003:** Allow extension installation, updates, disabling, and removal.  
**EXT-004:** Progressively investigate VS Code extension compatibility through a dedicated compatibility layer.  
**EXT-005:** Isolate extension failures where practical and require approval for privileged access.  
**EXT-006:** Plan a searchable extension marketplace for later releases.

## 6. Turing Nebula — UI/UX Requirements

Turing Nebula is the approved futuristic, dark-first visual direction. It features midnight backgrounds, electric violet/cyan accents, restrained glass-like panels, subtle glow, polished typography, and a prominent AI Agent interface.

**UI-001:** Provide activity bar, project explorer, Monaco editor, AI sidebar, terminal, problems/debugging panels, and status bar.  
**UI-002:** Provide an optional interactive code dependency graph.  
**UI-003:** Support resizable, collapsible, customizable panels and keyboard-first navigation.  
**UI-004:** Provide visible AI plans, approval dialogs, diff reviews, and execution status.  
**UI-005:** Support accessible contrast, scalable text, focus indicators, and reduced-motion preferences.  
**UI-006:** Avoid visual effects that impair performance or long-session readability.  
**UI-007:** Support additional themes through a reusable design-token system.

The approved visual concept is a reference, not a rigid implementation blueprint.

## 7. Proposed Technical Architecture

**Desktop/UI:** Tauri 2 + Rust, React + TypeScript, Monaco Editor, Tailwind CSS, Zustand.  
**AI service:** Python + FastAPI with a provider-independent model router and supervised agent runtime.  
**Context:** Tree-sitter candidate, LSP, ripgrep, SQLite/FTS, optional semantic retrieval, and graph engine adapter.  
**Inference:** Local inference through evaluated runtimes such as Ollama or llama.cpp; cloud providers through adapters; future Turing LLM.  
**Storage:** SQLite for settings, metadata, task history, and local memory; secure OS credential storage for secrets.  
**Extensions:** Native extension APIs, MCP, and progressively validated VS Code compatibility.

The native core shall mediate privileged filesystem, terminal, and Git actions through a permission gateway. Components should use replaceable interfaces to avoid unnecessary vendor lock-in.

## 8. Security, Privacy, and Reliability

**SEC-001:** Restrict agent file access to authorized workspaces.  
**SEC-002:** Require explicit approval for destructive or sensitive operations.  
**SEC-003:** Protect API credentials and minimize secrets exposure in logs.  
**SEC-004:** Treat project files, model output, and external tools as untrusted where appropriate.  
**SEC-005:** Require explicit authorization for cloud processing and separately for shared model-training contributions.  
**SEC-006:** Apply capability restrictions to extensions and MCP tools.  
**REL-001:** Recover unsaved editor content and workspace state after recoverable failures.  
**REL-002:** Support agent checkpoints and conflict-aware rollback.  
**REL-003:** Keep core editing functional if cloud AI, plugins, or background indexing fail.  
**REL-004:** Support offline editing and supported local AI workflows.  
**REL-005:** Allow cancellation and resource throttling for long-running tasks.

## 9. Performance and Hardware Targets

These are provisional engineering targets, not validated product measurements.

| Metric | Proposed target |
|---|---|
| Warm startup | ≤ 3 seconds |
| Local typing response | P95 ≤ 50 ms |
| Idle IDE memory | ≤ 500 MB, excluding AI processes |
| Ordinary UI interaction | Target 60 FPS |
| Standard hardware | 8 GB RAM minimum target; 16 GB recommended |
| AI workstation | 32–64 GB+ RAM; optional dedicated GPU |

Benchmark representative Windows, macOS, and Linux systems, with defined project sizes and background workloads. The editor must remain responsive during indexing and inference.

## 10. Incremental Release Roadmap

| Milestone | Scope | Exit criterion |
|---|---|---|
| v0.1 Alpha — Turing Core | Desktop shell, editor, explorer, Git, terminal, Nebula UI, persistence | Real projects can be edited, run, and version-controlled |
| v0.2 Alpha — Turing Intelligence | AI chat, local/cloud models, indexing, context, adaptive routing, initial memory | Project-aware AI works with at least one local and one cloud model |
| v0.3 Alpha — Turing Agent | Supervised workflows, multi-file edits, approvals, tests, rollback | Representative multi-file task completes with enforced approvals |
| v0.4 Beta — Turing Ecosystem | Native extensions, MCP, compatibility foundation | Extensions and MCP tools can be managed safely |
| v0.5 Beta — Turing Evolution | Advanced experience learning, opt-in sharing, model evaluation pipeline | Learning is measurable, privacy-controlled, and reversible |
| v1.0 Stable | Cross-platform validation, security, accessibility, optimization | Production acceptance suite passes |

Release numbers are provisional milestones, not promised dates. Basic memory and feedback begin in v0.2; advanced model fine-tuning may extend beyond v0.5.

## 11. Open-Core Editions and Licensing

**Turing Community:** Useful open-source IDE with editor, Git, terminal, local AI, and essential agent features.  
**Turing Pro:** Optional premium cloud AI and managed productivity services.  
**Turing Teams:** Collaboration, shared settings, and team management.  
**Turing Enterprise:** Identity, policy, auditing, and enterprise deployment capabilities.

**LIC-001:** Community shall remain genuinely useful without a subscription.  
**LIC-002:** Essential editing and supported local-model workflows shall not require paid cloud services.  
**LIC-003:** Commercial services shall extend the shared core through documented interfaces.  
**LIC-004:** Third-party licenses shall be reviewed before distribution.  
**LIC-005:** Users retain control over project code and local configuration.

**Licensing status:** Apache License 2.0 is recommended for Community but is not yet finalized. Model weights and commercial boundaries require separate decisions.

## 12. Acceptance Criteria

Turing's stable release should demonstrate that users can:

1. Install and run Turing on supported Windows, macOS, and Linux configurations.
2. Create, open, edit, save, debug, test, and version-control real projects.
3. Select and use supported local and cloud AI models.
4. Ask project-aware questions with traceable source context.
5. Request multi-file changes and review diffs before sensitive actions.
6. Use a supervised agent with permission enforcement, test execution, cancellation, and rollback.
7. Recover work after representative failures.
8. Configure indexing, extensions, AI budgets, privacy, and model providers.
9. Use the Community edition for essential development without a paid subscription.

## 13. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Cross-platform WebView inconsistencies | Test Monaco and UI on all target OSs |
| Agent overreach or prompt injection | Scoped permissions, approvals, audit history, sandboxing |
| High inference cost | Adaptive routing, caching, selective retrieval, budget controls |
| Incomplete code graph | Combine graph results with LSP, search, and source validation |
| Faulty AI edits | Diff review, tests, checkpoints, rollback |
| Extension incompatibility | Native-first interfaces; validate compatibility incrementally |
| Incorrect learning signals | Curated feedback, evaluations, reversibility |
| Scope creep | Release gates and staged delivery |

## 14. Outstanding Decisions

- Final Community license and paid feature boundaries.
- Initial programming languages and debugger support.
- First local and cloud model integrations.
- Graphify feasibility and benchmark outcomes.
- Extension-host isolation and VS Code compatibility scope.
- OS-specific distribution, code signing, and update mechanisms.
- Detailed API contracts, database schemas, and module architecture.
- Final supported OS versions, CPU architectures, and accessibility criteria.

## 15. PDR Status and Next Steps

**PDR v1.0 is the consolidated product baseline.** It establishes approved product goals and high-level requirements while documenting implementation choices that remain subject to evaluation.

**Next engineering artifacts:** Software Requirements Specification (SRS), System Architecture Document (SAD), Architecture Decision Records (ADRs), interface and schema specifications, and the Turing Core implementation plan.

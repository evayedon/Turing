# Turing — Agent Development Instructions

## Mission and current scope

Turing is a cross-platform, AI-native IDE with a professional editor and the **Turing Nebula** dark workbench. Build a dependable, secure IDE foundation before adding AI features.

**Current phase:** Turing Core **v0.1, Milestone 2C: Turing Nebula UI/UX**. Do not assume a milestone is accepted solely because code was generated.

## Stack and repository

- **Desktop:** Tauri 2 and Rust; **frontend:** React, TypeScript, Vite, Zustand; **editor:** Monaco.
- **Package management:** pnpm workspaces. Use the existing lockfile and package scripts.
- **Layout:** `apps/desktop` (React UI and `src-tauri` native host), `packages/contracts` (typed boundaries), `packages/design-system` (Nebula tokens), `docs` (specifications), `.github/workflows` (CI).
- Future phases may add Python/FastAPI, local/cloud AI, agents, extensions, and persistence. Do not introduce these ahead of their planned work packages.

## Source of truth and context use

- Read this file and inspect the affected code first. Consult **only the relevant sections** of the specifications when a task needs them:
  - `docs/Turing_PDR_v1.0.md` — product intent, scope, milestones.
  - `docs/Turing_SRS_v1.0.md` — feature requirements and acceptance criteria.
  - `docs/Turing_SAD_v1.0.md` — architectural boundaries and security.
  - `docs/Turing_TDS_v1.0.md` — v0.1 technical interfaces, workflows, tests.
  - `docs/architecture.md` — current implementation notes; check against actual code.
- Follow the UI/UX Design Authority below for presentation decisions. Escalate conflicts involving functional requirements, security, or architecture by stating the conflict and proposing a decision. Read broader sections only for cross-cutting changes or ambiguity.
- Search narrowly, reuse previously established context, and avoid rereading whole files or rerunning expensive checks without a reason. **Efficiency must never reduce correctness, security, or verification.**

## Engineering conventions

- **TypeScript/React:** strict typing; avoid `any` and unchecked casts; small focused components and hooks; accessible controls, visible focus, keyboard support; scoped Zustand selectors; keep native calls behind typed service/contracts modules.
- **Rust/Tauri:** explicit command inputs/outputs and error types; isolate native operations into testable modules; no panic-based handling of untrusted input; structured subprocess arguments, never interpolated shell commands.
- Prefer incremental changes for routine engineering work. For approved UI/UX redesigns, follow the design authority below. Keep browser preview behavior separate from native-only functionality.
- Avoid adding dependencies without a demonstrated need; keep cross-platform behavior in mind.

## UI/UX Design Authority

Turing Nebula is a distinctive, premium AI-native IDE interface.

An explicitly approved UI/UX redesign authorizes substantial frontend restructuring and visual experimentation within scope, including replacing or removing presentation code. Existing UI structures and CSS conventions are flexible.

- The approved design brief and visual reference govern presentation decisions. Use the reference as the primary visual direction, retain Turing's branding, and apply installed design skills, including taste-skill and frontend-design.
- Prioritize visual quality, usability, accessibility, responsiveness, and consistency. Give an approved redesign the scope it needs to improve composition and interaction as well as color.
- Preserve existing functionality and regression coverage. Update presentation-specific assertions when the approved design changes them. Keep controls honest.

The security, architecture, quality, and Git requirements in this file apply throughout redesigns.

## Native security (non-negotiable)

- Default-deny Tauri permissions: explicitly enumerate required capabilities and commands. Do not grant generic filesystem, shell, dialog, or remote access merely for convenience.
- Rust owns workspace registration and authorization. A frontend-supplied path or workspace ID is **not** proof of access. Bind operations to the verified caller and active approved workspace.
- Validate paths at operation time; reject traversal, absolute/out-of-scope access, symlink escapes, and root-replacement races. Prefer handle-relative filesystem access where supported. Preserve these protections when adding writes, renames, watches, or terminal access.
- Never expose credentials in logs, fixtures, commits, or diagnostics. Require explicit user approval for destructive actions and access outside approved scope.

## Quality gates

- Add focused tests at the affected layer. Cover failures and authorization denial where applicable. Security-sensitive code needs traversal, symlink, and race regression coverage.
- Before declaring a task complete, run relevant repo scripts for lint, formatting, typechecking, tests, and build; include `cargo fmt --check` and Rust tests when Rust changes. Prefer non-bundled Tauri builds for routine checks; avoid DMG creation unless requested.
- Maintain GitHub Actions validation on macOS, Windows, and Linux. A green compile job is **not** evidence of GUI launch or end-to-end behavior; report untested platforms and workflows explicitly.
- Summarize files changed, checks actually run, pass/fail results, and remaining risks. Do not claim tests passed without executing them.

## Scope and Git discipline

- Implement **only the requested work package**. Do not preemptively implement AI, autonomous agents, Monaco, file writes, terminal, Git UI, debugging, or other features outside the active task.
- Preserve unrelated work. Obtain explicit user approval for destructive changes outside the approved scope. Never commit, push, create releases, or modify remote repositories without **explicit user approval**.
- Before handoff, show a concise change summary and any decisions requiring review.

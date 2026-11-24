# Turing IDE

Turing IDE is a modern, cross-platform development environment built with Rust,
Tauri 2, React, TypeScript, and Monaco Editor. Its Nebula workbench brings code
editing, integrated terminals, and local Git workflows together. The current
release is **v0.1 — Turing Core**. AI-native development is the product direction.

### Implemented in v0.1

- **Workspace and editing.** Open a workspace folder or standalone file from the
  File menu. Use the Explorer, workspace search, editor tabs and splits, versioned
  saves, Save As, external-change detection, and unsaved-draft recovery.
- **Integrated terminal and Git.** Open, resize, and split native shell sessions.
  Inspect Git status and diffs, stage and unstage changes, make local commits,
  switch branches, and view history.
- **Run & Build.** Run supported saved source files with locally installed
  toolchains and see build and program output in the workbench. F5 runs the
  active file without debugging.

### Opt-in and limited in v0.1

The desktop workbench can use locally installed clangd, TypeScript Language
Server, Pyright, and rust-analyzer with workspace approval. Diagnostics and
navigation depend on the installed server and its advertised capabilities.
See [Architecture](docs/architecture.md#managed-language-intelligence-and-problems)
for setup and access details.

### Planned for v0.2 — Professional Development and AI Foundation

The next milestone focuses on professional development workflows and a read-only,
project-aware Ask Mode. Planned AI capabilities include workspace indexing,
traceable file context, and support for local and cloud models. Full debugger
support and supervised AI agents remain future work.

## Development

Install Node.js 22.12 or later, pnpm 12.21.0, stable Rust, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
pnpm install --frozen-lockfile
pnpm dev          # Browser workbench
pnpm dev:desktop  # Native Tauri window
```

On macOS, if the Keychain asks for your password after every rebuild, see
[macOS dev signing](docs/development/macos-dev-signing.md).

## Verification

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm build:desktop
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo test --release --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

Use `pnpm build:desktop --no-bundle` to compile the native executable without
running platform packaging. Use `CI=true pnpm build:desktop` on macOS when Finder
automation is unavailable. Desktop bundles are produced under
`apps/desktop/src-tauri/target/release/bundle`.

CI verifies the workbench on Linux, macOS, and Windows and uses
`pnpm build:desktop --no-bundle -- --locked` to build each runner's native
executable without generating installers.

See [Architecture](docs/architecture.md) for package responsibilities and the
desktop security boundary.

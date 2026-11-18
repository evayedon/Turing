# Turing Core v0.1

Turing Core is a cross-platform IDE foundation built with Tauri 2, Rust, React,
TypeScript, Vite, and Zustand. The initial Turing Nebula workbench includes
placeholders for Explorer, Git, Monaco, Terminal, and the AI panel.

## Development

Install Node.js 22.12 or later, pnpm 12.21.0, stable Rust, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

```sh
pnpm install --frozen-lockfile
pnpm dev          # Browser workbench
pnpm dev:desktop  # Native Tauri window
```

## Verification

```sh
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
pnpm build:desktop
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
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

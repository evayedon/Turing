# Architecture

| Path                     | Responsibility                                  |
| ------------------------ | ----------------------------------------------- |
| `apps/desktop/src/shell` | React workbench and panel placeholders          |
| `apps/desktop/src/state` | Zustand layout state and state transition tests |
| `apps/desktop/src-tauri` | Native window and bundled frontend assets       |
| `packages/contracts`     | Shared TypeScript types for the workbench       |
| `packages/design-system` | Turing Nebula color and typography tokens       |

The workbench runs in a browser for development and uses the same React entry
point inside Tauri. Panel visibility is in-memory state. The terminal, Git, file
exploration, Monaco, and AI surfaces contain static placeholder content.

## Desktop security

The native host registers no custom IPC commands or plugins. Its explicit
`shell-no-ipc` capability matches no windows or webviews and grants no
permissions. This entry prevents Tauri from automatically enabling capability
files added to the project, which it does when the capability list is empty.
Production uses embedded assets and a content security policy
that denies connections, embedded frames, and form submissions. The Vite
development server binds to loopback. The development policy allows Vite's
inline refresh code, injected styles, and loopback WebSocket.

Future native integrations should define narrow capabilities for each command,
validate inputs in Rust, and authorize file access against the selected
workspace. The current release stores no credentials and makes no AI requests.

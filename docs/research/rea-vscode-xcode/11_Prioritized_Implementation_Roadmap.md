# Prioritized implementation roadmap

Complexity estimates are relative: **S** localized feature or test harness work, **M** cross-layer feature with one integration, **L** lifecycle-heavy or multi-platform work, **XL** new subsystem with extensive security and operations work. Numbers define priority within the proposed milestone sequence, subject to baseline results.

| #   | Milestone and improvement                        | Dependency / complexity | Completion evidence                                                        |
| --- | ------------------------------------------------ | ----------------------- | -------------------------------------------------------------------------- |
| 1   | A · Native lifecycle smoke harness               | Current desktop / M     | Open/close two workbench and terminal windows on three OSes.               |
| 2   | A · Shared protocol fixtures                     | Typed Rust/TS IPC / S   | Contract drift fails tests, including errors and optional fields.          |
| 3   | A · Document URI/version contract                | Editor and grants / M   | Rename, reload and revoke races preserve draft and reject stale responses. |
| 4   | A · Diagnostic store                             | 3 / M                   | Revisions and producer lifecycle clear stale items deterministically.      |
| 5   | A · Managed LSP pilot                            | 2–4 / L                 | One allowlisted server initializes, syncs, cancels and shuts down.         |
| 6   | A · Problems navigation/markers                  | 4–5 / M                 | Keyboard opens correct ranges with Unicode and invalid paths covered.      |
| 7   | A · Startup and interaction baseline             | 1 / M                   | Comparable p50/p95, RSS and editor/terminal performance captures.          |
| 8   | B · Declarative command contributions            | 2 / M                   | One dispatch path and availability logic in palette, menu and shortcuts.   |
| 9   | B · Workspace watcher reconciliation             | 3 / L                   | Rename bursts and overflow converge without restoring stale grants.        |
| 10  | B · Draft recovery                               | 3, 9 / L                | Restore after simulated crash, surface mismatched disk versions.           |
| 11  | B · Editor groups and shared models              | 3 / L                   | Independent cursor/scroll, common undo and clean model disposal.           |
| 12  | B · Workspace symbols and indexes                | 5, 9 / L                | Freshness and cancellation survive workspace switches at scale.            |
| 13  | B · Safe workspace edits/rename symbol           | 3–6 / L                 | Multi-file preview and conflict reporting preserve drafts.                 |
| 14  | B · Performance budgets and degradation          | 7, 12 / M               | Large files and indexes avoid blocking typing under load.                  |
| 15  | B · Accessibility qualification                  | 1, 6, 11 / M            | VoiceOver, NVDA and Orca smoke scenarios pass.                             |
| 16  | C · Scoped execution trust                       | 1–3 / L                 | Authorized reading cannot auto-start project scripts.                      |
| 17  | C · Process supervision                          | 1, 16 / L               | Quotas, clean cancellation and named OS limitations.                       |
| 18  | C · Versioned project/target adapters            | 3, 16 / L               | Cargo plus a second toolchain supply build/test configurations.            |
| 19  | C · Task graph and problem matchers              | 6, 17–18 / L            | Dependency order, cancel and structured compiler locations.                |
| 20  | C · Run and artifact history                     | 19 / M                  | Navigate historical output, configuration and input revision.              |
| 21  | C · DAP pilot                                    | 16–18 / L               | Breakpoint, step, variable and stop workflows in one runtime.              |
| 22  | C · Test explorer                                | 18–20 / L               | Discover, rerun and navigate a failed project test.                        |
| 23  | C · Terminal profiles, search and shell metadata | 17 / M                  | Test marker spoofing, search, resize and profile approval.                 |
| 24  | D · Git status, diffs and review                 | 9, 11 / L               | Works with renamed, stale, dirty and conflicted entries.                   |
| 25  | D · Credentialed Git mutations                   | 16, 24 / L              | Explicit remote and credential scopes, safe cancellation.                  |
| 26  | D · Reproducible context and model broker        | 3, 9, 12 / XL           | Show sent context and support offline failure/cancellation.                |
| 27  | D · Supervised agent with receipts               | 13, 16, 20, 26 / XL     | Revocation, dry runs, rollback and independent approvals pass.             |
| 28  | E · Versioned extension host                     | 8, 16–17 / XL           | Plugin crash/revocation leaves editing usable; host budgets enforced.      |
| 29  | E · Remote workspace transport                   | 16–18, 28 / XL          | Reconnect and authority stay scoped across network failures.               |
| 30  | E · Generation, preview and deployment adapters  | 17–20, 27 / XL          | Reviewed project creation, isolated previews and signed opt-in release.    |

**Immediate milestone A: Managed Language Intelligence and Problems.** Start with an authorized project fixture and one server chosen for predictable offline distribution. Deliver initialize/sync/cancel/dispose, version-aware diagnostics, keyboard-accessible Problems navigation and revocation tests before expanding to completion, formatting and arbitrary installations. Measure readiness and teardown on macOS, Linux and Windows. Preserve the current single-file Run path and the existing native permission model.

Evidence behind priority: [source gaps](08_Turing_Current_Architecture_Audit.md), [protocol and model design](04_Editor_and_Language_Intelligence.md), [launch and build tradeoffs](05_Terminal_Debugging_and_Build_Systems.md). Estimates assume an existing toolchain and fixture repository. External packaging, OS access and adapter maintenance could raise complexity.

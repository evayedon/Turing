# REA Research Recovery Manifest

- Recovered: 2026-11-18
- Source commit: `745bbe6a` (`backup/turing-before-rea`), committed 2026-11-18 22:41 -0500 from the on-disk files
- Method: `git show 745bbe6:<path>`; each restored file's git blob hash verified identical to the commit
- Newest-version check: the last Codex session references (2026-11-18 21:58 -0500) predate the commit; no later version found
- Totals: 12 ORIGINAL RECOVERED, 0 PARTIAL, 0 RECONSTRUCTED, 0 UNRECOVERABLE

| #   | File                                         | Status             | Method     | Source                      | Bytes | SHA-256                                                            | Confidence |
| --- | -------------------------------------------- | ------------------ | ---------- | --------------------------- | ----: | ------------------------------------------------------------------ | ---------- |
| 1   | `01_REA_Environment_and_Methodology.md`      | ORIGINAL RECOVERED | git object | 745bbe6 (blob 5caecd8eb4d1) | 11519 | `47b0ff58cef13bd382b1ebea51b037d4cb3e351232610ae37ba86349711eb94f` | High       |
| 2   | `02_VSCode_Deep_Architecture_Analysis.md`    | ORIGINAL RECOVERED | git object | 745bbe6 (blob 0aaa1ea63774) |  8123 | `1e679a9e17ad3af8b5c1182a9fea2a7ece6e779ac6d821c1657b5872a5ff58bb` | High       |
| 3   | `03_Xcode_Deep_Architecture_Analysis.md`     | ORIGINAL RECOVERED | git object | 745bbe6 (blob c1cd86a217e4) |  9266 | `fe119e3acafaa0f7da497d533163698b60cadcbe9020e5c0580f90cbadf0b561` | High       |
| 4   | `04_Editor_and_Language_Intelligence.md`     | ORIGINAL RECOVERED | git object | 745bbe6 (blob f9d09300bdeb) |  5280 | `37b8e9f436f0f9448fa5aa101449c46f56b254e2c9a798cafcb6ebe530bbd957` | High       |
| 5   | `05_Terminal_Debugging_and_Build_Systems.md` | ORIGINAL RECOVERED | git object | 745bbe6 (blob e180723653e2) |  5968 | `cb0773fbc962b7ec891518d4f77863fc3787d0ea32cdd5b6550919bfb2a20e20` | High       |
| 6   | `06_UI_UX_and_Developer_Workflows.md`        | ORIGINAL RECOVERED | git object | 745bbe6 (blob c1df82aa6505) |  4783 | `71bd48463806294cc9fa6edb5bb7a42b3aa282a4d6e00c40e605b2b184986a68` | High       |
| 7   | `07_Performance_Security_and_Reliability.md` | ORIGINAL RECOVERED | git object | 745bbe6 (blob 902eb22d541b) |  3888 | `9e523d5f62efb3d8d50f3767c0dd16e3ebca831d258cf87ba68f02a5be0aae02` | High       |
| 8   | `08_Turing_Current_Architecture_Audit.md`    | ORIGINAL RECOVERED | git object | 745bbe6 (blob 3f58f7d6fcb0) |  6654 | `45fd8650a3bb0a88865786a0398b813699f474e7b795658ae8b7ee8e461b5fd2` | High       |
| 9   | `09_Complete_Feature_Comparison_Matrix.md`   | ORIGINAL RECOVERED | git object | 745bbe6 (blob a179f768d691) |  6306 | `fa8716bc330f7e5ad5e7d6c4cc149fdedbbcfe23a1a7c5b986f26b04a105432a` | High       |
| 10  | `10_Turing_Next_Generation_Architecture.md`  | ORIGINAL RECOVERED | git object | 745bbe6 (blob 77b9e7b0eceb) |  5808 | `473e32c05063b72a0f41ad793e6b72397a68fd81130213d03e01be258fadcc02` | High       |
| 11  | `11_Prioritized_Implementation_Roadmap.md`   | ORIGINAL RECOVERED | git object | 745bbe6 (blob 36a0202726cf) |  6491 | `d8144db64f1022a90e71b40d15ab792627cceccbcc8aebb5158749b54715c99c` | High       |
| 12  | `12_Innovative_Turing_Exclusive_Features.md` | ORIGINAL RECOVERED | git object | 745bbe6 (blob 424c3dc919f0) |  4004 | `e45eb0f43c7a4ad563f9201380589457a7093a3cbb1c93fd0cf0b5fe1358eec9` | High       |

## Validation

- All 12 files present, non-empty, end on complete sentences or table rows (no truncation).
- Doc 09 contains all 18 comparison dimensions; doc 11 contains the full 30-item roadmap (phases A–E).
- External references: developer.apple.com, github.com (microsoft/vscode), code.visualstudio.com, microsoft.github.io (LSP/DAP), lldb.llvm.org, clang.llvm.org. Not re-fetched during recovery.

## Known gaps

- Doc 08 has 5 relative links to source files that exist on `backup/turing-before-rea` but not on `main`: `src-tauri/src/execution.rs`, `src-tauri/src/execution/process.rs`, `src-tauri/src/windows.rs`, `src/shell/commands.ts`, `src/terminal/TerminalSessions.tsx`. Left unchanged to preserve the original.
- Doc 08 audits the code as of `745bbe6`; `main` (`a2c60e7`) has diverged and the audit may not match it.

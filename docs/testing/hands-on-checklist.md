# Turing Core hands-on acceptance

Run this checklist in the native Turing build on Windows, macOS, and Linux
using the same commit. Record the commit, OS version, and a pass, fail, or
blocked result for each section. For a failure or blocker, include the step
number, expected result, actual result, and any relevant output or screenshot.
Builds and lifecycle smoke tests provide separate evidence.

## Before you start

1. In a terminal, go to the Turing folder and run `pnpm install`, then
   `pnpm dev:desktop`. Wait for the Turing window.
2. Make a small test folder (for example `~/turing-check`) containing:
   - `main.cpp`:

     ```cpp
     #include "util.hpp"
     int main() { return helper(answer); }
     ```

   - `util.hpp`:

     ```cpp
     int answer = 42;
     int helper(int value) { return value; }
     ```

   - `notes.md` with a few lines of text.
3. For steps marked **(clangd)**, clangd must be installed. On this Mac it is
   (Xcode Command Line Tools).
4. Use a disposable folder and local Git repository. Create `run.py` with
   `print("turing acceptance")`. Initialize Git, set a repository-local test
   identity, and commit the fixture files before opening the project:

   ```text
   git init
   git config user.name "Turing Acceptance"
   git config user.email "turing-acceptance@example.invalid"
   git add main.cpp util.hpp notes.md run.py
   git commit -m "Add acceptance fixture"
   ```

   The Run check requires Python 3.7 or newer on PATH. The shortcuts below
   use macOS notation. On Windows and Linux, use Ctrl in place of Command.

## 1. Opening and the terminal

- [ ] 1.1 **File → Open Folder…** and choose the fixture folder. Explorer lists
      all four files.
- [ ] 1.2 Open the bottom panel (bottom-left panel icon). The Terminal tab
      shows a working shell prompt **without** clicking "Start terminal".
- [ ] 1.3 The tabs read **Terminal**, **Problems**, **Output**, each with a
      small icon, in normal (not upper) case.
- [ ] 1.4 Click **Split** (the two-column icon) three times. Four shells sit
      side by side; the list on the right shows them joined by ┌ ├ └ lines.
- [ ] 1.5 Drag a divider between two panes; only those two panes resize.
- [ ] 1.6 Click the trash icon on one pane in the list. It disappears and its
      neighbour takes the space.

## 2. Editor groups

- [ ] 2.1 Open `main.cpp`. Use **View → Editor Layout → Split Editor Right**
      (or the split icon on the editor tab bar). The same file shows in two groups.
- [ ] 2.2 Type in the left group. The right group updates immediately.
- [ ] 2.3 Scroll and move the cursor in the right group only. The left group
      keeps its own scroll position and cursor.
- [ ] 2.4 Press ⌘Z in either group. The edit is undone in both.
- [ ] 2.5 Close the file's tab in one group. It stays open in the other.

## 3. Saving, outside changes and recovery

- [ ] 3.1 Save `main.cpp` (⌘S). The unsaved marker disappears.
- [ ] 3.2 Edit `notes.md` in **another** app (TextEdit or the terminal) and
      save it there. Within a second or two Turing shows it as changed on
      disk, without losing anything you typed in Turing.
- [ ] 3.3 In Explorer, rename a file using another app or the terminal
      (`mv notes.md notes2.md`). Explorer updates by itself.
- [ ] 3.4 With Auto Save off, type a distinctive line in `main.cpp` and wait
      at least one second for the draft snapshot. Force-terminate the test
      Turing process using the OS process manager. Relaunch, reopen the
      folder through the picker, and restore the draft from **Recover
      unsaved drafts**. The buffer contains the new line and remains unsaved.
      Check that the file on disk still contains the last explicitly saved text.

## 4. Problems and navigation **(clangd)**

- [ ] 4.1 In the bottom panel, open **Problems** and choose **Enable
      clangd**. Approve the dialog.
- [ ] 4.2 In `main.cpp`, change `answer` to `answr`. A red squiggle appears and
      Problems lists the error.
- [ ] 4.3 Press **F8**. The cursor jumps to the problem. Press **Shift+F8** to
      go back. Fix the typo; the problem disappears.
- [ ] 4.4 Press **⌘T** (Go to Symbol in Workspace), type `helper`, press
      Enter. `util.hpp` opens at the function.

## 5. Rename symbol **(clangd)**

- [ ] 5.1 In `main.cpp`, put the cursor on `helper` and press **F2**. Type
      `assist`. A preview lists changes in both `main.cpp` and `util.hpp`.
- [ ] 5.2 Apply. Both files now say `assist`; `util.hpp` was saved, and
      `main.cpp` (if it was open) shows the change as unsaved.
- [ ] 5.3 Press ⌘Z in `main.cpp`. The rename is undone there in one step.

## 6. Commands, large files, keyboard

- [ ] 6.1 Open the command palette (**⇧⌘P**). Commands match the menus;
      greyed-out menu items are also unavailable in the palette.
- [ ] 6.2 Paste a very large amount of text (several MB) into a new file. The
      status bar says **Large file: some features off** and typing stays
      smooth.
- [ ] 6.3 Unplug the mouse mentally: using only Tab, arrow keys, Enter and
      Escape, open a file from Explorer, switch dock tabs, open and close the
      command palette. Focus is always visible and never gets stuck.

## 7. Running and version-controlling the project

- [ ] 7.1 Open `run.py`, then choose **Run File**. Output contains
      `turing acceptance` and reports exit code zero.
- [ ] 7.2 Change the printed text, save, and rerun. Output contains the new
      text. In the integrated terminal, `git status --short` lists `run.py` as
      modified.
- [ ] 7.3 Open Source Control and inspect the diff for `run.py`. Stage just
      that file and commit it. Verify with `git show --name-only HEAD` in
      the integrated terminal that the commit contains `run.py` alone.

## When you are done

Use the [draft recovery scenarios](draft-recovery-manual.md) to extend the
crash check on macOS. Use the
[screen-reader checklist](../accessibility/screen-reader-smoke.md) for
VoiceOver, NVDA, and Orca.

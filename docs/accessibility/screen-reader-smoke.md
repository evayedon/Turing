# Turing screen-reader smoke test

Run the checklist in the **desktop app** once per platform. Record the build,
OS, screen-reader version, and any differences in actual speech or focus.
Wording and announcement order may vary. Check the role, name, state,
location, and result that each step calls out. Use a keyboard throughout.
Leave a box unchecked if any step fails or a prerequisite is missing.

| Platform         | Setup and interaction                                                                                                                                                                                                                                                           | Primary shortcut modifier |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| macOS, VoiceOver | Start VoiceOver with Command+F5. Enable Keyboard Navigation in macOS Keyboard settings. Interact with the web area using VoiceOver+Shift+Down Arrow if prompted. Turn Quick Nav off when Turing needs plain arrows. Use Fn with function keys if the keyboard sends media keys. | Command                   |
| Windows, NVDA    | Start NVDA and focus Turing. If arrows or typing are intercepted, use NVDA+Space to switch to focus mode. Use browse mode to read the Output transcript.                                                                                                                        | Ctrl                      |
| Linux, Orca      | Start Orca in the desktop session and focus Turing. Use focus mode for menus, Monaco, and terminal input when browse navigation intercepts keys. Use browse navigation to read static Output text.                                                                              | Ctrl                      |

Use a disposable folder with a `src` subfolder and these small files. Install a
supported Python interpreter and a C++ compiler for Run and Problems. Managed
clangd can be disabled for this test so that Problems comes from the failed
build. Turn Auto Save off before testing draft recovery.

`src/hello.py`

```python
def greet():
    print("Turing accessibility smoke")

greet()
```

`src/broken.cpp`

```cpp
int first = missing_one;
int second = missing_two;
int main() { return 0; }
```

Initialize the folder as a local Git repository if testing the populated
Source Control view. Leave at least one fixture file untracked or modified.

## Checklist

| Scenario                               | VoiceOver | NVDA | Orca |
| -------------------------------------- | --------- | ---- | ---- |
| 1. Title bar and open folder           | [ ]       | [ ]  | [ ]  |
| 2. Explorer and rename field           | [ ]       | [ ]  | [ ]  |
| 3. Edit, save, and status bar          | [ ]       | [ ]  | [ ]  |
| 4. Split and navigate editor groups    | [ ]       | [ ]  | [ ]  |
| 5. Problems and F8                     | [ ]       | [ ]  | [ ]  |
| 6. Run a file and read Output          | [ ]       | [ ]  | [ ]  |
| 7. Use the terminal and split sessions | [ ]       | [ ]  | [ ]  |
| 8. Command palette and Settings        | [ ]       | [ ]  | [ ]  |
| 9. Go to Symbol                        | [ ]       | [ ]  | [ ]  |
| 10. Search and Source Control          | [ ]       | [ ]  | [ ]  |
| 11. Recover an unsaved draft           | [ ]       | [ ]  | [ ]  |

### 1. Title bar and open folder

1. Tab into **Turing menus**. Move across the menu names with Left/Right.
   Open **File** with Down and move between its items with Up/Down. Hear
   the focused menu and item names, including unavailable items when present.
2. Press Escape and verify focus returns to **File**. Reopen it and activate
   **Open Folder** with Enter.
3. Use the native picker to choose the fixture folder. Verify that the picker
   speaks its controls and selection. Back in Turing, use F6 or Shift+F6 to
   reach **Explorer**. Verify that the region and workspace folder are named.

### 2. Explorer and rename field

1. Tab to `src/`. Hear the folder name and collapsed state. Press Right to
   expand it. Hear the expanded state. Press Right again to enter the children.
2. Use Up/Down to reach `hello.py`, then Left to return to the parent. Return to
   `hello.py` and press F2. Hear **Rename entry** and the current filename.
   Press Escape and verify focus returns to the file row. Rename uses an inline
   field in this workbench.
3. Press Enter on `hello.py`. Hear **File editor** and confirm the selected tab
   is named `hello.py`. Read a source line using the screen reader's editor
   navigation.

### 3. Edit, save, and status bar

1. Add a comment in `hello.py`. Hear edited text while typing and **Unsaved**
   when the save state changes. Navigating back to the tab should include
   its unsaved state.
2. Press Primary+S and verify **Saved**. Use F6 to reach **Workbench status**.
   Read the filename, save state, line and column, and language. Tab to an
   available status control and use Shift+Tab to move back.

### 4. Split and navigate editor groups

1. Press Primary+Backslash to split the editor. Verify that **Editor group 1**
   and **Editor group 2** have separately named open-file tablists, and that the
   new group shows `hello.py`.
2. Press Ctrl+F6, then Ctrl+Shift+F6. Verify focus moves to the next editor
   group and back. Open another file in a group and use Left/Right and
   Home/End on the tabs. Hear each filename and selected state, and verify
   that the corresponding document becomes active.
3. Use plain F6 from the editor text to leave the editor. Verify focus moves to
   the next visible workbench region even when Tab inserts indentation.

### 5. Problems and F8

1. Open `src/broken.cpp` and press F5. Wait for the build to fail.
2. Navigate to the bottom dock, focus a dock tab and use Left/Right to
   select **Problems**. Hear **Problems**, its selected state, and the file and
   diagnostic text when reading the panel.
3. Press F8 twice and Shift+F8 once. Hear severity, position in the problem
   list, message, and filename with line and column. Verify the editor moves
   to the reported location and backward navigation returns to the prior
   diagnostic.

### 6. Run a file and read Output

1. Open the saved `hello.py` and press F5. Verify the dock selects **Output**.
2. Use F6 to reach Output and Tab to **Program output**. Read the Python run
   status and **Exit code 0**, then read the `stdout` text **Turing accessibility
   smoke**. Check that the transcript can receive focus and be read or scrolled
   using the keyboard.

### 7. Use the terminal and split sessions

1. Use **Terminal → Open Terminal**. Hear **Terminal input**. Type
   `echo Turing-terminal-smoke` and press Enter. Read the echoed output.
2. Press F6 to leave terminal input. Cycle back to the dock and Tab to
   **Launch profile**. Open with Down, move through the named profiles with
   arrows, then Escape. Verify focus returns to **Launch profile**.
3. Activate **Split terminal pane**. Use F6 to leave the new shell and Tab
   through the dock to the **Terminal sessions** tablist. Use Up/Down and
   Home/End. Hear distinct session names and selected state. Tab to the
   **Resize terminal panes** separator and adjust it with Left/Right for a
   side-by-side split. Verify both panes accept input.
4. Press F2 on a session tab, hear **Terminal name**, and press Escape to
   return to the session tab. Activate a named **Remove** button for the
   disposable split and verify focus returns to the remaining session.

### 8. Command palette and Settings

1. Focus **Open command palette** and press Enter, or press Primary+Shift+P.
   Hear **Command palette** and **Search commands**. Type `terminal` and use
   Up/Down. Hear the active option as it changes.
2. Tab to **Close**, Shift+Tab back to the input, and press Escape. Verify
   focus returns to the opener. Reopen the palette, search for **Show
   Terminal**, and run the selected command with Enter.
3. Activate **Settings** from the activity bar. Hear the dialog title and
   initial control. Tab and Shift+Tab through settings, checking names and
   checked or selected states. Press Escape and verify focus returns to
   **Settings**. Check that Tab can continue through the workbench.

### 9. Go to Symbol

1. Focus the editor and press Primary+T. Hear **Go to Symbol in Workspace**
   and **Search workspace symbols**. Wait for indexing, then type `greet`.
2. Use Up/Down to read the option. Hear the symbol name, kind, and file
   location. Press Escape and verify focus returns to the editor.
3. Reopen the picker, search again, and press Enter. Verify the editor
   moves to the `greet` declaration.

### 10. Search and Source Control

1. Activate **Search** on the activity bar. Use F6 to reach the Search region.
   Tab to **Search text**, type `greet`, and press Enter. Hear the result count.
   Tab to a match and hear its file, line, column, and snippet. Press Enter
   to open the match.
2. Activate **Source Control** on the activity bar and use F6 to reach it.
   Verify branch and change group names and the accessible names of the
   changed file and its actions. Tab to a changed file and press Enter to open
   it. If the folder is outside Git, verify that the panel explains why it has
   no changes to display.

### 11. Recover an unsaved draft

1. Open an untitled file, type `recovery smoke`, and wait at least two
   seconds for the snapshot. Simulate an interrupted session using the OS
   process manager to terminate this disposable Turing instance. Relaunch
   the same installation and profile.
2. Tab to **Recover unsaved drafts (1)**. Press Enter and hear that it
   expanded. Tab to the **Restore** button named for the untitled file and
   press Enter.
3. Verify the recovered tab is selected and announced as unsaved. Hear the
   recovery notice and verify the editor contains `recovery smoke`.
   Save As to a temporary file if needed to verify that the recovered text
   can be saved.

Record the focused control, exact keys, expected result, and actual speech for
any failure. Include the platform and build with the completed checklist.

# Draft recovery on macOS

Use the native Turing workbench and a disposable workspace with two small
UTF-8 files. Give each file distinctive saved text. Keep Auto Save off during
setup. Draft snapshots are scheduled every 400 ms, so wait at least one
second after an edit before forcing termination.

## Normal exit and multiple editor groups

1. Edit both files and create an unsaved untitled document. Split one of the
   file tabs and verify both groups show the same edit and unsaved indicator.
2. Close one of the two views. The other view should still show the edit.
3. Quit normally and cancel the discard prompt. The workbench and all
   unsaved text should remain open.
4. Quit again and confirm discard. Relaunch. The discarded documents should
   be absent from **Recover unsaved drafts**.

## Forced termination and workspace approval

1. Edit two files and an untitled document. Split a dirty file into two
   groups. Wait for snapshots.
2. In Activity Monitor, select the native Turing process and choose
   **Force Quit**. You can also use `kill -9 <PID>` with the native process ID
   from Activity Monitor.
3. Relaunch. **Recover unsaved drafts** should show three drafts, including
   just one for the split file. Try restoring a workspace file before opening
   its workspace, then after opening a different workspace. The entry should
   remain pending both times.
4. Approve the original workspace with the folder picker. Restore an
   unchanged-base file into the active editor group. The tab should show the
   unsaved indicator. Turn Auto Save on and wait. The saved file should
   continue to show its original bytes until explicitly saved.
5. Discard an entry and confirm. Force quit and relaunch again. The discarded
   entry should stay gone, and any restored but still unsaved entry should
   appear once.

## Disk changes after the crash

1. Edit two workspace files, wait for snapshots, then force quit. Change one
   file’s saved text in another editor and rename the other using Finder.
2. Relaunch and approve the workspace. Restore the changed file. Verify
   Compare shows the new disk text, saving against the old base is blocked,
   and Save As can preserve the draft in a separate file.
3. Restore the renamed file. Verify the editor opens an unsaved untitled copy
   with a notice that the original file is missing or unavailable. Repeat
   using a deleted file and expect the same result.

## Concurrent workbenches and damaged records

1. Open a second workbench window. Approve the same workspace from both
   windows, and make different edits to the same file. After waiting for
   snapshots, force quit the native process. Relaunch and verify both
   snapshots are offered in one workbench. Open another window and verify
   the claimed drafts are offered only in the first workbench.
2. With Turing stopped, locate its local profile journal
   `draft-recovery-default` inside the Tauri local app data directory.
   In a disposable profile, truncate one `.draft` file while leaving another
   intact. Create a file named `.pending-test` in the journal directory.
3. Relaunch. Verify the editor reports a skipped damaged draft, still offers
   the intact draft, and ignores the interrupted temporary write.

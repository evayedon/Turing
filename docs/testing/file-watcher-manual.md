# File watcher acceptance on macOS

Run this outside the sandbox so Turing can launch its WebView and macOS can
start FSEvents. Use two visible windows, Turing and Terminal. Run the app with
`pnpm dev:desktop` from the repository root. In a separate Terminal tab create
disposable workspaces:

```sh
WS="$(mktemp -d "${TMPDIR%/}/turing-watch.XXXXXX")"
OTHER="$(mktemp -d "${TMPDIR%/}/turing-watch-other.XXXXXX")"
mkdir -p "$WS/src/deep"
printf 'original clean\n' > "$WS/clean.txt"
printf 'original dirty\n' > "$WS/dirty.txt"
printf 'original atomic\n' > "$WS/atomic.txt"
printf 'original nested\n' > "$WS/src/deep/nested.txt"
printf 'replacement workspace\n' > "$OTHER/replacement.txt"
printf 'outside workspace\n' > "$OTHER/secret.txt"
printf 'First workspace: %s\nSecond workspace: %s\n' "$WS" "$OTHER"
```

In Turing choose **File → Open Folder**. In the native folder picker press
**⌘⇧G**, paste the first path printed above, press Return, and click **Open**.
Leave Auto Save off initially. For each operation, keep Turing visible and allow
up to five seconds for UI updates. Treat longer delays as a failure and record
which paths and panes were affected.

## Clean document and explicit reload

1. Click `clean.txt` in Explorer and leave its text unchanged.
2. In Terminal run `printf 'external clean\n' > "$WS/clean.txt"`.
3. Expect a disk-change notice with **Reload from disk**. The editor still
   shows `original clean`, and the same tab remains selected.
4. Click **Reload from disk**. Expect `external clean`, a cleared notice,
   and no discard confirmation.

## Dirty document and conflict choices

1. Open `dirty.txt`, replace the text with `my unsaved draft`, and leave it
   unsaved. Run `printf 'external dirty\n' > "$WS/dirty.txt"` in Terminal.
2. Expect the draft to remain visible and the conflict notice to explain the
   available actions. Click **Compare with disk** and check that Editor text
   shows `my unsaved draft` and Disk text shows `external dirty`.
3. Click **Keep mine**. The draft stays open, the comparison closes, and the
   conflict stays unresolved. Press **⌘S**. Expect Save to report a conflict.
   Run `cat "$WS/dirty.txt"` and verify it still says `external dirty`.
4. Click **Reload from disk**, then **Cancel** in the native prompt. Expect
   the draft to remain. Click **Save As a copy…** and save as `dirty-copy.txt`
   in the workspace. Check that the copy contains the draft and the original
   contains `external dirty`.
5. Reopen `dirty.txt`, edit it without saving, and run
   `printf 'external again\n' > "$WS/dirty.txt"`. Click **Reload from disk**
   and confirm **Discard changes**. Expect `external again` and a cleared
   notice.

## External rename, deletion, and creation

1. Open `clean.txt`, add `recreation draft` without saving, and run
   `mv "$WS/clean.txt" "$WS/renamed.txt"`. Expect Explorer to show
   `renamed.txt` and the original tab to show **Deleted on disk** with the
   draft intact. Opening the renamed entry should open its own document.
2. Select the original `clean.txt` tab and press **⌘S**. Choose **Cancel**.
   Run `test ! -e "$WS/clean.txt" && cat "$WS/renamed.txt"`. Expect
   `external clean` and the deleted tab to remain open with its draft.
3. Press **⌘S** again and choose **Recreate file**. Expect `clean.txt` to
   reappear in Explorer and lose its deleted status. Run
   `cat "$WS/clean.txt" "$WS/renamed.txt"` and verify the recreated file
   contains the draft and the renamed file contains the original disk text.
4. Run `rm "$WS/clean.txt"`. Expect the tab to show **Deleted on disk**
   again, even though it was clean. Run
   `printf 'created externally\n' > "$WS/created.txt"`. Expect Explorer
   to add the entry and allow it to be opened.
5. Select the deleted `clean.txt` tab, press **⌘S**, and leave the
   confirmation open. In Terminal run
   `printf 'external restored file\n' > "$WS/clean.txt"`. Return to Turing
   and confirm **Recreate file**. Expect a save conflict. Run
   `cat "$WS/clean.txt"` and verify it still says `external restored file`.
   The restored file should clear the deleted status and offer reload.

## Directory rename, burst, and atomic replacement

1. Expand `src` and `deep` in Explorer and open `nested.txt`. Run
   `mv "$WS/src" "$WS/moved"`. Expect the old branch to disappear and
   `moved` to appear. The old tab shows **Deleted on disk**. Expand
   `moved/deep` and open `nested.txt` to check the file is available there.
2. Open `atomic.txt`, then run the following in Terminal:

   ```sh
   for n in {1..30}; do
     printf 'burst %s\n' "$n" > "$WS/atomic.txt"
   done
   printf 'atomic replacement\n' > "$WS/.atomic-external.tmp"
   mv -f "$WS/.atomic-external.tmp" "$WS/atomic.txt"
   ```

   Expect one open tab for `atomic.txt`, a disk-change notice, and no
   persistent temporary entry in Explorer. Click **Reload from disk** and
   verify the text is `atomic replacement`. The automated tests check
   deduplication within a batch directly.

## Watcher while workspace search runs

1. Keep `atomic.txt` open. In Terminal create a search workload:

   ```sh
   mkdir -p "$WS/search-fixture"
   for n in {1..15000}; do
     printf '%08192d\n' "$n" > "$WS/search-fixture/$n.txt"
   done
   (sleep 2; printf 'search-time update\n' > "$WS/atomic.txt";
     printf 'search-time creation\n' > "$WS/during-search.txt") &
   ```

2. Immediately choose **Search** in Turing's activity bar, enter
   `no-match-watcher-acceptance` in **Search text**, and click **Search**.
   Expect the editor to signal a disk change and Search to finish or remain
   cancelable. Switch back to Explorer after Search ends and verify
   `during-search.txt` appears without a manual reload. Searches read the
   filesystem as they traverse it, so run a new search to inspect recent changes.
3. If Search completes before the edit on your machine, rerun the background
   command with a shorter delay and a new output filename. The frontend
   integration test holds Search open while delivering the watcher event.

## Shared editor groups

1. Open `atomic.txt`, reload any existing conflict, and click **Split Editor
   Right**. Type `shared draft` in one pane. Both views should show the draft.
2. Run `printf 'shared external\n' > "$WS/atomic.txt"`. Expect conflict
   notices in both panes and the same draft in both. Click **Compare with
   disk** in either pane and check that both display the same two snapshots.
3. Run `rm "$WS/atomic.txt"`. Both tabs should now say **Deleted on disk**.
   The shared draft remains in both panes.

## Workspace replacement and closure with changes pending

1. Use the following Terminal command to write into the first workspace
   during replacement. In Turing immediately open the second workspace with
   **File → Open Folder** and confirm discarding the first workspace's draft
   if prompted.

   ```sh
   (for n in {1..25}; do
     printf '%s\n' "$n" > "$WS/old-pending.txt"
     sleep 0.1
   done) &
   ```

2. Expect only the second workspace's entries and no old tabs in either
   editor group. Open `replacement.txt` and verify it remains unchanged.
   Run `printf 'second workspace creation\n' > "$OTHER/second-new.txt"`
   and verify the new workspace's watcher updates Explorer.
3. Run `(sleep 1; touch "$OTHER/close-pending.txt") &` in Terminal and
   immediately click **Close workspace** in Explorer. Wait five seconds.
   Expect an empty Explorer, no workspace tabs, and no delayed file or error
   from the closed workspace. Reopen the first workspace and check its
   current listing. The automated tests control exact reply timing across
   both closure and replacement.

## Symlink containment

1. With the first workspace open, open `renamed.txt` and run:

   ```sh
   rm "$WS/renamed.txt"
   ln -s "$OTHER/secret.txt" "$WS/renamed.txt"
   ln -s "$OTHER" "$WS/outside-link"
   printf 'changed outside\n' > "$OTHER/secret.txt"
   ```

2. Expect Explorer to omit both links. The already open tab may report a disk
   conflict, but must never display outside text. Try **Reload from disk**.
   Expect access to be denied and the tab text retained. Run
   `cat "$OTHER/secret.txt"` and verify it still says `changed outside`.

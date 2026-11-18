import type { useEditor } from "../editor/use-editor";
import { ActionMenu } from "./ActionMenu";

export function FileMenu({
  editor,
  native,
  folderBusy,
  openFolder,
}: {
  editor: ReturnType<typeof useEditor>;
  native: boolean;
  folderBusy: boolean;
  openFolder: () => void;
}) {
  const { active, busy, canSave } = editor;

  return (
    <ActionMenu
      label="File"
      actions={[
        { label: "Open File", run: editor.openFile, disabled: !native || busy },
        {
          label: "Open Folder",
          run: openFolder,
          disabled: !native || busy || folderBusy,
        },
        { label: "New File", run: editor.newFile, disabled: busy },
        { label: "Save", run: editor.save, disabled: !canSave || busy },
        {
          label: "Save As",
          run: editor.saveAs,
          disabled: !native || !active || busy,
        },
        {
          label: "Auto Save",
          run: editor.toggleAutoSave,
          disabled: !native,
          pressed: editor.autoSave,
        },
        {
          label: "Close File",
          run: () => {
            if (active) void editor.close(active);
          },
          disabled: !active || busy,
        },
      ]}
    >
      {!native && (
        <p>
          Open and save files in the desktop app. Untitled files stay in this
          preview.
        </p>
      )}
    </ActionMenu>
  );
}

import type { useEditor } from "../editor/use-editor";
import { ActionMenu } from "./ActionMenu";
import type { MenuAction } from "./ActionMenu";

export function fileActions(
  editor: ReturnType<typeof useEditor>,
  native: boolean,
  folderBusy: boolean,
  openFolder: () => void,
  modifier: string,
): MenuAction[] {
  const { active, busy, canSave } = editor;
  return [
    { label: "Open File", run: editor.openFile, disabled: !native || busy },
    {
      label: "Open Folder",
      run: openFolder,
      disabled: !native || busy || folderBusy,
    },
    { label: "New File", run: editor.newFile, disabled: busy },
    {
      label: "Save",
      run: editor.save,
      disabled: !canSave || busy,
      hint: `${modifier}+S`,
    },
    {
      label: "Save As",
      run: editor.saveAs,
      disabled: !native || !active || busy,
      hint: `${modifier}+Shift+S`,
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
  ];
}

export function FileMenu({
  actions,
  native,
}: {
  actions: MenuAction[];
  native: boolean;
}) {
  return (
    <ActionMenu label="File" actions={actions}>
      {!native && <p>Disk access is available in the desktop app.</p>}
    </ActionMenu>
  );
}

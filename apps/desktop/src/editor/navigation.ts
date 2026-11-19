import type { EditorTab } from "./use-editor";

export function workspaceNavigationPath(
  resource: { scheme: string; authority: string; path: string },
  workspaceId: string | undefined,
) {
  if (
    !workspaceId ||
    resource.scheme !== "turing-workspace" ||
    resource.authority !== workspaceId ||
    !resource.path.startsWith("/")
  )
    return;
  const parts = resource.path.slice(1).split("/");
  if (
    parts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        /[\\:]/.test(part) ||
        part.includes("\0"),
    )
  )
    return;
  return parts.join("/");
}

export type NavigationTarget = { tab: EditorTab } | { relativePath: string };

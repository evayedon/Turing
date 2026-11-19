import { expect, it } from "vitest";
import { workspaceNavigationPath } from "./navigation";

it("only maps normal workspace model paths in the current window's grant", () => {
  const resource = {
    scheme: "turing-workspace",
    authority: "current",
    path: "/src/main ü.ts",
  };
  expect(workspaceNavigationPath(resource, "current")).toBe("src/main ü.ts");
  expect(workspaceNavigationPath(resource, "foreign")).toBeUndefined();
  expect(
    workspaceNavigationPath({ ...resource, scheme: "file" }, "current"),
  ).toBeUndefined();
  expect(
    workspaceNavigationPath({ ...resource, scheme: "https" }, "current"),
  ).toBeUndefined();
  for (const path of [
    "/../outside",
    "//absolute",
    "/C:/file",
    "/x\\y",
    "/file\0",
  ]) {
    expect(
      workspaceNavigationPath({ ...resource, path }, "current"),
    ).toBeUndefined();
  }
});

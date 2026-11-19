// @vitest-environment jsdom

import { beforeEach, expect, it } from "vitest";
import { clearRecents, readRecents, rememberRecent } from "./recent";

beforeEach(clearRecents);

it("keeps at most twenty distinct recently approved hints and can clear them", () => {
  for (let i = 0; i < 23; i++) {
    rememberRecent({
      kind: "file",
      name: `file-${i}`,
      path: `/fixture/file-${i}`,
    });
  }
  rememberRecent({ kind: "file", name: "updated", path: "/fixture/file-20" });
  expect(readRecents()).toHaveLength(20);
  expect(readRecents()[0]).toEqual({
    kind: "file",
    name: "updated",
    path: "/fixture/file-20",
  });
  expect(
    readRecents().filter(({ path }) => path === "/fixture/file-20"),
  ).toHaveLength(1);
  clearRecents();
  expect(readRecents()).toEqual([]);
});

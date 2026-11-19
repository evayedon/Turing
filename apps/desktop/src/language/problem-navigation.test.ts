import { describe, expect, it } from "vitest";
import { adjacentProblem } from "./problem-navigation";
import type { Problem } from "./problems";

function problem(
  id: string,
  tabKey: string,
  line: number,
  character = 0,
): Problem {
  return {
    id,
    tabKey,
    filename: `${tabKey}.cpp`,
    severity: "error",
    source: "clangd",
    message: id,
    start: { line, character },
    end: { line, character },
  };
}

const tabs = ["a", "b"];
const problems = [
  problem("a-line-5", "a", 5),
  problem("b-line-1", "b", 1),
  problem("a-line-2", "a", 2),
];
const at = (tabKey: string, line: number, character = 0) => ({
  tabKey,
  line,
  character,
});

describe("adjacentProblem", () => {
  it("walks problems in tab order, then position, wrapping at both ends", () => {
    const next = (cursor: ReturnType<typeof at>) =>
      adjacentProblem(problems, tabs, cursor, 1)?.id;
    const previous = (cursor: ReturnType<typeof at>) =>
      adjacentProblem(problems, tabs, cursor, -1)?.id;

    expect(next(at("a", 3))).toBe("a-line-5");
    expect(next(at("a", 6))).toBe("b-line-1");
    expect(next(at("b", 2))).toBe("a-line-2");
    expect(previous(at("a", 3))).toBe("a-line-2");
    expect(previous(at("a", 1))).toBe("b-line-1");
    expect(previous(at("b", 0))).toBe("a-line-5");
  });

  it("shows an unvisited problem under the cursor before moving past it", () => {
    expect(adjacentProblem(problems, tabs, at("a", 5), 1)?.id).toBe("a-line-5");
    expect(adjacentProblem(problems, tabs, at("a", 2), -1)?.id).toBe(
      "a-line-2",
    );
    expect(adjacentProblem(problems, tabs, at("a", 5), 1, "a-line-5")?.id).toBe(
      "b-line-1",
    );
  });

  it("visits each of several problems at the same position in turn", () => {
    const stacked = [
      problem("first", "a", 4),
      problem("second", "a", 4),
      problem("after", "a", 6),
    ];
    const cursor = at("a", 4);
    expect(adjacentProblem(stacked, tabs, cursor, 1, "first")?.id).toBe(
      "second",
    );
    expect(adjacentProblem(stacked, tabs, cursor, 1, "second")?.id).toBe(
      "after",
    );
    expect(adjacentProblem(stacked, tabs, cursor, -1, "second")?.id).toBe(
      "first",
    );
    // A remembered problem the cursor has since left is ignored.
    expect(adjacentProblem(stacked, tabs, at("a", 5), 1, "first")?.id).toBe(
      "after",
    );
  });

  it("skips problems whose tab is no longer open", () => {
    const withClosed = [problem("closed", "gone", 0), ...problems];
    expect(adjacentProblem(withClosed, tabs, at("b", 2), 1)?.id).toBe(
      "a-line-2",
    );
    expect(adjacentProblem(withClosed, tabs, undefined, 1)?.id).toBe(
      "a-line-2",
    );
    expect(
      adjacentProblem([problem("closed", "gone", 0)], tabs, undefined, 1),
    ).toBeUndefined();
  });
});

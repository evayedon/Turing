import { describe, expect, it } from "vitest";
import {
  dividerShare,
  groupOf,
  removeTerminal,
  resizePair,
  splitGroup,
  terminalOrder,
} from "./terminal-groups";
import type { TerminalGroup } from "./terminal-groups";

const single = (id: number): TerminalGroup => ({
  members: [id],
  axis: "columns",
  sizes: [100],
});

describe("terminal groups", () => {
  it("splits beside the active terminal into equal panes and keeps the group's axis", () => {
    let groups = [single(1), single(2)];
    groups = splitGroup(groups, 1, 3, "rows");
    expect(groups[0]).toEqual({
      members: [1, 3],
      axis: "rows",
      sizes: [50, 50],
    });
    groups = splitGroup(groups, 1, 4, "columns");
    expect(groups[0].members).toEqual([1, 4, 3]);
    expect(groups[0].axis).toBe("rows");
    expect(groups[0].sizes.map(Math.round)).toEqual([33, 33, 33]);
    expect(terminalOrder(groups)).toEqual([1, 4, 3, 2]);
    expect(groupOf(groups, 4)).toBe(groups[0]);
  });

  it("gives a removed pane's space to its neighbour and drops empty groups", () => {
    const groups: TerminalGroup[] = [
      { members: [1, 2, 3], axis: "columns", sizes: [20, 30, 50] },
      single(4),
    ];
    expect(removeTerminal(groups, 2)[0]).toEqual({
      members: [1, 3],
      axis: "columns",
      sizes: [50, 50],
    });
    // The last pane's space goes to the pane before it.
    expect(removeTerminal(groups, 3)[0].sizes).toEqual([20, 80]);
    expect(removeTerminal(groups, 4)).toHaveLength(1);
    expect(removeTerminal([single(9)], 9)).toEqual([]);
  });

  it("resizes only the two panes beside a divider, within 20–80% of their span", () => {
    const group: TerminalGroup = {
      members: [1, 2, 3],
      axis: "columns",
      sizes: [40, 40, 20],
    };
    expect(dividerShare(group, 0)).toBe(50);
    expect(resizePair(group, 0, 75).sizes).toEqual([60, 20, 20]);
    expect(resizePair(group, 0, 95).sizes).toEqual([64, 16, 20]);
    expect(resizePair(group, 1, 5).sizes).toEqual([40, 12, 48]);
    expect(dividerShare(resizePair(group, 1, 5), 1)).toBe(20);
  });
});

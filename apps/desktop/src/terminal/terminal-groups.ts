/** Terminals shown together, side by side ("columns") or stacked ("rows"). */
export type TerminalGroup = {
  members: number[];
  axis: "columns" | "rows";
  /** Pane sizes in percent of the group, in member order; they sum to 100. */
  sizes: number[];
};

const equal = (count: number) =>
  Array.from({ length: count }, () => 100 / count);

export function terminalOrder(groups: readonly TerminalGroup[]) {
  return groups.flatMap(({ members }) => members);
}

export function groupOf(groups: readonly TerminalGroup[], id: number) {
  return groups.find(({ members }) => members.includes(id));
}

/**
 * Adds `id` to the group of `active`, right after it, with equal pane sizes.
 * A one-terminal group takes `axis`; a split group keeps its own.
 */
export function splitGroup(
  groups: readonly TerminalGroup[],
  active: number,
  id: number,
  axis: TerminalGroup["axis"],
): TerminalGroup[] {
  return groups.map((group) => {
    const at = group.members.indexOf(active);
    if (at < 0) return group;
    const members = [...group.members];
    members.splice(at + 1, 0, id);
    return {
      members,
      axis: group.members.length > 1 ? group.axis : axis,
      sizes: equal(members.length),
    };
  });
}

/** Removes `id`; its pane's space goes to the pane before it (or after). */
export function removeTerminal(
  groups: readonly TerminalGroup[],
  id: number,
): TerminalGroup[] {
  return groups.flatMap((group) => {
    const at = group.members.indexOf(id);
    if (at < 0) return [group];
    if (group.members.length === 1) return [];
    const sizes = [...group.sizes];
    const [freed] = sizes.splice(at, 1);
    sizes[at > 0 ? at - 1 : 0] += freed;
    return [
      {
        ...group,
        members: group.members.filter((member) => member !== id),
        sizes,
      },
    ];
  });
}

/** The left/top pane's share (percent) of the two panes beside divider `index`. */
export function dividerShare(group: TerminalGroup, index: number) {
  const first = group.sizes[index];
  return Math.round((first / (first + group.sizes[index + 1])) * 100);
}

/** Moves divider `index` so its left/top pane holds `share` percent of the pair. */
export function resizePair(
  group: TerminalGroup,
  index: number,
  share: number,
): TerminalGroup {
  const span = group.sizes[index] + group.sizes[index + 1];
  const first = (Math.min(80, Math.max(20, share)) / 100) * span;
  const sizes = [...group.sizes];
  sizes[index] = first;
  sizes[index + 1] = span - first;
  return { ...group, sizes };
}

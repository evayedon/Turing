import type { Problem } from "./problems";

export type ProblemCursor = { tabKey: string; line: number; character: number };

type Key = [tab: number, line: number, character: number];

function compare(left: Key, right: Key) {
  for (let index = 0; index < left.length; index++) {
    const difference = left[index] - right[index];
    if (difference) return difference;
  }
  return 0;
}

/** Problems in open tabs, in navigation order. */
export function orderProblems(
  problems: readonly Problem[],
  tabOrder: readonly string[],
): Problem[] {
  return problems
    .filter(({ tabKey }) => tabOrder.includes(tabKey))
    .map((problem) => ({
      problem,
      key: [
        tabOrder.indexOf(problem.tabKey),
        problem.start.line,
        problem.start.character,
      ] as Key,
    }))
    .sort((left, right) => compare(left.key, right.key))
    .map(({ problem }) => problem);
}

/**
 * The problem after (`1`) or before (`-1`) `cursor`, ordered by open-tab
 * order and then position, wrapping at either end.
 */
export function adjacentProblem(
  problems: readonly Problem[],
  tabOrder: readonly string[],
  cursor: ProblemCursor | undefined,
  direction: 1 | -1,
  /** The problem visited last, so problems sharing a position are not skipped. */
  last?: string,
): Problem | undefined {
  const key = (tabKey: string, line: number, character: number): Key => [
    tabOrder.indexOf(tabKey),
    line,
    character,
  ];
  const ordered = orderProblems(problems, tabOrder).map((problem) => ({
    problem,
    key: key(problem.tabKey, problem.start.line, problem.start.character),
  }));
  const here = cursor && key(cursor.tabKey, cursor.line, cursor.character);
  const candidates = direction === 1 ? ordered : [...ordered].reverse();
  const visited = candidates.findIndex(({ problem }) => problem.id === last);
  if (here && visited >= 0 && !compare(candidates[visited].key, here))
    return candidates[(visited + 1) % candidates.length].problem;
  const found = here
    ? // An unvisited problem at the cursor comes first, as in VS Code.
      candidates.find(({ key }) => compare(key, here) * direction >= 0)
    : undefined;
  return (found ?? candidates[0])?.problem;
}

/**
 * Editor groups are side-by-side views of open documents. A document (tab
 * key) can appear in several groups; each group lists its own tabs in order
 * and remembers which one it shows. Documents themselves live in
 * `use-editor.ts`; this module only decides which group shows what.
 *
 * Every function is pure and returns the same object when nothing changes.
 */

export type GroupId = string;

export interface EditorGroup {
  id: GroupId;
  /** Document keys open in this group, in tab order. */
  keys: readonly string[];
  /** The document the group shows. Always one of `keys` when set. */
  activeKey?: string;
}

export interface EditorGroups {
  /** Left-to-right order. Never empty. */
  groups: readonly EditorGroup[];
  activeGroup: GroupId;
  nextId: number;
}

export function createGroups(): EditorGroups {
  return { groups: [{ id: "1", keys: [] }], activeGroup: "1", nextId: 2 };
}

export function getActiveGroup(state: EditorGroups): EditorGroup {
  return (
    state.groups.find(({ id }) => id === state.activeGroup) ?? state.groups[0]
  );
}

/** The document shown by the active group. */
export function activeDocument(state: EditorGroups) {
  return getActiveGroup(state).activeKey;
}

/** How many groups list `key`, which is how many views share its model. */
export function viewCount(state: EditorGroups, key: string) {
  return state.groups.filter(({ keys }) => keys.includes(key)).length;
}

/** Every document listed by at least one group. */
export function openDocuments(state: EditorGroups): ReadonlySet<string> {
  return new Set(state.groups.flatMap(({ keys }) => keys));
}

/** Documents that would lose their last view if `groupId` closed. */
export function documentsOnlyIn(state: EditorGroups, groupId: GroupId) {
  const group = state.groups.find(({ id }) => id === groupId);
  if (!group) return [];
  return group.keys.filter((key) => viewCount(state, key) === 1);
}

function replaceGroup(
  state: EditorGroups,
  groupId: GroupId,
  next: EditorGroup,
): EditorGroups {
  return {
    ...state,
    groups: state.groups.map((group) => (group.id === groupId ? next : group)),
  };
}

/**
 * Shows `key` in a group (the active one by default), adding it to the end
 * of that group's tabs if needed, and makes the group active.
 */
export function openDocument(
  state: EditorGroups,
  key: string,
  groupId: GroupId = state.activeGroup,
): EditorGroups {
  const group = state.groups.find(({ id }) => id === groupId);
  if (!group) return state;
  if (group.activeKey === key && state.activeGroup === groupId) return state;
  const keys = group.keys.includes(key) ? group.keys : [...group.keys, key];
  return {
    ...replaceGroup(state, groupId, { ...group, keys, activeKey: key }),
    activeGroup: groupId,
  };
}

export function focusGroup(state: EditorGroups, groupId: GroupId) {
  if (state.activeGroup === groupId) return state;
  if (!state.groups.some(({ id }) => id === groupId)) return state;
  return { ...state, activeGroup: groupId };
}

/** Moves focus to the next (1) or previous (-1) group, wrapping around. */
export function focusAdjacentGroup(state: EditorGroups, direction: 1 | -1) {
  const { groups } = state;
  if (groups.length < 2) return state;
  const index = groups.findIndex(({ id }) => id === state.activeGroup);
  const next = groups[(index + direction + groups.length) % groups.length];
  return focusGroup(state, next.id);
}

/** Removes a group. The last group is never removed. */
export function closeGroup(
  state: EditorGroups,
  groupId: GroupId,
): EditorGroups {
  const index = state.groups.findIndex(({ id }) => id === groupId);
  if (index < 0 || state.groups.length < 2) return state;
  const groups = state.groups.filter(({ id }) => id !== groupId);
  const activeGroup =
    state.activeGroup === groupId
      ? groups[Math.max(0, index - 1)].id
      : state.activeGroup;
  return { ...state, groups, activeGroup };
}

/**
 * Removes `key` from one group. A group left empty closes unless it is the
 * last one. When the group showed `key`, its neighbouring tab takes over.
 */
export function closeDocumentInGroup(
  state: EditorGroups,
  key: string,
  groupId: GroupId,
): EditorGroups {
  const group = state.groups.find(({ id }) => id === groupId);
  if (!group?.keys.includes(key)) return state;
  const index = group.keys.indexOf(key);
  const keys = group.keys.filter((item) => item !== key);
  if (!keys.length && state.groups.length > 1)
    return closeGroup(state, groupId);
  const activeKey =
    group.activeKey === key
      ? keys[Math.min(index, keys.length - 1)]
      : group.activeKey;
  return replaceGroup(state, groupId, { ...group, keys, activeKey });
}

/** Removes documents from every group, for example after they close. */
export function removeDocuments(
  state: EditorGroups,
  keys: ReadonlySet<string>,
): EditorGroups {
  let next = state;
  for (const key of keys)
    for (const { id } of next.groups)
      next = closeDocumentInGroup(next, key, id);
  return next;
}

/**
 * Opens the shown document of a group (the active one by default) in a new
 * group to its right and focuses it. Both groups then view one document.
 */
export function splitGroup(
  state: EditorGroups,
  groupId: GroupId = state.activeGroup,
): EditorGroups {
  const index = state.groups.findIndex(({ id }) => id === groupId);
  const key = state.groups[index]?.activeKey;
  if (index < 0 || !key) return state;
  const group: EditorGroup = {
    id: String(state.nextId),
    keys: [key],
    activeKey: key,
  };
  return {
    groups: [
      ...state.groups.slice(0, index + 1),
      group,
      ...state.groups.slice(index + 1),
    ],
    activeGroup: group.id,
    nextId: state.nextId + 1,
  };
}

export function canMoveDocumentToNextGroup(
  state: EditorGroups,
  from: GroupId = state.activeGroup,
) {
  const index = state.groups.findIndex(({ id }) => id === from);
  const source = state.groups[index];
  return (
    !!source?.activeKey &&
    (index < state.groups.length - 1 || source.keys.length > 1)
  );
}

/**
 * Moves `key` from one group into the next group to the right, creating that
 * group when `from` is the rightmost. The source group closes if emptied.
 */
export function moveDocumentToNextGroup(
  state: EditorGroups,
  key: string,
  from: GroupId = state.activeGroup,
): EditorGroups {
  const index = state.groups.findIndex(({ id }) => id === from);
  const source = state.groups[index];
  if (!source?.keys.includes(key) || !canMoveDocumentToNextGroup(state, from))
    return state;
  let next = state;
  let target = state.groups[index + 1]?.id;
  if (!target) {
    target = String(state.nextId);
    next = {
      ...state,
      groups: [...state.groups, { id: target, keys: [] }],
      nextId: state.nextId + 1,
    };
  }
  next = closeDocumentInGroup(next, key, from);
  return openDocument(next, key, target);
}

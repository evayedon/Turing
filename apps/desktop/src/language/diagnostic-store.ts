import type { EditorTab } from "../editor/use-editor";
import type { Problem } from "./problems";

/** The document state a producer computed its diagnostics against. */
export type DocumentStamp = {
  key: string;
  uri: string;
  revision: number;
  editRevision: number;
};

export const stampOf = (tab: EditorTab): DocumentStamp => ({
  key: tab.key,
  uri: tab.uri,
  revision: tab.revision,
  editRevision: tab.editRevision ?? 0,
});

/**
 * One producer's complete diagnostics for one document. A later batch from
 * the same producer for the same document replaces an earlier one; a stopped
 * producer simply publishes no batches.
 */
export type DiagnosticBatch = {
  producer: Problem["source"];
  stamp: DocumentStamp;
  problems: Omit<Problem, "id" | "tabKey" | "filename" | "source">[];
};

const severityRank = { error: 0, warning: 1, info: 2 } as const;

function matches(stamp: DocumentStamp, tab: EditorTab) {
  return (
    !tab.changedOnDisk &&
    stamp.uri === tab.uri &&
    stamp.revision === tab.revision &&
    stamp.editRevision === (tab.editRevision ?? 0)
  );
}

/**
 * The problems that are current for `tabs`: only batches whose stamp still
 * matches their open document, in a deterministic order (open-tab order,
 * position, severity, producer) with IDs that do not depend on input order.
 */
export function currentProblems(
  batches: readonly DiagnosticBatch[],
  tabs: readonly EditorTab[],
): Problem[] {
  const latest = new Map<string, DiagnosticBatch>();
  for (const batch of batches)
    latest.set(`${batch.producer}\u0000${batch.stamp.key}`, batch);
  const order = new Map(tabs.map((tab, index) => [tab.key, index]));
  const items = [...latest.values()].flatMap((batch) => {
    const tab = tabs.find(({ key }) => key === batch.stamp.key);
    if (!tab || !matches(batch.stamp, tab)) return [];
    return batch.problems.map((item, index) => ({
      item,
      index,
      producer: batch.producer,
      tab,
    }));
  });
  items.sort(
    (left, right) =>
      order.get(left.tab.key)! - order.get(right.tab.key)! ||
      left.item.start.line - right.item.start.line ||
      left.item.start.character - right.item.start.character ||
      severityRank[left.item.severity] - severityRank[right.item.severity] ||
      left.producer.localeCompare(right.producer) ||
      left.index - right.index,
  );
  const seen = new Map<string, number>();
  return items.map(({ item, producer, tab }) => {
    const place = `${producer}:${tab.key}:${item.start.line}:${item.start.character}`;
    const occurrence = seen.get(place) ?? 0;
    seen.set(place, occurrence + 1);
    return {
      ...item,
      id: `${place}:${occurrence}`,
      tabKey: tab.key,
      filename: tab.title,
      source: producer,
    };
  });
}

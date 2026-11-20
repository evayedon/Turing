import type * as Monaco from "monaco-editor";
import type { TextModels } from "../editor/MonacoHost";
import { isLargeDocument } from "../editor/performance-budget";
import type { EditorTab } from "../editor/use-editor";
import { stampOf, type DiagnosticBatch } from "./diagnostic-store";

export const MONACO_MARKER_INTERVAL_MS = 100;
const markerLimit = 200;

// The bundled validators publish under their model language ID.
const workerOwners = new Set([
  "typescript",
  "javascript",
  "json",
  "css",
  "scss",
  "less",
  "html",
  "handlebars",
  "razor",
]);

type MarkerUpdate = {
  model: Monaco.editor.ITextModel;
  owner: string;
  version: number;
  stamp: ReturnType<typeof stampOf>;
};

// Monaco notifies by URI, even when only Turing's own owners changed.
// Its marker service retains object identity until its producer replaces it.
const observed = new WeakMap<Monaco.editor.IMarker, MarkerUpdate>();

export function watchMonacoMarkers(
  monaco: typeof Monaco,
  models: TextModels,
  tabs: () => readonly EditorTab[],
  publish: (batches: DiagnosticBatch[]) => void,
) {
  const pending = new Map<string, MarkerUpdate>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    timer = undefined;
    const open = new Map(tabs().map((tab) => [tab.key, tab]));
    const batches: DiagnosticBatch[] = [];
    for (const update of pending.values()) {
      const { model, owner, version, stamp } = update;
      const tab = open.get(stamp.key);
      if (
        !tab ||
        tab.changedOnDisk ||
        isLargeDocument(tab.draft) ||
        models.get(stamp.key) !== model ||
        model.getLanguageId() !== owner
      )
        continue;
      const current =
        stamp.uri === tab.uri &&
        stamp.revision === tab.revision &&
        stamp.editRevision === (tab.editRevision ?? 0) &&
        stamp.languageOverride === tab.languageOverride &&
        version === model.getVersionId() &&
        models.snapshot(tab.key)?.draft === tab.draft;
      const markers = monaco.editor.getModelMarkers({
        resource: model.uri,
        owner,
        take: markerLimit,
      });
      const problems: DiagnosticBatch["problems"] = [];
      for (const marker of markers) {
        if (marker.owner !== owner) continue;
        const origin = observed.get(marker) ?? update;
        observed.set(marker, origin);
        if (
          origin.model !== model ||
          origin.version !== version ||
          origin.stamp.uri !== stamp.uri ||
          origin.stamp.revision !== stamp.revision ||
          origin.stamp.editRevision !== stamp.editRevision ||
          origin.stamp.languageOverride !== stamp.languageOverride ||
          (marker.modelVersionId !== undefined &&
            marker.modelVersionId !== version)
        )
          continue;
        problems.push({
          message: marker.message.slice(0, 2000),
          severity:
            marker.severity === monaco.MarkerSeverity.Error
              ? "error"
              : marker.severity === monaco.MarkerSeverity.Warning
                ? "warning"
                : "info",
          start: {
            line: marker.startLineNumber - 1,
            character: marker.startColumn - 1,
          },
          end: {
            line: marker.endLineNumber - 1,
            character: marker.endColumn - 1,
          },
        });
      }
      if (current) batches.push({ producer: "monaco", stamp, problems });
    }
    pending.clear();
    if (batches.length) publish(batches);
  }

  const subscription = monaco.editor.onDidChangeMarkers((resources) => {
    const changed = new Set(resources.map((uri) => uri.toString()));
    for (const tab of tabs()) {
      if (tab.changedOnDisk || isLargeDocument(tab.draft)) continue;
      const model = models.get(tab.key);
      if (!model || !changed.has(model.uri.toString())) continue;
      const owner = model.getLanguageId();
      if (!workerOwners.has(owner)) continue;
      pending.set(tab.key, {
        model,
        owner,
        version: model.getVersionId(),
        stamp: stampOf(tab),
      });
    }
    if (pending.size && timer === undefined)
      timer = setTimeout(flush, MONACO_MARKER_INTERVAL_MS);
  });

  return () => {
    subscription.dispose();
    clearTimeout(timer);
  };
}

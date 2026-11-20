import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { LanguagePosition, WorkspaceFileEdit } from "@turing/contracts";
import type { EditorTab, useEditor } from "../editor/use-editor";
import { isRenamePreview } from "../editor/workspace-edit";
import type {
  WorkspaceEditResult,
  WorkspaceEditTarget,
} from "../editor/workspace-edit";
import { WorkbenchDialog } from "../shell/WorkbenchDialog";
import { serverFor, type LanguageController } from "./use-language";
import { record } from "./problems";

export type RenameOrigin = {
  workspaceId: string;
  tab: EditorTab;
  position: LanguagePosition;
  prepare: boolean;
};

type Apply = ReturnType<typeof useEditor>["applyWorkspaceEdit"];

const outcomeLabels = {
  draft: "Applied to editor draft",
  saved: "Saved to disk",
  excluded: "Excluded",
  conflict: "Skipped",
};

function Changes({ file }: { file: WorkspaceFileEdit }) {
  return (
    <ol className="rename-changes">
      {file.edits.map(({ start, position, before, after }) => (
        <li key={start}>
          <span>
            Line {position.line + 1}, column {position.character + 1}
          </span>
          <pre aria-label="Before">
            <del>{before || "∅"}</del>
          </pre>
          <pre aria-label="After">
            <ins>{after || "∅"}</ins>
          </pre>
        </li>
      ))}
    </ol>
  );
}

export function RenameSymbolDialog({
  origin,
  language,
  close,
  apply,
}: {
  origin: RenameOrigin;
  language: LanguageController;
  close: () => void;
  apply: (
    targets: Parameters<Apply>[1],
    included: Parameters<Apply>[2],
  ) => ReturnType<Apply>;
}) {
  const server = serverFor(origin.tab, origin.workspaceId) ?? "clangd";
  const [name, setName] = useState("");
  const [working, setWorking] = useState(origin.prepare);
  const [applying, setApplying] = useState(false);
  const [canRename, setCanRename] = useState(!origin.prepare);
  const [error, setError] = useState<string>();
  const [files, setFiles] = useState<WorkspaceEditTarget[]>();
  const [included, setIncluded] = useState(new Set<string>());
  const [results, setResults] = useState<WorkspaceEditResult[]>();
  const lifetime = useRef<AbortController>(null);
  const input = useRef<HTMLInputElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const prepare = useEffectEvent((signal: AbortSignal) =>
    language.request(origin.tab, "prepareRename", origin.position, signal),
  );

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    if (origin.prepare)
      void prepare(controller.signal).then((value) => {
        if (controller.signal.aborted) return;
        const placeholder = record(value)?.placeholder;
        if (typeof placeholder === "string") {
          setName(placeholder);
          setCanRename(true);
        } else {
          setError(`${server} could not prepare a rename at this position.`);
        }
        setWorking(false);
      });
    return () => controller.abort();
  }, [origin, server]);

  useEffect(() => {
    if (files) previewHeading.current?.focus();
    else if (canRename) {
      input.current?.focus();
      input.current?.select();
    }
  }, [files, canRename]);

  const validName =
    !!name &&
    !/[\s\p{Cc}]/u.test(name) &&
    new TextEncoder().encode(name).length <= 256;

  async function preview() {
    const signal = lifetime.current?.signal;
    if (!signal || working || !canRename || !validName) return;
    setWorking(true);
    setError(undefined);
    const { value, documents } = await language.rename(
      origin.tab,
      origin.position,
      name,
      signal,
    );
    if (signal.aborted) return;
    setWorking(false);
    if (!isRenamePreview(value) || !value.files.length) {
      setError(
        record(value)?.error === "INVALID_WORKSPACE_EDIT"
          ? `${server} returned edits that Turing could not validate.`
          : `${server} found no applicable changes. The editor or language session may have changed.`,
      );
      return;
    }
    setFiles(
      value.files.map((file) => {
        const tracked = documents.get(file.path);
        return {
          ...file,
          tab: tracked?.tab,
          stale: file.documentVersion !== (tracked?.version ?? null),
        };
      }),
    );
    setIncluded(new Set(value.files.map(({ path }) => path)));
  }

  async function applyPreview() {
    if (!files || applying || results || !included.size) return;
    setApplying(true);
    setError(undefined);
    const result = await apply(files, included);
    if (lifetime.current?.signal.aborted) return;
    setApplying(false);
    if (result) setResults(result);
    else setError("The editor is busy. Try Apply again when it finishes.");
  }

  const saved =
    results?.filter(({ outcome }) => outcome === "saved").length ?? 0;
  const drafts =
    results?.filter(({ outcome }) => outcome === "draft").length ?? 0;
  const excluded =
    results?.filter(({ outcome }) => outcome === "excluded").length ?? 0;
  const conflicts =
    results?.filter(({ outcome }) => outcome === "conflict").length ?? 0;
  const resultByPath = new Map(results?.map((result) => [result.path, result]));

  return (
    <WorkbenchDialog
      title="Rename Symbol"
      close={close}
      busy={applying}
      className="rename-dialog"
    >
      {!files && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void preview();
          }}
        >
          <label htmlFor="rename-symbol-name">New name</label>
          <input
            id="rename-symbol-name"
            ref={input}
            value={name}
            maxLength={256}
            data-initial-focus
            disabled={!canRename || working}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="submit"
            className="quiet-button"
            disabled={!canRename || !validName || working}
          >
            Preview
          </button>
        </form>
      )}
      {!files && (
        <p>
          {server === "clangd"
            ? "clangd searches open files and nearby C/C++ files."
            : `${server} searches the approved workspace.`}
        </p>
      )}
      {working && (
        <p role="status">
          {canRename ? "Finding changes…" : "Checking the symbol…"}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {files && (
        <>
          <h3 ref={previewHeading} tabIndex={-1}>
            Changes to {files.length} {files.length === 1 ? "file" : "files"}
          </h3>
          <p>
            Open files become unsaved drafts. Closed files are saved if their
            disk versions still match.
          </p>
          <div className="rename-files">
            {files.map((file) => {
              const result = resultByPath.get(file.path);
              return (
                <section key={file.path}>
                  <label>
                    <input
                      type="checkbox"
                      checked={included.has(file.path)}
                      disabled={applying || !!results}
                      onChange={(event) => {
                        const next = new Set(included);
                        if (event.target.checked) next.add(file.path);
                        else next.delete(file.path);
                        setIncluded(next);
                      }}
                    />
                    {file.path}
                  </label>
                  {result && (
                    <p>
                      {outcomeLabels[result.outcome]}
                      {result.reason && ` · ${result.reason}`}
                    </p>
                  )}
                  <Changes file={file} />
                </section>
              );
            })}
          </div>
          {results ? (
            <p role="status">
              {conflicts > 0
                ? saved + drafts > 0
                  ? "Partially applied. "
                  : "No changes applied. "
                : ""}
              {drafts} drafts, {saved} saved, {excluded} excluded, {conflicts}{" "}
              conflicts.
            </p>
          ) : (
            <button
              type="button"
              className="quiet-button"
              disabled={applying || !included.size}
              onClick={() => void applyPreview()}
            >
              {applying ? "Applying…" : "Apply"}
            </button>
          )}
        </>
      )}
    </WorkbenchDialog>
  );
}

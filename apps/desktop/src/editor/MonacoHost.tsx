import { useEffectEvent, useLayoutEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";
import { workspaceNavigationPath } from "./navigation";
import type { NavigationTarget } from "./navigation";
import { attachLanguage } from "../language/monaco-language";
import {
  languagePath,
  type LanguageController,
} from "../language/use-language";
import type { Problem } from "../language/problems";
import { documentLanguage } from "./languages";
import { monacoActions } from "../shell/commands";
import type { EditorCommands } from "../shell/commands";
import type { EditorInfo } from "./editor-info";
import type { EditorLocation, EditorTab } from "./use-editor";

const environment = {
  getWorker(_moduleId: string, language: string) {
    switch (language) {
      case "json":
        return new JsonWorker();
      case "css":
      case "scss":
      case "less":
        return new CssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new HtmlWorker();
      case "typescript":
      case "javascript":
        return new TypeScriptWorker();
      default:
        return new EditorWorker();
    }
  },
};
Object.assign(globalThis, { MonacoEnvironment: environment });

const theme = "turing-nebula";

interface OpenModel {
  model: monaco.editor.ITextModel;
  viewState: monaco.editor.ICodeEditorViewState | null;
}

export default function MonacoHost({
  active,
  reveal,
  tabs,
  readOnly,
  onChange,
  onInfo,
  onCommandsReady,
  workspaceId,
  onNavigate,
  language,
  problems,
}: {
  active: EditorTab;
  reveal?: EditorLocation & { key: string };
  tabs: EditorTab[];
  readOnly: boolean;
  onInfo: (info: EditorInfo) => void;
  onCommandsReady?: (commands: EditorCommands | undefined) => void;
  workspaceId?: string;
  onNavigate?: (target: NavigationTarget, location: EditorLocation) => void;
  language?: LanguageController;
  problems?: Problem[];
  onChange: (tab: EditorTab, value: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, OpenModel>());
  const syncing = useRef(false);
  const currentTabs = useEffectEvent(() => tabs);
  const languageRequest = useEffectEvent(
    (...args: Parameters<LanguageController["request"]>) =>
      language?.request(...args) ?? Promise.resolve(undefined),
  );
  const lastReveal = useRef<typeof reveal>(undefined);
  const change = useEffectEvent((value: string) => onChange(active, value));

  const report = useEffectEvent(
    (instance: monaco.editor.IStandaloneCodeEditor) => {
      const position = instance.getPosition();
      const model = instance.getModel();
      if (!position || !model) return;
      onInfo({
        key: active.key,
        language: documentLanguage(active).label,
        line: position.lineNumber,
        column: position.column,
        eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
      });
    },
  );

  const navigate = useEffectEvent(
    (resource: monaco.Uri, selection?: monaco.IRange | monaco.IPosition) => {
      const location =
        selection && "startLineNumber" in selection
          ? { line: selection.startLineNumber, column: selection.startColumn }
          : {
              line: selection?.lineNumber ?? 1,
              column: selection?.column ?? 1,
            };
      const relativePath = workspaceNavigationPath(resource, workspaceId);
      const workspaceTab =
        relativePath &&
        tabs.find(
          (tab) =>
            tab.source.kind === "workspace" &&
            tab.source.workspaceId === workspaceId &&
            tab.source.relativePath === relativePath,
        );
      if (workspaceTab && !resource.query) {
        onNavigate?.({ tab: workspaceTab }, location);
        return;
      }
      const known = tabs.find(
        (tab) =>
          models.current.get(tab.key)?.model.uri.toString() ===
          resource.toString(),
      );
      if (
        known &&
        (known.source.kind !== "workspace" ||
          known.source.workspaceId === workspaceId)
      ) {
        onNavigate?.({ tab: known }, location);
        return;
      }
      if (relativePath) onNavigate?.({ relativePath }, location);
    },
  );

  const reportCommands = useEffectEvent(
    (instance: monaco.editor.IStandaloneCodeEditor | undefined) => {
      if (!instance) {
        onCommandsReady?.(undefined);
        return;
      }
      const triggers = new Set([
        "undo",
        "redo",
        "selectAll",
        "selectLine",
        "cut",
        "copy",
        "paste",
      ]);
      const clipboard = {
        cut: document.queryCommandSupported?.("cut") ?? false,
        copy: document.queryCommandSupported?.("copy") ?? false,
        paste:
          typeof navigator.clipboard?.readText === "function" ||
          (document.queryCommandSupported?.("paste") ?? false),
      };
      onCommandsReady?.({
        supports: (id) => {
          const model = instance.getModel();
          if (
            id === "definition" &&
            (model?.getLanguageId() === "cpp" || model?.getLanguageId() === "c")
          ) {
            return (
              !!language?.capabilities?.definition &&
              !!languagePath(active, workspaceId)
            );
          }
          if (id === "undo") return !!model?.canUndo?.();
          if (id === "redo") return !!model?.canRedo?.();
          if (id === "cut" || id === "copy" || id === "paste")
            return clipboard[id];
          if (
            id === "symbol" ||
            id === "definition" ||
            id === "declaration" ||
            id === "implementation" ||
            id === "references"
          )
            return (
              instance.getAction(monacoActions[id])?.isSupported() ?? false
            );
          return triggers.has(id) || !!instance.getAction(monacoActions[id]);
        },
        run: (id) => {
          instance.focus();
          const action = instance.getAction(monacoActions[id]);
          if (action?.isSupported()) void action.run();
          else if (triggers.has(id))
            instance.trigger("workbench", monacoActions[id], null);
        },
        reveal: (lineNumber, column) => {
          const position = instance
            .getModel()
            ?.validatePosition({ lineNumber, column });
          if (!position) return;
          instance.setPosition(position);
          instance.revealPositionInCenter(position);
          instance.focus();
        },
      });
    },
  );

  useLayoutEffect(() => {
    if (!container.current) return;
    const colors = getComputedStyle(container.current);
    monaco.editor.defineTheme(theme, {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": colors.getPropertyValue("--nebula-canvas").trim(),
        "editor.foreground": colors.getPropertyValue("--nebula-text").trim(),
        "editorLineNumber.foreground": colors
          .getPropertyValue("--nebula-muted")
          .trim(),
        "editorCursor.foreground": colors
          .getPropertyValue("--nebula-accent")
          .trim(),
        "editor.lineHighlightBackground": colors
          .getPropertyValue("--nebula-panel")
          .trim(),
        "editorLineNumber.activeForeground": colors
          .getPropertyValue("--nebula-cyan")
          .trim(),
        "editor.selectionBackground": colors
          .getPropertyValue("--nebula-active")
          .trim(),
      },
    });
    const instance = monaco.editor.create(container.current, {
      model: null,
      theme,
      ariaLabel: "File editor",
      automaticLayout: true,
      fontSize: 13,
      lineHeight: 22,
      padding: { top: 10 },
      autoIndent: "full",
      lineNumbers: "on",
      folding: true,
      minimap: { enabled: false },
      links: false,
      dropIntoEditor: { enabled: false },
      fontFamily: colors.getPropertyValue("--nebula-mono").trim(),
    });
    editor.current = instance;
    reportCommands(instance);
    const opener = monaco.editor.registerEditorOpener?.({
      openCodeEditor(source, resource, selection) {
        if (source !== instance) return false;
        navigate(resource, selection);
        // The workbench handles allowed resources. Never fall through to a
        // browser opener for a provider-supplied URI.
        return true;
      },
    });
    lastReveal.current = undefined;
    const cache = models.current;
    const subscription = instance.onDidChangeModelContent(() => {
      if (!syncing.current)
        change(instance.getModel()?.getValue(undefined, true) ?? "");
    });
    const cursor = instance.onDidChangeCursorPosition(() => {
      if (!syncing.current) report(instance);
    });
    return () => {
      cursor.dispose();
      subscription.dispose();
      opener?.dispose();
      reportCommands(undefined);
      instance.dispose();
      editor.current = null;
      for (const { model } of cache.values()) model.dispose();
      cache.clear();
    };
  }, []);

  useLayoutEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    const cache = models.current;
    const activeKey = active.key;
    const language = documentLanguage(active);
    const mode = language.monaco ?? language.id;
    let next = cache.get(activeKey);
    if (!next) {
      let uri = monaco.Uri.from(
        active.source.kind === "workspace"
          ? {
              scheme: "turing-workspace",
              authority: active.source.workspaceId,
              path: `/${active.source.relativePath}`,
            }
          : { scheme: "turing-document", path: `/${activeKey}/${active.name}` },
      );
      if (monaco.editor.getModel?.(uri)) uri = uri.with({ query: activeKey });
      next = {
        model: monaco.editor.createModel(active.draft, mode, uri),
        viewState: null,
      };
      cache.set(activeKey, next);
    }

    if (next.model.getLanguageId() !== mode)
      monaco.editor.setModelLanguage(next.model, mode);

    syncing.current = true;
    try {
      if (instance.getModel() !== next.model) {
        const previous = [...cache.values()].find(
          ({ model }) => model === instance.getModel(),
        );
        if (previous) previous.viewState = instance.saveViewState();
        instance.setModel(next.model);
        if (next.viewState) instance.restoreViewState(next.viewState);
        if (document.activeElement?.getAttribute("role") !== "tab")
          instance.focus();
      }
      if (next.model.getValue(undefined, true) !== active.draft)
        next.model.setValue(active.draft);
      const openTabs = new Map(tabs.map((tab) => [tab.key, tab]));
      for (const [id, { model }] of cache) {
        const tab = openTabs.get(id);
        if (!tab) {
          model.dispose();
          cache.delete(id);
        } else if (id !== activeKey) {
          const language = documentLanguage(tab);
          const mode = language.monaco ?? language.id;
          if (model.getLanguageId() !== mode)
            monaco.editor.setModelLanguage(model, mode);
        }
      }
    } finally {
      syncing.current = false;
    }
    report(instance);
  }, [active, tabs]);

  useLayoutEffect(() => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (
      !instance ||
      !model ||
      !reveal ||
      reveal.key !== active.key ||
      reveal === lastReveal.current
    )
      return;
    lastReveal.current = reveal;
    const position = model.validatePosition({
      lineNumber: reveal.line,
      column: reveal.column,
    });
    instance.setPosition(position);
    instance.revealPositionInCenter(position);
    instance.focus();
  }, [active.key, reveal]);

  const capabilities = language?.capabilities;
  useLayoutEffect(() => {
    if (!workspaceId || !capabilities) {
      if (editor.current) reportCommands(editor.current);
      return;
    }
    const detach = attachLanguage(
      monaco,
      workspaceId,
      capabilities,
      (model) =>
        currentTabs().find(
          (tab) => models.current.get(tab.key)?.model === model,
        ),
      (...args) => languageRequest(...args),
      (model) => editor.current?.getModel() === model,
    );
    if (editor.current) reportCommands(editor.current);
    return detach;
  }, [workspaceId, capabilities]);

  useLayoutEffect(() => {
    if (!problems || !monaco.editor.setModelMarkers) return;
    for (const [key, { model }] of models.current)
      for (const owner of ["clangd", "compiler"] as const) {
        const markers = problems
          .filter((item) => item.tabKey === key && item.source === owner)
          .map(({ message, start, end, severity }) => ({
            message,
            source: owner,
            severity:
              severity === "error"
                ? monaco.MarkerSeverity.Error
                : severity === "warning"
                  ? monaco.MarkerSeverity.Warning
                  : monaco.MarkerSeverity.Info,
            startLineNumber: start.line + 1,
            startColumn: start.character + 1,
            endLineNumber: end.line + 1,
            endColumn: end.character + 1,
          }));
        monaco.editor.setModelMarkers(model, owner, markers);
      }
  }, [problems, active.key]);

  useLayoutEffect(
    () => editor.current?.updateOptions({ readOnly }),
    [readOnly],
  );

  return <div ref={container} className="monaco-host" />;
}

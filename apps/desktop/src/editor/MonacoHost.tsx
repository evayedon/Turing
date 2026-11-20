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
import type { GroupId } from "./editor-groups";
import type { ModelRegistry } from "./model-registry";
import type { EditorLocation, EditorReveal, EditorTab } from "./use-editor";

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

export type TextModels = ModelRegistry<monaco.editor.ITextModel>;

function modeOf(tab: EditorTab) {
  const language = documentLanguage(tab);
  return language.monaco ?? language.id;
}

/**
 * One editor group's Monaco view. Text models come from the shared
 * registry, so a document open in several groups has one model (common
 * content and undo stack). Cursor, selection and scroll stay per group.
 */
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
  models,
  group,
  primary = true,
  focused = true,
}: {
  active: EditorTab;
  reveal?: EditorReveal;
  tabs: EditorTab[];
  readOnly: boolean;
  onInfo: (info: EditorInfo) => void;
  onCommandsReady?: (commands: EditorCommands | undefined) => void;
  workspaceId?: string;
  onNavigate?: (target: NavigationTarget, location: EditorLocation) => void;
  language?: LanguageController;
  problems?: Problem[];
  onChange: (tab: EditorTab, value: string) => void;
  models: TextModels;
  group: GroupId;
  /** The one view that registers language providers for every model. */
  primary?: boolean;
  /** This view belongs to the active group and drives workbench commands. */
  focused?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // View state is per group: the same document keeps its own cursor and
  // scroll in each group.
  const viewStates = useRef(
    new Map<string, monaco.editor.ICodeEditorViewState | null>(),
  );
  const shownKey = useRef<string>(undefined);
  const currentTabs = useEffectEvent(() => tabs);
  const languageRequest = useEffectEvent(
    (...args: Parameters<LanguageController["request"]>) =>
      language?.request(...args) ?? Promise.resolve(undefined),
  );
  const lastReveal = useRef<typeof reveal>(undefined);
  const change = useEffectEvent((model: monaco.editor.ITextModel) => {
    // Every view of a shared model hears the edit; only one reports it.
    if (models.get(active.key) !== model) return;
    if (!models.claimChange(active.key, model.getVersionId())) return;
    onChange(active, model.getValue(undefined, true));
  });
  const isFocused = useEffectEvent(() => focused);

  const report = useEffectEvent(
    (instance: monaco.editor.IStandaloneCodeEditor) => {
      if (!focused) return;
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
        (tab) => models.get(tab.key)?.uri.toString() === resource.toString(),
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
        position: () => {
          const position = instance.getPosition();
          return position
            ? { line: position.lineNumber, column: position.column }
            : undefined;
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
    const detachView = models.attach(instance);
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
    shownKey.current = undefined;
    const states = viewStates.current;
    const subscription = instance.onDidChangeModelContent(() => {
      const model = instance.getModel();
      if (!models.syncing && model) change(model);
    });
    const cursor = instance.onDidChangeCursorPosition(() => {
      if (!models.syncing) report(instance);
    });
    return () => {
      cursor.dispose();
      subscription.dispose();
      opener?.dispose();
      if (isFocused()) reportCommands(undefined);
      detachView();
      // The registry owns the models; another group may still show them.
      instance.dispose();
      editor.current = null;
      states.clear();
    };
  }, [models]);

  useLayoutEffect(() => {
    const instance = editor.current;
    if (!instance) return;
    const activeKey = active.key;
    const acquire = (tab: EditorTab) =>
      models.acquire(tab.key, () => {
        let uri = monaco.Uri.from(
          tab.source.kind === "workspace"
            ? {
                scheme: "turing-workspace",
                authority: tab.source.workspaceId,
                path: `/${tab.source.relativePath}`,
              }
            : { scheme: "turing-document", path: `/${tab.key}/${tab.name}` },
        );
        if (monaco.editor.getModel?.(uri)) uri = uri.with({ query: tab.key });
        return monaco.editor.createModel(tab.draft, modeOf(tab), uri);
      });

    if (primary) tabs.forEach(acquire);
    const model = acquire(active);

    models.sync(() => {
      if (instance.getModel() !== model) {
        const previous = shownKey.current;
        if (previous !== undefined && instance.getModel())
          viewStates.current.set(previous, instance.saveViewState());
        instance.setModel(model);
        const state = viewStates.current.get(activeKey);
        if (state) instance.restoreViewState(state);
        if (
          isFocused() &&
          document.activeElement?.getAttribute("role") !== "tab"
        )
          instance.focus();
      }
      shownKey.current = activeKey;
      if (model.getValue(undefined, true) !== active.draft)
        model.setValue(active.draft);
      const open = new Set(tabs.map(({ key }) => key));
      for (const key of viewStates.current.keys())
        if (!open.has(key)) viewStates.current.delete(key);
      for (const tab of tabs) {
        const item = models.get(tab.key);
        const tabMode = modeOf(tab);
        if (item && item.getLanguageId() !== tabMode)
          monaco.editor.setModelLanguage(item, tabMode);
      }
    });
    report(instance);
  }, [active, tabs, models, primary]);

  useLayoutEffect(() => {
    const instance = editor.current;
    if (!focused || !instance) return;
    report(instance);
    // Follow a group switch with keyboard focus, unless focus already moved
    // into this group (its tabs or toolbar) on its own.
    const target = document.activeElement;
    const pane = container.current?.closest("[data-editor-group]");
    if (!(pane ?? container.current)?.contains(target)) instance.focus();
  }, [focused]);

  useLayoutEffect(() => {
    const instance = editor.current;
    const model = instance?.getModel();
    if (
      !instance ||
      !model ||
      !reveal ||
      reveal.key !== active.key ||
      reveal.group !== group ||
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
  }, [active.key, reveal, group]);

  const capabilities = language?.capabilities;
  useLayoutEffect(() => {
    if (!workspaceId || !capabilities || !primary) return;
    // Providers are global to Monaco, so only the primary view registers
    // them. They serve every model, whichever group shows it.
    return attachLanguage(
      monaco,
      workspaceId,
      capabilities,
      (model) => currentTabs().find((tab) => models.get(tab.key) === model),
      (...args) => languageRequest(...args),
      (model) => models.isShown(model),
    );
  }, [workspaceId, capabilities, primary, models]);

  useLayoutEffect(() => {
    if (focused && editor.current) reportCommands(editor.current);
  }, [focused, active.key, active.uri, workspaceId, capabilities]);

  useLayoutEffect(() => {
    if (!problems || !monaco.editor.setModelMarkers) return;
    for (const tab of currentTabs()) {
      const model = models.get(tab.key);
      if (!model) continue;
      for (const owner of ["clangd", "compiler"] as const) {
        const markers = problems
          .filter((item) => item.tabKey === tab.key && item.source === owner)
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
    }
  }, [problems, active.key, models]);

  useLayoutEffect(
    () => editor.current?.updateOptions({ readOnly }),
    [readOnly],
  );

  return <div ref={container} className="monaco-host" />;
}

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
  serverFor,
  type LanguageController,
} from "../language/use-language";
import { watchMonacoMarkers } from "../language/monaco-markers";
import type { DiagnosticBatch } from "../language/diagnostic-store";
import type { Problem } from "../language/problems";
import { applyTextChanges, isLargeDocument } from "./performance-budget";
import { documentLanguage } from "./languages";
import { editorCommands, monacoActions } from "../shell/commands";
import type { EditorCommands, MonacoCommand } from "../shell/commands";
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

const navigationPreconditions = new Map<MonacoCommand, string>([
  ["definition", "editorHasDefinitionProvider"],
  ["declaration", "editorHasDeclarationProvider && !isInEmbeddedEditor"],
  ["implementation", "editorHasImplementationProvider"],
  [
    "references",
    "editorHasReferenceProvider && !inReferenceSearchEditor && !isInEmbeddedEditor",
  ],
]);

const providerAction = (id: MonacoCommand) => `turing.provider.${id}`;

export type TextModels = ModelRegistry<monaco.editor.ITextModel>;

function modeOf(
  tab: EditorTab,
  managedTypescript: boolean,
  workspaceId?: string,
) {
  if (managedTypescript && serverFor(tab, workspaceId) === "typescript") {
    const id = /\.(js|jsx|mjs|cjs)$/i.test(tab.name)
      ? "turing-javascript"
      : "turing-typescript";
    if (
      !monaco.languages.getLanguages().some((language) => language.id === id)
    ) {
      monaco.languages.register({ id });
      const grammar =
        id === "turing-javascript"
          ? import("monaco-editor/languages/definitions/javascript/javascript.js")
          : import("monaco-editor/languages/definitions/typescript/typescript.js");
      void grammar.then(({ language, conf }) => {
        monaco.languages.setMonarchTokensProvider(id, language);
        monaco.languages.setLanguageConfiguration(id, conf);
      });
    }
    return id;
  }
  if (isLargeDocument(tab.draft)) return "plaintext";
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
  onMonacoDiagnostics,
  models,
  group,
  primary = true,
  focused = true,
  ariaLabel = "File editor",
  canAskSelection = false,
  onAskSelection,
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
  onMonacoDiagnostics?: (batches: DiagnosticBatch[]) => void;
  onChange: (tab: EditorTab, value: string) => void;
  models: TextModels;
  group: GroupId;
  /** The one view that registers language providers for every model. */
  primary?: boolean;
  /** This view belongs to the active group and drives workbench commands. */
  focused?: boolean;
  /** Accessible name of the editor text area, unique per editor group. */
  ariaLabel?: string;
  /** The active document can send a selection to Ask (saved workspace file). */
  canAskSelection?: boolean;
  onAskSelection?: () => void;
}) {
  const clangdCapabilities = language?.capabilities;
  const typescriptCapabilities = language?.servers?.typescript.capabilities;
  const pyrightCapabilities = language?.servers?.pyright.capabilities;
  const rustCapabilities = language?.servers?.["rust-analyzer"].capabilities;
  const managedTypescript = !!typescriptCapabilities;
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  // View state is per group: the same document keeps its own cursor and
  // scroll in each group.
  const viewStates = useRef(
    new Map<string, monaco.editor.ICodeEditorViewState | null>(),
  );
  const shownKey = useRef<string>(undefined);
  const currentTabs = useEffectEvent(() => tabs);
  const publishDiagnostics = useEffectEvent((batches: DiagnosticBatch[]) =>
    onMonacoDiagnostics?.(batches),
  );
  const collectDiagnostics = !!onMonacoDiagnostics;

  useLayoutEffect(() => {
    if (!primary || !collectDiagnostics) return;
    return watchMonacoMarkers(monaco, models, currentTabs, publishDiagnostics);
  }, [models, primary, collectDiagnostics]);
  const languageRequest = useEffectEvent(
    (...args: Parameters<LanguageController["request"]>) =>
      language?.request(...args) ?? Promise.resolve(undefined),
  );
  const lastReveal = useRef<typeof reveal>(undefined);
  const change = useEffectEvent(
    (
      key: string,
      model: monaco.editor.ITextModel,
      event: monaco.editor.IModelContentChangedEvent,
    ) => {
      if (models.syncing) return;
      const tab = tabs.find((item) => item.key === key);
      if (!tab || !models.claimChange(key, event.versionId)) return;
      const snapshot = models.snapshot(key);
      const value =
        snapshot && !event.isFlush && !event.isEolChange
          ? applyTextChanges(snapshot.text, snapshot.bom, event.changes)
          : model.getValue(undefined, true);
      models.remember(
        key,
        value,
        value,
        event.isFlush
          ? Number(value.charCodeAt(0) === 0xfeff)
          : (snapshot?.bom ?? 0),
      );
      onChange(tab, value);
    },
  );
  const isFocused = useEffectEvent(() => focused);
  const askSelection = useEffectEvent(() => onAskSelection?.());
  const askable = useRef<monaco.editor.IContextKey<boolean>>(undefined);

  const report = useEffectEvent(
    (instance: monaco.editor.IStandaloneCodeEditor) => {
      if (!focused) return;
      const position = instance.getPosition();
      const model = instance.getModel();
      if (!position || !model) return;
      const range = instance.getSelection?.();
      onInfo({
        key: active.key,
        language: documentLanguage(active).label,
        line: position.lineNumber,
        column: position.column,
        eol: model.getEOL() === "\r\n" ? "CRLF" : "LF",
        ...(range && !range.isEmpty()
          ? {
              selection: {
                startLine: range.startLineNumber,
                // A selection ending at column 1 does not include that line.
                endLine:
                  range.endColumn === 1 &&
                  range.endLineNumber > range.startLineNumber
                    ? range.endLineNumber - 1
                    : range.endLineNumber,
              },
            }
          : {}),
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
      const supports: EditorCommands["supports"] = (id) => {
        const model = instance.getModel();
        if (
          id === "definition" ||
          id === "references" ||
          id === "implementation" ||
          id === "declaration"
        ) {
          // A managed server's negotiated capability enables navigation;
          // otherwise fall back to Monaco's live providers below. C/C++ has
          // no Monaco provider, so it needs clangd.
          const managed = serverFor(active, workspaceId)
            ? language?.forTab?.(active)?.capabilities
            : undefined;
          if (managed?.[id]) return true;
          if (
            (model?.getLanguageId() === "cpp" ||
              model?.getLanguageId() === "c") &&
            !(
              language?.capabilities?.[id] &&
              languagePath(active, workspaceId, "clangd")
            )
          )
            return false;
        }
        if (id === "undo") return !!model?.canUndo?.();
        if (id === "redo") return !!model?.canRedo?.();
        if (id === "cut" || id === "copy" || id === "paste")
          return clipboard[id];
        const action = instance.getAction(monacoActions[id]);
        if (navigationPreconditions.has(id))
          return (
            (action ?? instance.getAction(providerAction(id)))?.isSupported() ??
            false
          );
        if (id === "symbol") return action?.isSupported() ?? false;
        return triggers.has(id) || !!action;
      };
      onCommandsReady?.({
        supports,
        run: (id) => {
          if (navigationPreconditions.has(id) && !supports(id)) return;
          instance.focus();
          const action = instance.getAction(monacoActions[id]);
          if (action?.isSupported()) void action.run();
          else if (triggers.has(id) || navigationPreconditions.has(id))
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
    const host = container.current;
    const colors = getComputedStyle(host);
    const overflow = document.createElement("div");
    overflow.className = "monaco-editor vs-dark monaco-overflow-host";
    (host.closest(".workbench") ?? host.parentElement)?.append(overflow);
    monaco.editor.defineTheme(theme, {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editorHoverWidget.background": colors
          .getPropertyValue("--nebula-panel")
          .trim(),
        "editorHoverWidget.foreground": colors
          .getPropertyValue("--nebula-text")
          .trim(),
        "editorHoverWidget.border": colors
          .getPropertyValue("--nebula-border")
          .trim(),
        "editorSuggestWidget.background": colors
          .getPropertyValue("--nebula-panel")
          .trim(),
        "editorSuggestWidget.foreground": colors
          .getPropertyValue("--nebula-text")
          .trim(),
        "editorSuggestWidget.border": colors
          .getPropertyValue("--nebula-border")
          .trim(),
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
    const instance = monaco.editor.create(host, {
      model: null,
      theme,
      ariaLabel: "File editor",
      automaticLayout: true,
      fixedOverflowWidgets: true,
      overflowWidgetsDomNode: overflow,
      hover: { above: false },
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
    // Monaco registers these as global commands in some releases. A local
    // action exposes the same provider precondition through isSupported().
    const navigationActions = Array.from(
      navigationPreconditions,
      ([id, precondition]) =>
        instance.addAction?.({
          id: providerAction(id),
          label: editorCommands[id].label,
          precondition,
          run(view) {
            view.trigger("workbench", monacoActions[id], null);
          },
        }),
    );
    askable.current = instance.createContextKey?.(
      "turingCanAskSelection",
      false,
    );
    const askAction = instance.addAction?.({
      id: "turing.askSelection",
      label: "Ask Turing AI About Selection",
      precondition: "editorHasSelection && turingCanAskSelection",
      contextMenuGroupId: "1_turing",
      run: () => askSelection(),
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
    const cursor = instance.onDidChangeCursorPosition(() => {
      if (!models.syncing) report(instance);
    });
    const selection = instance.onDidChangeCursorSelection?.(() => {
      if (!models.syncing) report(instance);
    });
    return () => {
      cursor.dispose();
      selection?.dispose();
      askAction?.dispose();
      opener?.dispose();
      if (isFocused()) reportCommands(undefined);
      detachView();
      // The registry owns the models; another group may still show them.
      navigationActions.forEach((action) => action?.dispose());
      instance.dispose();
      overflow.remove();
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
        const created = monaco.editor.createModel(
          tab.draft,
          modeOf(tab, managedTypescript, workspaceId),
          uri,
        );
        models.remember(
          tab.key,
          tab.draft,
          created.getValue(undefined, true),
          Number(tab.draft.charCodeAt(0) === 0xfeff),
        );
        return created;
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
      const snapshot = models.snapshot(activeKey);
      if (snapshot?.draft !== active.draft) {
        if (snapshot?.text === active.draft) {
          models.remember(activeKey, active.draft, active.draft, snapshot.bom);
        } else {
          model.setValue(active.draft);
          models.remember(
            activeKey,
            active.draft,
            model.getValue(undefined, true),
            Number(active.draft.charCodeAt(0) === 0xfeff),
          );
        }
      }
      const open = new Set(tabs.map(({ key }) => key));
      for (const key of viewStates.current.keys())
        if (!open.has(key)) viewStates.current.delete(key);
      for (const tab of tabs) {
        const item = models.get(tab.key);
        const tabMode = modeOf(tab, managedTypescript, workspaceId);
        if (item && item.getLanguageId() !== tabMode)
          monaco.editor.setModelLanguage(item, tabMode);
      }
    });
    report(instance);
  }, [active, tabs, models, primary, managedTypescript, workspaceId]);

  useLayoutEffect(() => {
    // The primary view observes all open models, including hidden tabs.
    const subscriptions = (
      primary ? tabs.map(({ key }) => key) : [active.key]
    ).map((key) => {
      const model = models.get(key);
      return model?.onDidChangeContent((event) => change(key, model, event));
    });
    return () =>
      subscriptions.forEach((subscription) => subscription?.dispose());
  }, [active.key, models, primary, tabs]);

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
    askable.current?.set(focused && canAskSelection);
  }, [focused, canAskSelection, models]);

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

  useLayoutEffect(() => {
    if (!workspaceId || !primary) return;
    const registrations = [
      ["clangd", clangdCapabilities],
      ["typescript", typescriptCapabilities],
      ["pyright", pyrightCapabilities],
      ["rust-analyzer", rustCapabilities],
    ] as const;
    const detach = registrations.flatMap(([kind, capabilities]) =>
      capabilities
        ? [
            attachLanguage(
              monaco,
              workspaceId,
              capabilities,
              (model) =>
                currentTabs().find((tab) => models.get(tab.key) === model),
              (...args) => languageRequest(...args),
              (model) => models.isShown(model),
              kind,
            ),
          ]
        : [],
    );
    return () => detach.forEach((dispose) => dispose());
  }, [
    workspaceId,
    clangdCapabilities,
    typescriptCapabilities,
    pyrightCapabilities,
    rustCapabilities,
    primary,
    models,
  ]);

  useLayoutEffect(() => {
    if (focused && editor.current) reportCommands(editor.current);
  }, [
    focused,
    active.key,
    active.uri,
    workspaceId,
    clangdCapabilities,
    typescriptCapabilities,
    pyrightCapabilities,
    rustCapabilities,
    active.languageOverride,
  ]);

  useLayoutEffect(() => {
    if (!problems || !monaco.editor.setModelMarkers) return;
    for (const tab of currentTabs()) {
      const model = models.get(tab.key);
      if (!model) continue;
      for (const owner of [
        "clangd",
        "typescript",
        "pyright",
        "rust-analyzer",
        "compiler",
      ] as const) {
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

  const large = isLargeDocument(active.draft);
  useLayoutEffect(() => {
    editor.current?.updateOptions({
      folding: !large,
      wordWrap: "off",
      wordBasedSuggestions: large ? "off" : "matchingDocuments",
      renderValidationDecorations: large ? "off" : "editable",
    });
  }, [large]);

  useLayoutEffect(
    () => editor.current?.updateOptions({ readOnly }),
    [readOnly],
  );

  useLayoutEffect(
    () => editor.current?.updateOptions({ ariaLabel }),
    [ariaLabel],
  );

  return <div ref={container} className="monaco-host" />;
}

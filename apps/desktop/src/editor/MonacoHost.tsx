import { useEffectEvent, useLayoutEffect, useRef } from "react";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import CssWorker from "monaco-editor/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/language/html/html.worker?worker";
import JsonWorker from "monaco-editor/language/json/json.worker?worker";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker?worker";
import type { EditorTab } from "./use-editor";

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

function languageFor(name: string) {
  const filename = name.toLowerCase();
  const languages = monaco.languages.getLanguages();
  const exact = languages.find((language) =>
    language.filenames?.some((item) => item.toLowerCase() === filename),
  );
  return (
    exact?.id ??
    languages.find((language) =>
      language.extensions?.some((extension) =>
        filename.endsWith(extension.toLowerCase()),
      ),
    )?.id ??
    "plaintext"
  );
}

interface OpenModel {
  name: string;
  model: monaco.editor.ITextModel;
  viewState: monaco.editor.ICodeEditorViewState | null;
}

export default function MonacoHost({
  active,
  tabs,
  readOnly,
  onChange,
}: {
  active: EditorTab;
  tabs: EditorTab[];
  readOnly: boolean;
  onChange: (tab: EditorTab, value: string) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const models = useRef(new Map<string, OpenModel>());
  const syncing = useRef(false);
  const change = useEffectEvent((value: string) => onChange(active, value));

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
      autoIndent: "full",
      lineNumbers: "on",
      folding: true,
      minimap: { enabled: false },
      links: false,
      dropIntoEditor: { enabled: false },
      fontFamily: colors.getPropertyValue("--nebula-mono").trim(),
    });
    editor.current = instance;
    const cache = models.current;
    const subscription = instance.onDidChangeModelContent(() => {
      if (!syncing.current)
        change(instance.getModel()?.getValue(undefined, true) ?? "");
    });
    return () => {
      subscription.dispose();
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
    let next = cache.get(activeKey);
    if (!next) {
      const uri = monaco.Uri.from({
        scheme: "turing-workspace",
        path: `/${activeKey}/${active.name}`,
      });
      next = {
        name: active.name,
        model: monaco.editor.createModel(active.draft, undefined, uri),
        viewState: null,
      };
      cache.set(activeKey, next);
    }

    if (next.name !== active.name) {
      monaco.editor.setModelLanguage(next.model, languageFor(active.name));
      next.name = active.name;
    }

    syncing.current = true;
    try {
      if (instance.getModel() !== next.model) {
        const previous = [...cache.values()].find(
          ({ model }) => model === instance.getModel(),
        );
        if (previous) previous.viewState = instance.saveViewState();
        instance.setModel(next.model);
        if (next.viewState) instance.restoreViewState(next.viewState);
        instance.focus();
      }
      if (next.model.getValue(undefined, true) !== active.draft)
        next.model.setValue(active.draft);
      const openKeys = new Set(tabs.map((tab) => tab.key));
      for (const [id, { model }] of cache) {
        if (openKeys.has(id)) continue;
        model.dispose();
        cache.delete(id);
      }
    } finally {
      syncing.current = false;
    }
  }, [active, tabs]);

  useLayoutEffect(
    () => editor.current?.updateOptions({ readOnly }),
    [readOnly],
  );

  return <div ref={container} className="monaco-host" />;
}

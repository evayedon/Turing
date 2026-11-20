import type * as Monaco from "monaco-editor";
import type { EditorTab } from "../editor/use-editor";
import type { LanguageFeature, LanguageServer } from "@turing/contracts";
import type { LanguageController } from "./use-language";
import { range, record } from "./problems";

export function attachLanguage(
  monaco: typeof Monaco,
  workspaceId: string,
  capabilities: NonNullable<LanguageController["capabilities"]>,
  find: (model: Monaco.editor.ITextModel) => EditorTab | undefined,
  request: LanguageController["request"],
  isActive: (model: Monaco.editor.ITextModel) => boolean,
  server: LanguageServer = "clangd",
) {
  async function ask(
    model: Monaco.editor.ITextModel,
    at: Monaco.Position,
    token: Monaco.CancellationToken,
    feature: LanguageFeature,
  ) {
    const tab = find(model);
    if (!tab || token.isCancellationRequested || !isActive(model)) return;
    const abort = new AbortController();
    const disposable = token.onCancellationRequested(() => abort.abort());
    const version = model.getVersionId();
    try {
      const value = await request(
        tab,
        feature,
        {
          line: at.lineNumber - 1,
          character: at.column - 1,
        },
        abort.signal,
      );
      if (
        !abort.signal.aborted &&
        !model.isDisposed() &&
        isActive(model) &&
        version === model.getVersionId() &&
        find(model) === tab
      )
        return value;
    } finally {
      disposable.dispose();
    }
  }
  const registrations: Monaco.IDisposable[] = [];
  const languages = {
    clangd: ["c", "cpp"],
    typescript: ["turing-typescript", "turing-javascript"],
    pyright: ["python"],
    "rust-analyzer": ["rust"],
  };
  for (const language of languages[server]) {
    if (capabilities.hover)
      registrations.push(
        monaco.languages.registerHoverProvider(language, {
          async provideHover(model, at, token) {
            const hover = record(await ask(model, at, token, "hover"));
            const contents = hover?.contents;
            const text =
              typeof contents === "string" ? contents : record(contents)?.value;
            if (typeof text !== "string") return;
            return {
              contents: [
                {
                  value: text
                    .slice(0, 8000)
                    .replace(/[\\`*_{}[\]()<>#+\-.!|]/g, "\\$&"),
                },
              ],
            };
          },
        }),
      );
    if (capabilities.completion)
      registrations.push(
        monaco.languages.registerCompletionItemProvider(language, {
          triggerCharacters: [".", ">", ":"],
          async provideCompletionItems(model, at, _context, token) {
            const value = await ask(model, at, token, "completion");
            const list = Array.isArray(value) ? value : record(value)?.items;
            if (!Array.isArray(list)) return;
            const word = model.getWordUntilPosition(at);
            const wordRange = new monaco.Range(
              at.lineNumber,
              word.startColumn,
              at.lineNumber,
              word.endColumn,
            );
            const suggestions = list
              .slice(0, 100)
              .flatMap((entry): Monaco.languages.CompletionItem[] => {
                const item = record(entry);
                if (
                  typeof item?.label !== "string" ||
                  item.insertTextFormat === 2
                )
                  return [];
                const insertText =
                  typeof item.insertText === "string"
                    ? item.insertText
                    : item.label.trim();
                return [
                  {
                    label: item.label.slice(0, 300),
                    insertText: insertText.slice(0, 1000),
                    kind: monaco.languages.CompletionItemKind.Text,
                    range: wordRange,
                    sortText:
                      typeof item.sortText === "string"
                        ? item.sortText.slice(0, 300)
                        : undefined,
                  },
                ];
              });
            return {
              suggestions,
              incomplete: record(value)?.isIncomplete === true,
            };
          },
        }),
      );
    function location(
      feature: "definition" | "references" | "implementation" | "declaration",
    ) {
      return async (
        model: Monaco.editor.ITextModel,
        at: Monaco.Position,
        token: Monaco.CancellationToken,
      ) => {
        const targets = await ask(model, at, token, feature);
        if (!Array.isArray(targets)) return [];
        return targets.flatMap((target) => {
          const entry = record(target);
          const selected = range(entry?.range);
          if (typeof entry?.path !== "string" || !selected) return [];
          return [
            {
              uri: monaco.Uri.from({
                scheme: "turing-workspace",
                authority: workspaceId,
                path: `/${entry.path}`,
              }),
              range: new monaco.Range(
                selected.start.line + 1,
                selected.start.character + 1,
                selected.end.line + 1,
                selected.end.character + 1,
              ),
            },
          ];
        });
      };
    }
    if (capabilities.definition)
      registrations.push(
        monaco.languages.registerDefinitionProvider(language, {
          provideDefinition: location("definition"),
        }),
      );
    if (capabilities.declaration)
      registrations.push(
        monaco.languages.registerDeclarationProvider(language, {
          provideDeclaration: location("declaration"),
        }),
      );
    if (capabilities.implementation)
      registrations.push(
        monaco.languages.registerImplementationProvider(language, {
          provideImplementation: location("implementation"),
        }),
      );
    if (capabilities.references)
      registrations.push(
        monaco.languages.registerReferenceProvider(language, {
          provideReferences: (model, at, _context, token) =>
            location("references")(model, at, token),
        }),
      );
  }
  return () => {
    for (const registration of registrations) registration.dispose();
  };
}

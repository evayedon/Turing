/**
 * Test double for `monaco-editor` with real model/view separation: models
 * hold text, version and an undo stack; editors hold a cursor and scroll
 * position and render a focusable textarea. Load it with
 * `vi.mock("monaco-editor", () => import("./fake-monaco"))`.
 */

type Position = { lineNumber: number; column: number };
type ViewState = { position: Position; scrollTop: number };

const editors: FakeEditor[] = [];
const models: FakeModel[] = [];

export class FakeUri {
  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
    readonly query = "",
  ) {}
  with({ query }: { query: string }) {
    return new FakeUri(this.scheme, this.authority, this.path, query);
  }
  toString() {
    const query = this.query ? `?${this.query}` : "";
    return `${this.scheme}://${this.authority}${this.path}${query}`;
  }
}

export class FakeModel {
  version = 1;
  disposed = false;
  private undoStack: string[] = [];
  private redoStack: string[] = [];

  constructor(
    public value: string,
    public language: string,
    readonly uri: FakeUri,
  ) {}

  getValue() {
    return this.value;
  }
  getVersionId() {
    return this.version;
  }
  getLanguageId() {
    return this.language;
  }
  getEOL() {
    return "\n";
  }
  getPositionAt(offset: number) {
    const lines = this.value.slice(0, offset).split("\n");
    return {
      lineNumber: lines.length,
      column: (lines.at(-1)?.length ?? 0) + 1,
    };
  }
  pushStackElement() {}
  pushEditOperations(
    _selection: null,
    operations: {
      range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      };
      text: string;
    }[],
  ) {
    const offset = (line: number, column: number) => {
      const lines = this.value.split("\n");
      return (
        lines
          .slice(0, line - 1)
          .reduce((sum, text) => sum + text.length + 1, 0) +
        column -
        1
      );
    };
    let text = this.value;
    for (const { range, text: replacement } of [...operations].reverse()) {
      const start = offset(range.startLineNumber, range.startColumn);
      const end = offset(range.endLineNumber, range.endColumn);
      text = text.slice(0, start) + replacement + text.slice(end);
    }
    this.type(text);
  }
  /** Programmatic replacement, which resets the undo stack like Monaco. */
  setValue(value: string) {
    this.value = value;
    this.undoStack = [];
    this.redoStack = [];
    this.changed();
  }
  /** A user edit made through any view of this model. */
  type(value: string) {
    this.undoStack.push(this.value);
    this.redoStack = [];
    this.value = value;
    this.changed();
  }
  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }
  undo() {
    const previous = this.undoStack.pop();
    if (previous === undefined) return;
    this.redoStack.push(this.value);
    this.value = previous;
    this.changed();
  }
  validatePosition(position: Position) {
    return position;
  }
  isDisposed() {
    return this.disposed;
  }
  dispose() {
    this.disposed = true;
    for (const editor of editors)
      if (editor.model === this) editor.model = null;
  }
  private changed() {
    this.version += 1;
    for (const editor of editors)
      if (editor.model === this) editor.notifyContent();
  }
}

type Listener = () => void;

function subscribe(listeners: Set<Listener>, listener: Listener) {
  listeners.add(listener);
  return { dispose: () => listeners.delete(listener) };
}

export class FakeEditor {
  model: FakeModel | null = null;
  position: Position = { lineNumber: 1, column: 1 };
  scrollTop = 0;
  disposed = false;
  readonly input: HTMLTextAreaElement;
  readonly options: Record<string, unknown> = {};
  private content = new Set<Listener>();
  private cursor = new Set<Listener>();

  constructor(readonly container: HTMLElement) {
    this.input = document.createElement("textarea");
    this.input.setAttribute("aria-label", "File editor");
    container.append(this.input);
  }

  getModel() {
    return this.model;
  }
  setModel(model: FakeModel | null) {
    this.model = model;
    this.position = { lineNumber: 1, column: 1 };
    this.scrollTop = 0;
    this.input.value = model?.value ?? "";
  }
  saveViewState(): ViewState {
    return { position: { ...this.position }, scrollTop: this.scrollTop };
  }
  restoreViewState(state: ViewState) {
    this.position = { ...state.position };
    this.scrollTop = state.scrollTop;
  }
  getPosition() {
    return this.position;
  }
  setPosition(position: Position) {
    this.position = { ...position };
    for (const listener of this.cursor) listener();
  }
  revealPositionInCenter(position: Position) {
    this.scrollTop = position.lineNumber * 10;
  }
  onDidChangeModelContent(listener: Listener) {
    return subscribe(this.content, listener);
  }
  onDidChangeCursorPosition(listener: Listener) {
    return subscribe(this.cursor, listener);
  }
  notifyContent() {
    this.input.value = this.model?.value ?? "";
    for (const listener of this.content) listener();
  }
  getAction() {
    return undefined;
  }
  trigger(_source: string, id: string) {
    if (id === "undo") this.model?.undo();
  }
  updateOptions(options: Record<string, unknown>) {
    Object.assign(this.options, options);
  }
  focus() {
    this.input.focus();
  }
  dispose() {
    this.disposed = true;
    this.input.remove();
    const index = editors.indexOf(this);
    if (index >= 0) editors.splice(index, 1);
  }
}

/** Every editor and model created since the last reset, in order. */
export const created = {
  editors: [] as FakeEditor[],
  models: [] as FakeModel[],
};

export function resetFakeMonaco() {
  editors.length = 0;
  models.length = 0;
  created.editors.length = 0;
  created.models.length = 0;
}

export const MarkerSeverity = { Error: 8, Warning: 4, Info: 2 };

export const Uri = {
  from: ({
    scheme,
    authority = "",
    path,
  }: {
    scheme: string;
    authority?: string;
    path: string;
  }) => new FakeUri(scheme, authority, path),
};

export const editor = {
  defineTheme() {},
  create(container: HTMLElement) {
    const instance = new FakeEditor(container);
    editors.push(instance);
    created.editors.push(instance);
    return instance;
  },
  createModel(value: string, language: string, uri: FakeUri) {
    const model = new FakeModel(value, language, uri);
    models.push(model);
    created.models.push(model);
    return model;
  },
  getModel(uri: FakeUri) {
    return (
      models.find(
        (model) => !model.disposed && model.uri.toString() === uri.toString(),
      ) ?? null
    );
  },
  setModelLanguage(model: FakeModel, language: string) {
    model.language = language;
  },
  setModelMarkers() {},
  registerEditorOpener() {
    return { dispose() {} };
  },
};

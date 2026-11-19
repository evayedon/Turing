import { FitAddon } from "@xterm/addon-fit";
import type { IBufferLine } from "@xterm/xterm";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

function lineText(line: IBufferLine, cols: number, lower = false) {
  let text = "";
  const columns: number[] = [];
  for (let column = 0; column < cols; column++) {
    const cell = line.getCell(column);
    if (!cell?.getWidth()) continue;
    const value = cell.getChars() || " ";
    const chars = lower ? value.toLowerCase() : value;
    for (let index = 0; index < chars.length; index++) columns.push(column);
    text += chars;
  }
  return { text, columns };
}

export function createTerminalView(
  host: HTMLDivElement,
  input: (data: Uint8Array) => void,
  openLink: (target: string) => void,
) {
  const style = getComputedStyle(host);
  const color = (name: string) => style.getPropertyValue(name).trim();
  const terminal = new Terminal({
    fontFamily: color("--nebula-mono"),
    fontSize: 13,
    cursorBlink: !matchMedia("(prefers-reduced-motion: reduce)").matches,
    scrollback: 2000,
    screenReaderMode: true,
    theme: {
      background: color("--nebula-rail"),
      foreground: color("--nebula-text"),
      cursor: color("--nebula-accent"),
      selectionBackground: color("--nebula-accent-border"),
      scrollbarSliderBackground: `${color("--nebula-muted")}33`,
      scrollbarSliderHoverBackground: `${color("--nebula-muted")}55`,
      scrollbarSliderActiveBackground: `${color("--nebula-accent")}66`,
    },
    linkHandler: {
      activate: (_event, target) => openLink(target),
      allowNonHttpProtocols: false,
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);
  terminal.textarea?.setAttribute("aria-label", "Terminal input");
  terminal.registerLinkProvider({
    provideLinks(row, callback) {
      const line = terminal.buffer.active.getLine(row - 1);
      if (!line) return callback(undefined);
      const { text, columns } = lineText(line, terminal.cols);
      const links = [...text.matchAll(/https?:\/\/[^\s<>"']+/gi)].map(
        (match) => {
          const target = match[0].replace(/[).,;!?]+$/, "");
          const start = columns[match.index];
          const end = columns[match.index + target.length - 1];
          return {
            text: target,
            range: {
              start: { x: start + 1, y: row },
              end: { x: end + 1, y: row },
            },
            activate: () => openLink(target),
          };
        },
      );
      callback(links);
    },
  });
  const encoder = new TextEncoder();
  terminal.onData((data) => input(encoder.encode(data)));
  terminal.onBinary((data) =>
    input(Uint8Array.from(data, (char) => char.charCodeAt(0))),
  );
  terminal.attachCustomKeyEventHandler((event) => {
    // With a selection, let the normal clipboard shortcut copy. Without a
    // selection, Ctrl+C must reach the PTY so it can interrupt the shell.
    return !(
      event.ctrlKey &&
      !event.altKey &&
      !event.metaKey &&
      event.key.toLowerCase() === "c" &&
      terminal.hasSelection()
    );
  });

  let search = { query: "", line: -1, column: -1 };
  return {
    async copy() {
      const selection = terminal.getSelection();
      if (selection) await navigator.clipboard.writeText(selection);
    },
    async paste() {
      const text = await navigator.clipboard.readText();
      if (!terminal.options.disableStdin) terminal.paste(text);
    },
    find(query: string, reverse = false) {
      if (!query) return false;
      const buffer = terminal.buffer.active;
      const needle = query.toLowerCase();
      const count = buffer.length;
      if (!count) return false;
      const step = reverse ? -1 : 1;
      const same =
        query === search.query && search.line >= 0 && search.line < count;
      let line = same ? search.line : reverse ? count - 1 : 0;
      for (let index = 0; index < count + Number(same); index++, line += step) {
        const row = (line + count) % count;
        const bufferLine = buffer.getLine(row);
        if (!bufferLine) continue;
        const { text, columns } = lineText(bufferLine, terminal.cols, true);
        const from =
          same && index === 0
            ? search.column + step
            : reverse
              ? text.length
              : 0;
        const at =
          from < 0
            ? -1
            : reverse
              ? text.lastIndexOf(needle, from)
              : text.indexOf(needle, from);
        if (at < 0) continue;
        const start = columns[at];
        const end = columns[at + needle.length] ?? terminal.cols;
        search = { query, line: row, column: at };
        terminal.select(start, row, Math.max(1, end - start));
        terminal.scrollToLine(row);
        return true;
      }
      return false;
    },

    size() {
      const proposed = fit.proposeDimensions();
      if (!proposed || !host.clientWidth || !host.clientHeight) return;
      const cols = Math.min(500, proposed.cols);
      const rows = Math.min(500, proposed.rows);
      terminal.resize(cols, rows);
      return { rows, cols };
    },
    write: (bytes: number[]) =>
      new Promise<void>((resolve) =>
        terminal.write(Uint8Array.from(bytes), resolve),
      ),
    focus: () => terminal.focus(),
    clear: () => terminal.clear(),
    disableInput: () => {
      terminal.options.disableStdin = true;
    },
    dispose: () => terminal.dispose(),
  };
}

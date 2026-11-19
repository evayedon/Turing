import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

export function createTerminalView(
  host: HTMLDivElement,
  input: (data: Uint8Array) => void,
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
    },
    // Output may name links but only a future explicit navigation policy
    // should allow a process to send the workbench to another origin.
    linkHandler: { activate: () => {} },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(host);
  terminal.textarea?.setAttribute("aria-label", "Terminal input");
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

  return {
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

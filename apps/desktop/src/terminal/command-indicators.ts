import type { IDecoration, Terminal } from "@xterm/xterm";

type Status = "pending" | "success" | "failure";

const labels: Record<Status, string> = {
  pending: "Command pending",
  success: "Command succeeded",
  failure: "Command failed",
};

export function trackCommandIndicators(terminal: Terminal) {
  let current:
    { decoration: IDecoration; running: boolean; status: Status } | undefined;

  function handle(data: string) {
    const [event, exitCode] = data.split(";", 2);
    if (event === "A") {
      const { type, baseY, cursorY } = terminal.buffer.active;
      if (type !== "normal") return true;
      if (current?.decoration.marker.line === baseY + cursorY) {
        current.running = false;
        return true;
      }
      current = undefined;
      const marker = terminal.registerMarker();
      if (!marker) return true;
      const decoration = terminal.registerDecoration({ marker, layer: "top" });
      if (!decoration) {
        marker.dispose();
        return true;
      }
      const command = {
        decoration,
        running: false,
        status: "pending" as Status,
      };
      current = command;
      terminal.element?.setAttribute("data-command-indicators", "");
      decoration.onRender((element) => {
        element.classList.add("terminal-command-indicator");
        element.setAttribute("role", "img");
        element.dataset.status = command.status;
        element.setAttribute("aria-label", labels[command.status]);
        element.title = labels[command.status];
      });
    } else if (event === "C" && current) {
      current.running = true;
    } else if (event === "D" && current) {
      if (
        !current.running ||
        exitCode === undefined ||
        !/^\d{1,10}$/.test(exitCode)
      ) {
        current.running = false;
        return true;
      }
      current.status = Number(exitCode) === 0 ? "success" : "failure";
      const element = current.decoration.element;
      if (element) {
        element.dataset.status = current.status;
        element.setAttribute("aria-label", labels[current.status]);
        element.title = labels[current.status];
      }
      current = undefined;
    }
    return true;
  }

  terminal.parser.registerOscHandler(133, handle);
  terminal.parser.registerOscHandler(633, handle);
}

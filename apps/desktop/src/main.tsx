import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@turing/design-system/nebula.css";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { TerminalSessions } from "./terminal/TerminalSessions";
import { Workbench } from "./shell/Workbench";
import "./shell/workbench.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

function isTerminalWindow() {
  if (!isTauri()) return false;
  try {
    return getCurrentWebviewWindow().label.startsWith("terminal-");
  } catch {
    return false;
  }
}

const terminalWindow = isTerminalWindow();

createRoot(root).render(
  <StrictMode>
    {terminalWindow ? (
      <main className="terminal-window">
        <TerminalSessions native activation={1} />
      </main>
    ) : (
      <Workbench />
    )}
  </StrictMode>,
);

import {
  ChevronDown,
  ChevronUp,
  CircleAlert,
  List,
  Terminal,
  X,
} from "lucide-react";
import { useState } from "react";

import type { ReactNode } from "react";
import { ExecutionOutput } from "../execution/ExecutionOutput";
import type { useExecution } from "../execution/use-execution";
import type { Ref } from "react";
import type { TerminalSessionControls } from "../terminal/TerminalSessions";
import { TerminalSessions } from "../terminal/TerminalSessions";
import { dockViews } from "../state/dock-views";
import type { DockView } from "../state/dock-views";

const icons = { Terminal, Problems: CircleAlert, Output: List };

export function BottomDock({
  execution,
  problems,
  languageOutput,
  active,
  select,
  close,
  maximized,
  toggleMaximized,
  visible,
  native,
  workspaceId,
  terminalActivation,
  terminalActions,
  onTerminalRunning,
}: {
  problems?: ReactNode;
  languageOutput?: ReactNode;
  execution: ReturnType<typeof useExecution>;
  active: DockView;
  select: (view: DockView) => void;
  close: () => void;
  maximized: boolean;
  toggleMaximized: () => void;
  visible: boolean;
  native: boolean;
  workspaceId?: string;
  terminalActivation: number;
  terminalActions?: Ref<TerminalSessionControls>;
  onTerminalRunning?: (running: boolean) => void;
}) {
  // Header slot where the active view (the terminal) renders its actions.
  const [actions, setActions] = useState<HTMLDivElement | null>(null);
  return (
    <section
      id="bottom-dock"
      className="panel bottom-dock"
      aria-label={active}
      data-focus-region=""
      tabIndex={-1}
      hidden={!visible}
    >
      <div className="dock-header">
        <div role="tablist" aria-label="Bottom dock" className="dock-tabs">
          {dockViews.map((name, index) => {
            const Icon = icons[name];
            return (
              <button
                key={name}
                type="button"
                id={`dock-tab-${name}`}
                role="tab"
                tabIndex={active === name ? 0 : -1}
                aria-selected={active === name}
                aria-controls={`dock-panel-${name}`}
                onClick={() => select(name)}
                onKeyDown={(event) => {
                  const next =
                    event.key === "ArrowRight"
                      ? (index + 1) % dockViews.length
                      : event.key === "ArrowLeft"
                        ? (index + dockViews.length - 1) % dockViews.length
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? dockViews.length - 1
                            : undefined;
                  if (next === undefined) return;
                  event.preventDefault();
                  const target = dockViews[next];
                  select(target);
                  event.currentTarget.ownerDocument
                    .getElementById(`dock-tab-${target}`)
                    ?.focus();
                }}
              >
                <Icon size={14} aria-hidden="true" />
                {name}
              </button>
            );
          })}
        </div>
        <div ref={setActions} className="dock-actions" />
        <button
          type="button"
          className="dock-action"
          aria-label={maximized ? "Restore panel size" : "Maximize panel"}
          title={maximized ? "Restore panel size" : "Maximize panel"}
          onClick={toggleMaximized}
        >
          {maximized ? (
            <ChevronDown size={15} aria-hidden="true" />
          ) : (
            <ChevronUp size={15} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="dock-action"
          aria-label="Hide bottom panel"
          title="Hide bottom panel"
          onClick={close}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      {dockViews.map((name) => (
        <div
          key={name}
          id={`dock-panel-${name}`}
          role="tabpanel"
          aria-labelledby={`dock-tab-${name}`}
          hidden={active !== name}
          tabIndex={0}
        >
          {name === "Terminal" ? (
            <TerminalSessions
              toolbar={active === "Terminal" ? actions : null}
              shown={visible && active === "Terminal"}
              native={native}
              workspaceId={workspaceId}
              activation={terminalActivation}
              actionsRef={terminalActions}
              onRunningChange={onTerminalRunning}
            />
          ) : name === "Output" ? (
            <>
              <ExecutionOutput execution={execution} native={native} />
              {languageOutput}
            </>
          ) : (
            problems
          )}
        </div>
      ))}
    </section>
  );
}

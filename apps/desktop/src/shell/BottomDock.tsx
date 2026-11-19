import { CircleAlert, List, Terminal, X } from "lucide-react";

import { ExecutionOutput } from "../execution/ExecutionOutput";
import type { useExecution } from "../execution/use-execution";
import type { Ref } from "react";
import type {
  TerminalSessionControls,
  TerminalSessionLayout,
} from "../terminal/TerminalSessions";
import { TerminalSessions } from "../terminal/TerminalSessions";
import { dockViews } from "../state/dock-views";
import type { DockView } from "../state/dock-views";

const details = {
  Terminal: {
    Icon: Terminal,
  },
  Problems: {
    Icon: CircleAlert,
    message: "Workspace diagnostics are unavailable in this build.",
  },
  Output: {
    Icon: List,
  },
};

export function BottomDock({
  execution,
  active,
  select,
  close,
  visible,
  native,
  workspaceId,
  terminalActivation,
  terminalActions,
  onTerminalRunning,
  onTerminalLayout,
}: {
  execution: ReturnType<typeof useExecution>;
  active: DockView;
  select: (view: DockView) => void;
  close: () => void;
  visible: boolean;
  native: boolean;
  workspaceId?: string;
  terminalActivation: number;
  terminalActions?: Ref<TerminalSessionControls>;
  onTerminalRunning?: (running: boolean) => void;
  onTerminalLayout?: (layout: TerminalSessionLayout) => void;
}) {
  return (
    <section
      id="bottom-dock"
      className="panel bottom-dock"
      aria-label={active}
      hidden={!visible}
    >
      <header className="dock-header">
        <div role="tablist" aria-label="Bottom dock" className="dock-tabs">
          {dockViews.map((name, index) => {
            const { Icon } = details[name];
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
        <button
          type="button"
          className="icon-button"
          aria-label="Hide bottom panel"
          title="Hide bottom panel"
          onClick={close}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </header>
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
              native={native}
              workspaceId={workspaceId}
              activation={terminalActivation}
              actionsRef={terminalActions}
              onRunningChange={onTerminalRunning}
              onLayout={onTerminalLayout}
            />
          ) : name === "Output" ? (
            <ExecutionOutput execution={execution} native={native} />
          ) : (
            <p className="panel-message">{details[name].message}</p>
          )}
        </div>
      ))}
    </section>
  );
}

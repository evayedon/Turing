import { CircleAlert, List, Terminal, X } from "lucide-react";

import { TerminalPanel } from "../terminal/TerminalPanel";
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
    message: "Task output is unavailable in this build.",
  },
};

export function BottomDock({
  active,
  select,
  close,
  visible,
  native,
  workspaceId,
  terminalActivation,
}: {
  active: DockView;
  select: (view: DockView) => void;
  close: () => void;
  visible: boolean;
  native: boolean;
  workspaceId?: string;
  terminalActivation: number;
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
            <TerminalPanel
              native={native}
              workspaceId={workspaceId}
              activation={terminalActivation}
            />
          ) : (
            <p className="panel-message">{details[name].message}</p>
          )}
        </div>
      ))}
    </section>
  );
}

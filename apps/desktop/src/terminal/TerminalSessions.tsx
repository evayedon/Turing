import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { Ref } from "react";
import { TerminalPanel } from "./TerminalPanel";
import type { TerminalActions } from "./TerminalPanel";

export type TerminalSessionControls = TerminalActions & {
  create: (split: boolean) => void;
};
export type TerminalSessionLayout = { count: number; split: boolean };

export function TerminalSessions({
  native,
  workspaceId,
  activation,
  actionsRef,
  onRunningChange,
  onLayout,
}: {
  native: boolean;
  workspaceId?: string;
  activation: number;
  actionsRef?: Ref<TerminalSessionControls>;
  onRunningChange?: (running: boolean) => void;
  onLayout?: (layout: TerminalSessionLayout) => void;
}) {
  const [slots, setSlots] = useState([1]);
  const [visible, setVisible] = useState([1]);
  const [active, setActive] = useState(1);
  const [running, setRunning] = useState<Record<number, boolean>>({});
  const [activations, setActivations] = useState<Record<number, number>>({});
  const [ratio, setRatio] = useState(50);
  const idSequence = useRef(1);
  const started = useRef(new Set<number>());
  const handled = useRef(0);
  const handles = useRef(new Map<number, TerminalActions>());
  const grid = useRef<HTMLDivElement>(null);
  const activeTab = useRef<HTMLButtonElement>(null);
  const restoreTabFocus = useRef(false);

  const activateSelected = useEffectEvent(() => requestActivation(active));

  useEffect(() => {
    if (!activation || handled.current === activation) return;
    handled.current = activation;
    activateSelected();
  }, [activation]);

  useEffect(
    () => onRunningChange?.(!!running[active]),
    [onRunningChange, running, active],
  );
  useEffect(
    () => onLayout?.({ count: slots.length, split: visible.length > 1 }),
    [onLayout, slots.length, visible.length],
  );

  useLayoutEffect(() => {
    if (restoreTabFocus.current) {
      restoreTabFocus.current = false;
      activeTab.current?.focus();
    }
  }, [active, slots]);

  function requestActivation(id: number) {
    setActivations((previous) => ({
      ...previous,
      [id]: (previous[id] ?? 0) + 1,
    }));
  }

  function select(id: number) {
    if (id === active) return;
    if (!visible.includes(id))
      setVisible(
        visible.length === 2
          ? visible.map((item) => (item === active ? id : item))
          : [id],
      );
    setActive(id);
  }

  function create(split: boolean) {
    if (!native || slots.length >= 4 || (split && visible.length > 1)) return;
    const reuseIdle =
      !split &&
      slots.length === 1 &&
      idSequence.current === 1 &&
      !started.current.has(1) &&
      !activations[1];
    if (reuseIdle) {
      requestActivation(1);
      return;
    }
    if (split && !running[active]) requestActivation(active);
    const id = ++idSequence.current;
    setSlots((previous) => [...previous, id]);
    setVisible(
      split
        ? [active, id]
        : visible.length === 2
          ? visible.map((item) => (item === active ? id : item))
          : [id],
    );
    setActive(id);
    requestActivation(id);
  }

  function remove(id: number) {
    const remaining = slots.filter((slot) => slot !== id);
    const next = remaining.length ? remaining : [++idSequence.current];
    const shown = visible.filter((slot) => slot !== id);
    setSlots(next);
    setVisible(shown.length ? shown : [next[0]]);
    if (active === id) setActive(shown[0] ?? next[0]);
    restoreTabFocus.current = true;
  }

  useImperativeHandle(actionsRef, () => ({
    create,
    close: () => handles.current.get(active)?.close(),
    clear: () => handles.current.get(active)?.clear(),
  }));

  function changeRatio(value: number) {
    setRatio(Math.min(80, Math.max(20, value)));
  }

  if (!native) return <TerminalPanel native={false} />;

  return (
    <div className="terminal-sessions">
      <div
        className="terminal-session-tabs"
        role="tablist"
        aria-label="Terminal sessions"
      >
        {slots.map((id) => (
          <div key={id} className="terminal-session-tab" role="presentation">
            <button
              type="button"
              role="tab"
              id={`terminal-tab-${id}`}
              ref={active === id ? activeTab : undefined}
              tabIndex={active === id ? 0 : -1}
              aria-selected={active === id}
              aria-controls={`terminal-session-${id}`}
              onClick={() => select(id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft")
                  return;
                event.preventDefault();
                const next =
                  slots[
                    (slots.indexOf(id) +
                      (event.key === "ArrowRight" ? 1 : slots.length - 1)) %
                      slots.length
                  ];
                select(next);
                event.currentTarget.ownerDocument
                  .getElementById(`terminal-tab-${next}`)
                  ?.focus();
              }}
            >
              Terminal {id}
            </button>
            {slots.length > 1 && (
              <button
                type="button"
                aria-label={`Remove Terminal ${id}`}
                onClick={() => remove(id)}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          disabled={slots.length >= 4}
          aria-label="New terminal session"
          title="New terminal session"
          onClick={() => create(false)}
        >
          +
        </button>
        <button
          type="button"
          disabled={slots.length >= 4 || visible.length > 1}
          aria-label="Split terminal pane"
          title="Split terminal pane"
          onClick={() => create(true)}
        >
          Split
        </button>
      </div>
      <div
        ref={grid}
        className="terminal-session-grid"
        style={
          visible.length > 1
            ? {
                gridTemplateColumns: `minmax(0, ${ratio}fr) 6px minmax(0, ${100 - ratio}fr)`,
              }
            : undefined
        }
      >
        {slots.map((id) => (
          <div
            key={id}
            id={`terminal-session-${id}`}
            role="tabpanel"
            aria-labelledby={`terminal-tab-${id}`}
            hidden={!visible.includes(id)}
            className="terminal-session-pane"
            style={{ gridColumn: visible.indexOf(id) === 1 ? 3 : 1 }}
            onFocusCapture={() => setActive(id)}
          >
            <TerminalPanel
              native={native}
              workspaceId={workspaceId}
              activation={activations[id]}
              focusOnStart={active === id}
              actionsRef={(handle) => {
                if (handle) handles.current.set(id, handle);
                else handles.current.delete(id);
              }}
              onRunningChange={(value) => {
                if (value) started.current.add(id);
                setRunning((previous) =>
                  previous[id] === value
                    ? previous
                    : { ...previous, [id]: value },
                );
              }}
            />
          </div>
        ))}
        {visible.length > 1 && (
          <div
            className="terminal-session-divider"
            role="separator"
            tabIndex={0}
            aria-label="Resize terminal panes"
            aria-orientation="vertical"
            aria-valuemin={20}
            aria-valuemax={80}
            aria-valuenow={ratio}
            onPointerDown={(event) => {
              if (event.button === 0)
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              const bounds = grid.current?.getBoundingClientRect();
              if (bounds?.width)
                changeRatio(
                  Math.round(
                    ((event.clientX - bounds.left) / bounds.width) * 100,
                  ),
                );
            }}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight")
                return;
              event.preventDefault();
              changeRatio(ratio + (event.key === "ArrowLeft" ? -5 : 5));
            }}
          />
        )}
      </div>
    </div>
  );
}

import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TerminalProfile } from "@turing/contracts";
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
  const groups = useRef(
    new Map<
      number,
      { pair: [number, number]; axis: "columns" | "rows"; ratio: number }
    >(),
  );
  const [direction, setDirection] = useState<"columns" | "rows">("columns");
  const [profile, setProfile] = useState<TerminalProfile>("system");
  const [profiles, setProfiles] = useState<Record<number, TerminalProfile>>({});
  const [labels, setLabels] = useState<Record<number, number>>({ 1: 1 });
  const [names, setNames] = useState<Record<number, string>>({});
  const [shells, setShells] = useState<Record<number, string>>({});
  const [rename, setRename] = useState<{ id: number; name: string }>();
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
  }, [active, slots, rename]);

  function requestActivation(id: number) {
    setActivations((previous) => ({
      ...previous,
      [id]: (previous[id] ?? 0) + 1,
    }));
  }

  function select(id: number) {
    if (id === active) return;
    if (!visible.includes(id)) {
      const group = groups.current.get(id);
      setVisible(group?.pair ?? [id]);
      if (group) {
        setDirection(group.axis);
        setRatio(group.ratio);
      }
    }
    setActive(id);
  }

  function label(id: number) {
    const number = labels[id];
    return (
      names[id] ||
      (shells[id]
        ? `${shells[id]}${number > 1 ? ` ${number}` : ""}`
        : `Terminal ${number}`)
    );
  }

  function startRename(id: number) {
    setRename({ id, name: label(id) });
  }

  function create(split: boolean, axis: "columns" | "rows" = "columns") {
    if (!native || slots.length >= 4 || (split && visible.length > 1)) return;
    const reuseIdle =
      !split &&
      slots.length === 1 &&
      idSequence.current === 1 &&
      !started.current.has(1) &&
      !activations[1];
    if (reuseIdle) {
      setProfiles((old) => ({ ...old, 1: profile }));
      requestActivation(1);
      return;
    }
    if (split && !running[active]) requestActivation(active);
    if (split) {
      setDirection(axis);
      setRatio(50);
    }
    const id = ++idSequence.current;
    const used = new Set(slots.map((slot) => labels[slot]));
    let number = 1;
    while (used.has(number)) number++;
    setLabels((old) => ({ ...old, [id]: number }));
    setProfiles((old) => ({ ...old, [id]: profile }));
    setSlots((previous) => [...previous, id]);
    if (split) {
      const group = { pair: [active, id] as [number, number], axis, ratio: 50 };
      groups.current.set(active, group);
      groups.current.set(id, group);
      setVisible(group.pair);
    } else {
      setVisible([id]);
    }
    setActive(id);
    requestActivation(id);
  }

  function remove(id: number) {
    const group = groups.current.get(id);
    if (group) for (const member of group.pair) groups.current.delete(member);
    const remaining = slots.filter((slot) => slot !== id);
    const next = remaining.length ? remaining : [++idSequence.current];
    const shown = visible.filter((slot) => slot !== id);
    setSlots(next);
    started.current.delete(id);
    setNames((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([key]) => Number(key) !== id),
      ),
    );
    setShells((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([key]) => Number(key) !== id),
      ),
    );
    setProfiles((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([key]) => Number(key) !== id),
      ),
    );
    setRunning((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([key]) => Number(key) !== id),
      ),
    );
    setActivations((old) =>
      Object.fromEntries(
        Object.entries(old).filter(([key]) => Number(key) !== id),
      ),
    );
    setLabels((old) =>
      remaining.length
        ? Object.fromEntries(
            Object.entries(old).filter(([key]) => Number(key) !== id),
          )
        : { [next[0]]: 1 },
    );
    if (rename?.id === id) setRename(undefined);
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
    const ratio = Math.min(80, Math.max(20, value));
    setRatio(ratio);
    const group = groups.current.get(active);
    if (group) group.ratio = ratio;
  }

  const windows = /Windows/i.test(navigator.userAgent);
  const profilesAvailable: { id: TerminalProfile; label: string }[] = windows
    ? [
        { id: "powershell", label: "PowerShell" },
        { id: "cmd", label: "Command Prompt" },
      ]
    : [
        { id: "bash", label: "Bash" },
        { id: "zsh", label: "Zsh" },
        { id: "sh", label: "POSIX sh" },
      ];
  const split = visible.length > 1;
  const tracks = `minmax(0, ${ratio}fr) 6px minmax(0, ${100 - ratio}fr)`;

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
              onDoubleClick={() => startRename(id)}
              onKeyDown={(event) => {
                if (event.key === "F2") {
                  event.preventDefault();
                  startRename(id);
                  return;
                }
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
              {label(id)}
            </button>
            {slots.length > 1 && (
              <button
                type="button"
                aria-label={`Remove ${label(id)}`}
                onClick={() => remove(id)}
              >
                ×
              </button>
            )}
          </div>
        ))}
        {rename && (
          <form
            className="terminal-rename"
            onSubmit={(event) => {
              event.preventDefault();
              const name = rename.name.trim();
              setNames((old) => ({ ...old, [rename.id]: name }));
              restoreTabFocus.current = true;
              setRename(undefined);
            }}
          >
            <input
              aria-label="Terminal name"
              autoFocus
              maxLength={40}
              value={rename.name}
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) =>
                setRename({ ...rename, name: event.target.value })
              }
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  restoreTabFocus.current = true;
                  setRename(undefined);
                }
              }}
            />
          </form>
        )}
        <select
          aria-label="Shell profile for new terminals"
          value={profile}
          onChange={(event) => {
            const selected = profilesAvailable.find(
              (item) => item.id === event.target.value,
            );
            const next = selected?.id ?? "system";
            setProfile(next);
            if (!running[active])
              setProfiles((old) => ({ ...old, [active]: next }));
          }}
        >
          <option value="system">Default shell</option>
          {profilesAvailable.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => startRename(active)}>
          Rename
        </button>
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
          Split right
        </button>
        <button
          type="button"
          disabled={slots.length >= 4 || split}
          onClick={() => create(true, "rows")}
        >
          Split down
        </button>
      </div>
      <div
        ref={grid}
        className="terminal-session-grid"
        style={
          split
            ? direction === "columns"
              ? { gridTemplateColumns: tracks }
              : { gridTemplateRows: tracks }
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
            style={
              direction === "columns"
                ? { gridColumn: visible.indexOf(id) === 1 ? 3 : 1, gridRow: 1 }
                : { gridColumn: 1, gridRow: visible.indexOf(id) === 1 ? 3 : 1 }
            }
            data-active={active === id}
            onFocusCapture={() => setActive(id)}
          >
            <TerminalPanel
              native={native}
              workspaceId={workspaceId}
              activation={activations[id]}
              profile={profiles[id]}
              onShell={(shell) => setShells((old) => ({ ...old, [id]: shell }))}
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
            aria-orientation={
              direction === "columns" ? "vertical" : "horizontal"
            }
            data-direction={direction}
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
              if (!bounds) return;
              const length =
                direction === "columns" ? bounds.width : bounds.height;
              const offset =
                direction === "columns"
                  ? event.clientX - bounds.left
                  : event.clientY - bounds.top;
              if (length) changeRatio(Math.round((offset / length) * 100));
            }}
            onKeyDown={(event) => {
              const [before, after] =
                direction === "columns"
                  ? ["ArrowLeft", "ArrowRight"]
                  : ["ArrowUp", "ArrowDown"];
              if (event.key !== before && event.key !== after) return;
              event.preventDefault();
              changeRatio(ratio + (event.key === before ? -5 : 5));
            }}
          />
        )}
      </div>
    </div>
  );
}

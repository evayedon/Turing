import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ChevronDown,
  Columns2,
  Ellipsis,
  Plus,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import type { TerminalProfile } from "@turing/contracts";
import type { Ref } from "react";
import { TerminalPanel } from "./TerminalPanel";
import type { TerminalActions } from "./TerminalPanel";
import { ToolbarMenu } from "./ToolbarMenu";
import {
  dividerShare,
  groupOf,
  removeTerminal,
  resizePair,
  splitGroup,
  terminalOrder,
} from "./terminal-groups";
import type { TerminalGroup } from "./terminal-groups";

const alone = (id: number): TerminalGroup => ({
  members: [id],
  axis: "columns",
  sizes: [100],
});

export type TerminalSessionControls = Pick<
  TerminalActions,
  "close" | "clear"
> & {
  create: (split: boolean) => void;
};
export function TerminalSessions({
  native,
  workspaceId,
  activation,
  actionsRef,
  onRunningChange,
  toolbar = "inline",
  shown = false,
}: {
  /** While true, a terminal that has never run starts without taking focus. */
  shown?: boolean;
  /** Where the session actions render: inline above the terminals, into a
   * host element (the bottom panel header), or nowhere (`null`). */
  toolbar?: "inline" | HTMLElement | null;
  native: boolean;
  workspaceId?: string;
  activation: number;
  actionsRef?: Ref<TerminalSessionControls>;
  onRunningChange?: (running: boolean) => void;
}) {
  const [groups, setGroups] = useState([alone(1)]);
  const [active, setActive] = useState(1);
  const [running, setRunning] = useState<Record<number, boolean>>({});
  const [activations, setActivations] = useState<Record<number, number>>({});
  const [profiles, setProfiles] = useState<Record<number, TerminalProfile>>({});
  const [labels, setLabels] = useState<Record<number, number>>({ 1: 1 });
  const [names, setNames] = useState<Record<number, string>>({});
  const [shells, setShells] = useState<Record<number, string>>({});
  const [rename, setRename] = useState<{ id: number; name: string }>();
  const idSequence = useRef(1);
  const started = useRef(new Set<number>());
  const handled = useRef(0);
  const handles = useRef(new Map<number, TerminalActions>());
  const grid = useRef<HTMLDivElement>(null);
  const activeTab = useRef<HTMLButtonElement>(null);
  const restoreTabFocus = useRef(false);
  const slots = terminalOrder(groups);
  // The active terminal's group is on screen; other groups stay mounted.
  const group = groupOf(groups, active) ?? groups[0];
  const visible = group.members;
  const direction = group.axis;

  // Terminals started because the panel became visible; they leave focus
  // where it is until the user explicitly opens them.
  const quiet = useRef(new Set<number>());
  const explicit = useRef<number>(undefined);

  const activateSelected = useEffectEvent(() => {
    quiet.current.delete(active);
    explicit.current = active;
    requestActivation(active);
  });

  useEffect(() => {
    if (!activation || handled.current === activation) return;
    handled.current = activation;
    activateSelected();
  }, [activation]);

  const startShown = useEffectEvent(() => {
    const requested = explicit.current === active;
    explicit.current = undefined;
    if (
      !native ||
      requested ||
      started.current.has(active) ||
      activations[active]
    )
      return;
    quiet.current.add(active);
    requestActivation(active);
  });
  useEffect(() => {
    if (shown) startShown();
  }, [shown, active]);

  useEffect(
    () => onRunningChange?.(!!running[active]),
    [onRunningChange, running, active],
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
    if (id !== active) setActive(id);
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

  function create(
    split: boolean,
    axis: "columns" | "rows" = "columns",
    chosen?: TerminalProfile,
  ) {
    if (!native) return;
    // A split uses the same shell as the terminal it splits, as in VS Code.
    const profile =
      chosen ?? (split ? profiles[active] : undefined) ?? "system";
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
    const id = ++idSequence.current;
    const used = new Set(slots.map((slot) => labels[slot]));
    let number = 1;
    while (used.has(number)) number++;
    setLabels((old) => ({ ...old, [id]: number }));
    setProfiles((old) => ({ ...old, [id]: profile }));
    setGroups((old) =>
      split ? splitGroup(old, active, id, axis) : [...old, alone(id)],
    );
    setActive(id);
    requestActivation(id);
  }

  function remove(id: number) {
    const left = removeTerminal(groups, id);
    const remaining = terminalOrder(left);
    const next = remaining.length ? left : [alone(++idSequence.current)];
    const members = groupOf(groups, id)?.members ?? [];
    const at = members.indexOf(id);
    // Focus moves to a neighbour in the same group, as in VS Code.
    const neighbour = members[at - 1] ?? members[at + 1];
    setGroups(next);
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
        : { [next[0].members[0]]: 1 },
    );
    if (rename?.id === id) setRename(undefined);
    if (active === id) setActive(neighbour ?? terminalOrder(next)[0]);
    restoreTabFocus.current = true;
  }

  useImperativeHandle(actionsRef, () => ({
    create: (split: boolean) => create(split),
    close: () => handles.current.get(active)?.close(),
    clear: () => handles.current.get(active)?.clear(),
  }));

  function kill() {
    if (slots.length > 1) remove(active);
    else handles.current.get(active)?.close();
  }

  function resize(index: number, share: number) {
    setGroups((old) =>
      old.map((item) =>
        item.members.includes(active) ? resizePair(item, index, share) : item,
      ),
    );
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
  const tracks = group.sizes
    .map((size) => `minmax(0, ${size}fr)`)
    .join(" 6px ");

  if (!native) return <TerminalPanel native={false} />;

  /** VS Code-style tree lines that tie split terminals into their group. */
  function connector(id: number) {
    const members = groupOf(groups, id)?.members ?? [];
    if (members.length < 2) return "";
    const at = members.indexOf(id);
    return at === 0 ? "┌" : at === members.length - 1 ? "└" : "├";
  }

  const tabs = (
    <div className="terminal-session-tabs">
      {/* Session removal and rename controls are outside the ARIA tablist. */}
      <div
        role="tablist"
        aria-label="Terminal sessions"
        aria-orientation={slots.length > 1 ? "vertical" : "horizontal"}
        aria-owns={slots
          .filter((id) => rename?.id !== id)
          .map((id) => `terminal-tab-${id}`)
          .join(" ")}
        hidden={slots.length === 1 && !!rename}
      />
      {slots.map((id) => (
        <div
          key={id}
          className="terminal-session-tab"
          role="presentation"
          data-active={active === id}
        >
          {rename?.id === id ? (
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
                onBlur={() => setRename(undefined)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    restoreTabFocus.current = true;
                    setRename(undefined);
                  }
                }}
              />
            </form>
          ) : (
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
                const step =
                  event.key === "ArrowDown" || event.key === "ArrowRight"
                    ? 1
                    : event.key === "ArrowUp" || event.key === "ArrowLeft"
                      ? slots.length - 1
                      : 0;
                const next =
                  event.key === "Home"
                    ? slots[0]
                    : event.key === "End"
                      ? slots.at(-1)
                      : step
                        ? slots[(slots.indexOf(id) + step) % slots.length]
                        : undefined;
                if (next === undefined) return;
                event.preventDefault();
                select(next);
                event.currentTarget.ownerDocument
                  .getElementById(`terminal-tab-${next}`)
                  ?.focus();
              }}
            >
              <span className="terminal-group-line" aria-hidden="true">
                {connector(id)}
              </span>
              <SquareTerminal size={14} aria-hidden="true" />
              <span>{label(id)}</span>
            </button>
          )}
          {slots.length > 1 && (
            <button
              type="button"
              className="terminal-tab-kill"
              aria-label={`Remove ${label(id)}`}
              title={`Kill ${label(id)}`}
              onClick={() => remove(id)}
            >
              <Trash2 size={13} aria-hidden="true" />
            </button>
          )}
        </div>
      ))}
    </div>
  );

  const actions = (
    <div
      className="terminal-actions"
      role="group"
      aria-label="Terminal actions"
    >
      {slots.length === 1 && tabs}
      <button
        type="button"
        className="dock-action"
        aria-label="New terminal session"
        title="New Terminal"
        onClick={() => create(false)}
      >
        <Plus size={15} aria-hidden="true" />
      </button>
      <ToolbarMenu
        label="Launch profile"
        icon={<ChevronDown size={14} aria-hidden="true" />}
        items={[
          ...[
            { id: "system" as const, label: "Default shell" },
            ...profilesAvailable,
          ].map((item) => ({
            label: `New ${item.label} terminal`,
            run: () => create(false, "columns", item.id),
          })),
          "-",
          {
            label: "Split Terminal",
            run: () => create(true),
          },
        ]}
      />
      <button
        type="button"
        className="dock-action"
        aria-label="Split terminal pane"
        title="Split Terminal"
        onClick={() => create(true)}
      >
        <Columns2 size={15} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="dock-action"
        aria-label="Kill terminal"
        title="Kill Terminal"
        onClick={kill}
      >
        <Trash2 size={15} aria-hidden="true" />
      </button>
      <ToolbarMenu
        label="More terminal actions"
        icon={<Ellipsis size={15} aria-hidden="true" />}
        items={[
          { label: "Rename…", run: () => startRename(active) },
          {
            label: "Split Down",
            run: () => create(true, "rows"),
          },
          "-",
          {
            label: "Find",
            disabled: !running[active],
            run: () => handles.current.get(active)?.find(),
          },
          {
            label: "Copy",
            disabled: !running[active],
            run: () => handles.current.get(active)?.copy(),
          },
          {
            label: "Paste",
            disabled: !running[active],
            run: () => handles.current.get(active)?.paste(),
          },
          {
            label: "Clear",
            disabled: !running[active],
            run: () => handles.current.get(active)?.clear(),
          },
        ]}
      />
    </div>
  );

  return (
    <div
      className="terminal-sessions"
      data-toolbar={toolbar === "inline" ? "inline" : "hosted"}
      data-list={slots.length > 1}
    >
      {toolbar === "inline"
        ? actions
        : toolbar && createPortal(actions, toolbar)}
      <div
        ref={grid}
        className="terminal-session-grid"
        data-split={split}
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
            aria-label={label(id)}
            hidden={!visible.includes(id)}
            className="terminal-session-pane"
            style={(() => {
              const track = Math.max(0, visible.indexOf(id)) * 2 + 1;
              return direction === "columns"
                ? { gridColumn: track, gridRow: 1 }
                : { gridColumn: 1, gridRow: track };
            })()}
            data-active={active === id}
            onFocusCapture={() => setActive(id)}
          >
            <TerminalPanel
              native={native}
              chrome="minimal"
              sessionName={label(id)}
              workspaceId={workspaceId}
              activation={activations[id]}
              profile={profiles[id]}
              onShell={(shell) => setShells((old) => ({ ...old, [id]: shell }))}
              focusOnStart={active === id && !quiet.current.has(id)}
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
        {visible.slice(1).map((_, index) => {
          const track = index * 2 + 2;
          return (
            <div
              key={`divider-${visible[index]}-${visible[index + 1]}`}
              className="terminal-session-divider"
              role="separator"
              tabIndex={0}
              aria-label={
                visible.length === 2
                  ? "Resize terminal panes"
                  : `Resize terminal panes ${index + 1} and ${index + 2}`
              }
              aria-orientation={
                direction === "columns" ? "vertical" : "horizontal"
              }
              data-direction={direction}
              style={
                direction === "columns"
                  ? { gridColumn: track, gridRow: 1 }
                  : { gridColumn: 1, gridRow: track }
              }
              aria-controls={`terminal-session-${visible[index]}`}
              aria-valuemin={20}
              aria-valuemax={80}
              aria-valuenow={dividerShare(group, index)}
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
                if (!length) return;
                const offset =
                  ((direction === "columns"
                    ? event.clientX - bounds.left
                    : event.clientY - bounds.top) /
                    length) *
                  100;
                const before = group.sizes
                  .slice(0, index)
                  .reduce((sum, size) => sum + size, 0);
                const span = group.sizes[index] + group.sizes[index + 1];
                resize(index, Math.round(((offset - before) / span) * 100));
              }}
              onKeyDown={(event) => {
                const [back, forward] =
                  direction === "columns"
                    ? ["ArrowLeft", "ArrowRight"]
                    : ["ArrowUp", "ArrowDown"];
                if (event.key !== back && event.key !== forward) return;
                event.preventDefault();
                resize(
                  index,
                  dividerShare(group, index) + (event.key === back ? -5 : 5),
                );
              }}
            />
          );
        })}
      </div>
      {slots.length > 1 && tabs}
    </div>
  );
}

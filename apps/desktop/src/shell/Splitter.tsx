import { useRef } from "react";
import { clampSize, minimumSizes } from "./pane-layout";
import type { Pane } from "./pane-layout";

export function Splitter({
  pane,
  value,
  max,
  onChange,
  onCommit,
}: {
  pane: Pane;
  value: number;
  max: number;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const drag = useRef<{
    id: number;
    start: number;
    size: number;
    latest: number;
  } | null>(null);
  const horizontal = pane === "terminal";
  const direction = pane === "sidebar" ? 1 : -1;
  const label = {
    sidebar: "Resize sidebar",
    assistant: "Resize AI panel",
    terminal: "Resize bottom panel",
  }[pane];

  function finish(pointerId: number) {
    if (drag.current?.id !== pointerId) return;
    const next = drag.current.latest;
    drag.current = null;
    onCommit(next);
  }

  return (
    <div
      className={`splitter splitter-${pane}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={horizontal ? "horizontal" : "vertical"}
      aria-valuemin={minimumSizes[pane]}
      aria-valuemax={Math.max(minimumSizes[pane], max)}
      aria-valuenow={value}
      title={`${label} · Drag or use arrow keys`}
      onKeyDown={(event) => {
        const keys = horizontal
          ? ["ArrowUp", "ArrowDown"]
          : ["ArrowLeft", "ArrowRight"];
        const step = event.shiftKey ? 32 : 8;
        const next =
          event.key === "Home"
            ? minimumSizes[pane]
            : event.key === "End"
              ? max
              : event.key === keys[0]
                ? value - step * direction
                : event.key === keys[1]
                  ? value + step * direction
                  : undefined;
        if (next === undefined) return;
        event.preventDefault();
        onCommit(clampSize(pane, next, max));
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          id: event.pointerId,
          start: horizontal ? event.clientY : event.clientX,
          size: value,
          latest: value,
        };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current || current.id !== event.pointerId) return;
        current.latest = clampSize(
          pane,
          current.size +
            ((horizontal ? event.clientY : event.clientX) - current.start) *
              direction,
          max,
        );
        onChange(current.latest);
      }}
      onPointerUp={(event) => finish(event.pointerId)}
      onLostPointerCapture={(event) => finish(event.pointerId)}
    />
  );
}

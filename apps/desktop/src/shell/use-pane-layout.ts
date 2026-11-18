import { useEffect, useState } from "react";
import {
  clampSize,
  fitColumns,
  loadSizes,
  initialSizes,
  maximumSizes,
  minimumSizes,
  storeSizes,
} from "./pane-layout";
import type { Pane } from "./pane-layout";

export function usePaneLayout(left: boolean, right: boolean) {
  const [sizes, setSizes] = useState(loadSizes);
  const [preview, setPreview] = useState<{ pane: Pane; value: number } | null>(
    null,
  );
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    function resize() {
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    }
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => storeSizes(sizes), [sizes]);

  const fitted = fitColumns(viewport.width, sizes, left, right);
  const columns = { ...fitted };
  if (preview?.pane === "sidebar" || preview?.pane === "assistant") {
    columns[preview.pane] = preview.value;
  }
  const horizontalBudget =
    viewport.width - 46 - 260 - (Number(left) + Number(right)) * 6;
  const limits = {
    sidebar: Math.max(
      minimumSizes.sidebar,
      Math.min(maximumSizes.sidebar, horizontalBudget - fitted.assistant),
    ),
    assistant: Math.max(
      minimumSizes.assistant,
      Math.min(maximumSizes.assistant, horizontalBudget - fitted.sidebar),
    ),
    terminal: Math.max(
      minimumSizes.terminal,
      Math.min(maximumSizes.terminal, viewport.height - 285),
    ),
  };
  const visible = {
    ...columns,
    terminal: clampSize(
      "terminal",
      preview?.pane === "terminal" ? preview.value : sizes.terminal,
      limits.terminal,
    ),
  };
  return {
    visible,
    resetSizes: () => {
      setPreview(null);
      setSizes(initialSizes);
    },
    splitter: (pane: Pane) => ({
      pane,
      value: visible[pane],
      max: limits[pane],
      onChange: (value: number) => setPreview({ pane, value }),
      onCommit: (value: number) => {
        setPreview(null);
        setSizes((previous) => ({
          ...previous,
          ...(pane === "sidebar" && right
            ? { assistant: fitted.assistant }
            : {}),
          ...(pane === "assistant" && left ? { sidebar: fitted.sidebar } : {}),
          [pane]: value,
        }));
      },
    }),
  };
}

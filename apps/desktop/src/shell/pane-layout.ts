export const layoutKey = "turing:layout:v1";
export const initialSizes = { sidebar: 228, assistant: 252, terminal: 142 };
export const minimumSizes = { sidebar: 144, assistant: 148, terminal: 88 };
export const maximumSizes = { sidebar: 470, assistant: 470, terminal: 480 };
export type Pane = keyof typeof initialSizes;
export type PaneSizes = typeof initialSizes;

export function clampSize(pane: Pane, value: number, max = maximumSizes[pane]) {
  return Math.min(
    Math.max(minimumSizes[pane], max),
    Math.max(minimumSizes[pane], Math.round(value)),
  );
}

export function loadSizes(): PaneSizes {
  try {
    const saved: Partial<PaneSizes> | null = JSON.parse(
      window.localStorage.getItem(layoutKey) ?? "null",
    );
    const sizes = { ...initialSizes };
    for (const pane of Object.keys(sizes) as Pane[]) {
      const value = saved?.[pane];
      if (typeof value === "number" && Number.isFinite(value))
        sizes[pane] = clampSize(pane, value);
    }
    return sizes;
  } catch {
    return initialSizes;
  }
}

export function storeSizes(sizes: PaneSizes) {
  try {
    window.localStorage.setItem(layoutKey, JSON.stringify(sizes));
  } catch {
    // Layout remains usable if storage is blocked.
  }
}

export function fitColumns(
  width: number,
  sizes: PaneSizes,
  left: boolean,
  right: boolean,
) {
  const sidebar = left ? sizes.sidebar : 0;
  const assistant = right ? sizes.assistant : 0;
  const available = width - 46 - 260 - (Number(left) + Number(right)) * 6;
  const minLeft = left ? minimumSizes.sidebar : 0;
  const minRight = right ? minimumSizes.assistant : 0;
  const extra = sidebar + assistant - minLeft - minRight;
  const scale =
    extra > 0
      ? Math.max(0, Math.min(1, (available - minLeft - minRight) / extra))
      : 0;
  return {
    sidebar: Math.floor(minLeft + (sidebar - minLeft) * scale),
    assistant: Math.floor(minRight + (assistant - minRight) * scale),
  };
}

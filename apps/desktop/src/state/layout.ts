import { create } from "zustand";
import type { SidebarView } from "@turing/contracts";
import { dockViews } from "./dock-views";
import type { DockView } from "./dock-views";

interface LayoutPreferences {
  sidebar: SidebarView | null;
  terminal: boolean;
  assistant: boolean;
  dockView: DockView;
}

interface LayoutState extends LayoutPreferences {
  toggleSidebar: (view: SidebarView) => void;
  toggleTerminal: () => void;
  toggleAssistant: () => void;
  selectDockView: (dockView: DockView) => void;
}

const key = "turing:visible-panes:v1";
const defaults: LayoutPreferences = {
  sidebar: "explorer",
  terminal: false,
  assistant: false,
  dockView: "Terminal",
};

function loadVisibility(): LayoutPreferences {
  try {
    const saved: Partial<LayoutPreferences> | null = JSON.parse(
      window.localStorage.getItem(key) ?? "null",
    );
    const sidebar = saved?.sidebar;
    return {
      sidebar:
        sidebar === "explorer" ||
        sidebar === "search" ||
        sidebar === "git" ||
        sidebar === null
          ? sidebar
          : defaults.sidebar,
      dockView:
        dockViews.find((view) => view === saved?.dockView) ?? defaults.dockView,
      terminal:
        typeof saved?.terminal === "boolean"
          ? saved.terminal
          : defaults.terminal,
      assistant:
        typeof saved?.assistant === "boolean"
          ? saved.assistant
          : defaults.assistant,
    };
  } catch {
    return defaults;
  }
}

export const useLayout = create<LayoutState>((set) => ({
  ...loadVisibility(),
  toggleSidebar: (view) =>
    set((state) => ({ sidebar: state.sidebar === view ? null : view })),
  toggleTerminal: () => set((state) => ({ terminal: !state.terminal })),
  toggleAssistant: () => set((state) => ({ assistant: !state.assistant })),
  selectDockView: (dockView) => set({ dockView }),
}));

useLayout.subscribe(({ sidebar, terminal, assistant, dockView }, before) => {
  if (
    sidebar === before.sidebar &&
    terminal === before.terminal &&
    assistant === before.assistant &&
    dockView === before.dockView
  )
    return;
  try {
    window.localStorage.setItem(
      key,
      JSON.stringify({ sidebar, terminal, assistant, dockView }),
    );
  } catch {
    // Visibility remains usable if storage is blocked.
  }
});

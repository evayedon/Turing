import { create } from "zustand";
import type { SidebarView } from "@turing/contracts";

interface LayoutState {
  sidebar: SidebarView | null;
  terminal: boolean;
  assistant: boolean;
  toggleSidebar: (view: SidebarView) => void;
  toggleTerminal: () => void;
  toggleAssistant: () => void;
}

export const useLayout = create<LayoutState>((set) => ({
  sidebar: "explorer",
  terminal: true,
  assistant: true,
  toggleSidebar: (view) =>
    set((state) => ({ sidebar: state.sidebar === view ? null : view })),
  toggleTerminal: () => set((state) => ({ terminal: !state.terminal })),
  toggleAssistant: () => set((state) => ({ assistant: !state.assistant })),
}));

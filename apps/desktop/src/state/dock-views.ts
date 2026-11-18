export const dockViews = ["Terminal", "Problems", "Output"] as const;
export type DockView = (typeof dockViews)[number];

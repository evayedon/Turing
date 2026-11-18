import {
  BugPlay,
  Files,
  GitBranch,
  PanelBottom,
  Search,
  Settings,
  Sparkles,
} from "lucide-react";
import { useId } from "react";
import type { LucideIcon } from "lucide-react";
import type { SidebarView } from "@turing/contracts";

const destinations = [
  { view: "explorer", label: "Explorer", Icon: Files },
  { view: "search", label: "Search", Icon: Search },
  { view: "git", label: "Source Control", Icon: GitBranch },
] as const;

function RailButton({
  label,
  id,
  tooltip = label,
  Icon,
  pressed,
  controls,
  disabled,
  run,
}: {
  label: string;
  id?: string;
  tooltip?: string;
  Icon: LucideIcon;
  pressed?: boolean;
  controls?: string;
  disabled?: boolean;
  run?: () => void;
}) {
  const help = useId();
  return (
    <div className="rail-item">
      <button
        id={id}
        type="button"
        aria-label={label}
        aria-pressed={pressed}
        aria-controls={controls}
        aria-disabled={disabled}
        aria-describedby={disabled ? help : undefined}
        aria-haspopup={label === "Settings" ? "dialog" : undefined}
        onClick={run}
      >
        <Icon size={17} aria-hidden="true" />
      </button>
      <span id={help} className="rail-tooltip" aria-hidden={!disabled}>
        {tooltip}
      </span>
    </div>
  );
}

export function ActivityBar({
  sidebar,
  assistant,
  bottom,
  toggleSidebar,
  toggleAssistant,
  toggleBottom,
  openSettings,
}: {
  sidebar: SidebarView | null;
  assistant: boolean;
  bottom: boolean;
  toggleSidebar: (view: SidebarView) => void;
  toggleAssistant: () => void;
  toggleBottom: () => void;
  openSettings: () => void;
}) {
  return (
    <nav className="activity" aria-label="Workbench panels">
      <div className="rail-group">
        {destinations.map(({ view, label, Icon }) => (
          <RailButton
            key={view}
            label={label}
            Icon={Icon}
            pressed={sidebar === view}
            controls={sidebar === view ? "workbench-sidebar" : undefined}
            run={() => toggleSidebar(view)}
          />
        ))}
        <RailButton
          label="Run & Debug"
          tooltip="Run & Debug is unavailable"
          Icon={BugPlay}
          disabled
        />
        <RailButton
          label="Turing AI"
          Icon={Sparkles}
          pressed={assistant}
          controls={assistant ? "turing-ai-panel" : undefined}
          run={toggleAssistant}
        />
      </div>
      <div className="rail-group rail-utilities">
        <RailButton
          id="toggle-bottom-panel"
          label="Toggle Bottom Panel"
          Icon={PanelBottom}
          pressed={bottom}
          controls={bottom ? "bottom-dock" : undefined}
          run={toggleBottom}
        />
        <RailButton label="Settings" Icon={Settings} run={openSettings} />
      </div>
    </nav>
  );
}

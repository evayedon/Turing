import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

export function WorkbenchDialog({
  title,
  close,
  children,
  className,
  busy,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
  className?: string;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (typeof element.showModal === "function") element.showModal();
    else element.open = true;
    (
      element.querySelector<HTMLElement>("[data-initial-focus]") ??
      element.querySelector<HTMLElement>("button")
    )?.focus();
    return () => {
      if (typeof element.close === "function") element.close();
      else element.open = false;
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={
        className ? `workbench-dialog ${className}` : "workbench-dialog"
      }
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        if (busy) return;
        dialog.current?.close?.();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          if (busy) return;
          dialog.current?.close?.();
          close();
        }
      }}
    >
      <h2>{title}</h2>
      {children}
      <button
        type="button"
        className="quiet-button"
        disabled={busy}
        onClick={() => {
          if (busy) return;
          dialog.current?.close?.();
          close();
        }}
      >
        Close
      </button>
    </dialog>
  );
}

import { useLayoutEffect, useRef } from "react";
import type { ReactNode } from "react";

export function WorkbenchDialog({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = element.ownerDocument.activeElement;
    if (typeof element.showModal === "function") element.showModal();
    else element.open = true;
    (
      element.querySelector<HTMLElement>("[data-initial-focus]") ??
      element.querySelector<HTMLElement>("button")
    )?.focus();
    return () => {
      if (typeof element.close === "function") element.close();
      else element.open = false;
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="workbench-dialog"
      aria-label={title}
      aria-modal="true"
      onCancel={(event) => {
        event.preventDefault();
        dialog.current?.close?.();
        close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
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
        onClick={() => {
          dialog.current?.close?.();
          close();
        }}
      >
        Close
      </button>
    </dialog>
  );
}

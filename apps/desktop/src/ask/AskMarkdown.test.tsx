// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskMarkdown } from "./AskMarkdown";

afterEach(cleanup);

describe("AskMarkdown", () => {
  it("renders headings, lists, inline styles, and code without interpreting HTML", () => {
    const { container } = render(
      <AskMarkdown
        text={[
          "## Overview",
          "Uses **Rust** and *Tauri* with `invoke`.",
          "",
          "- first",
          "- second",
          "1. one",
          "<img src=x onerror=alert(1)>",
          "```ts",
          "const a = 1;",
          "```",
        ].join("\n")}
      />,
    );
    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("Rust");
    expect(container.querySelector("em")?.textContent).toBe("Tauri");
    expect(container.querySelector("p code")?.textContent).toBe("invoke");
    expect(container.querySelectorAll("ul li")).toHaveLength(2);
    expect(container.querySelectorAll("ol li")).toHaveLength(1);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("pre code")?.textContent).toBe(
      "const a = 1;\n",
    );
  });

  it("turns known citations into source buttons and leaves unknown ones as text", async () => {
    const open = vi.fn();
    const source = {
      relativePath: "src/a.rs",
      version: "v1",
      startLine: 1,
      endLine: 12,
    };
    render(
      <AskMarkdown text="See [1] and [2]." sources={[source]} open={open} />,
    );
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Source 1: src/a.rs:1–12" }));
    expect(open).toHaveBeenCalledWith(source);
    expect(screen.queryByRole("button", { name: /Source 2/ })).toBeNull();
    expect(screen.getByText(/and \[2\]\./)).toBeTruthy();
  });
});

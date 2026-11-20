import axe from "axe-core";
import { expect } from "vitest";

export async function expectAccessible(
  container: HTMLElement,
  wholeWorkbench = false,
) {
  const result = await axe.run(container, {
    rules: {
      // jsdom cannot paint or measure foreground/background combinations.
      "color-contrast": { enabled: false },
      // This is a rendered fragment, not the document served by Vite.
      region: { enabled: wholeWorkbench },
    },
  });
  expect(
    result.violations.map(({ id, nodes }) => ({
      id,
      nodes: nodes.map(({ target, failureSummary }) => ({
        target,
        failureSummary,
      })),
    })),
  ).toEqual([]);
}

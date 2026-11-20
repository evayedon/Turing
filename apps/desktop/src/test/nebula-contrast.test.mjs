import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL } from "node:url";

const tokens = readFileSync(
  new URL("../../../../packages/design-system/src/nebula.css", import.meta.url),
  "utf8",
);
const workbench = readFileSync(
  new URL("../shell/workbench.css", import.meta.url),
  "utf8",
);

function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => {
    const srgb = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function token(name) {
  const value = tokens.match(
    new RegExp(`--nebula-${name}: (#[a-f0-9]{6});`),
  )?.[1];
  if (!value) throw new Error(`Missing opaque Nebula color ${name}`);
  return value;
}

function contrast(first, second) {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const surfaces = ["canvas", "panel", "rail", "raised", "hover", "active"];

describe("Nebula contrast", () => {
  it.each(["text", "muted", "accent", "cyan", "danger"])(
    "keeps %s body text at 4.5:1 on workbench surfaces",
    (name) => {
      for (const surface of surfaces)
        expect(
          contrast(token(name), token(surface)),
          surface,
        ).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("keeps the accent focus outline and selected indicators at 3:1", () => {
    expect(tokens).toContain("--nebula-focus: 2px solid var(--nebula-accent)");
    expect(workbench).toContain("outline: var(--nebula-focus)");
    for (const surface of surfaces)
      expect(
        contrast(token("accent"), token(surface)),
        surface,
      ).toBeGreaterThanOrEqual(3);
  });

  it("keeps the editor welcome heading at 3:1 and the terminal failure mark at 4.5:1", () => {
    expect(contrast(token("text"), token("canvas"))).toBeGreaterThanOrEqual(3);
    expect(
      contrast(token("text"), token("accent-border")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(workbench).toContain("background: var(--nebula-terminal-failure)");
    expect(workbench).toContain("color: var(--nebula-terminal-failure-text)");
    expect(
      contrast(token("terminal-failure-text"), token("terminal-failure")),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(token("terminal-failure"), token("rail")),
    ).toBeGreaterThanOrEqual(3);
  });
});

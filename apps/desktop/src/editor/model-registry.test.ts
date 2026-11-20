import { describe, expect, it, vi } from "vitest";
import { ModelRegistry } from "./model-registry";

const model = () => ({ dispose: vi.fn() });

describe("model registry", () => {
  it("creates one model per document and reuses it for every view", () => {
    const registry = new ModelRegistry<ReturnType<typeof model>>();
    const create = vi.fn(model);
    const first = registry.acquire("a", create);
    expect(registry.acquire("a", create)).toBe(first);
    expect(create).toHaveBeenCalledOnce();
    expect(registry.get("a")).toBe(first);
    expect(registry.keyOf(first)).toBe("a");
  });

  it("disposes exactly the models whose documents left every group", () => {
    const registry = new ModelRegistry<ReturnType<typeof model>>();
    const a = registry.acquire("a", model);
    const b = registry.acquire("b", model);
    expect(registry.retain(new Set(["a", "b"]))).toEqual([]);
    expect(registry.retain(new Set(["a"]))).toEqual(["b"]);
    expect(b.dispose).toHaveBeenCalledOnce();
    expect(a.dispose).not.toHaveBeenCalled();
    expect(registry.get("b")).toBeUndefined();
    registry.retain(new Set(["a"]));
    expect(b.dispose).toHaveBeenCalledOnce();
    expect(registry.clear()).toEqual(["a"]);
    expect(a.dispose).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
  });

  it("knows which models attached views show", () => {
    const registry = new ModelRegistry<ReturnType<typeof model>>();
    const a = registry.acquire("a", model);
    let shown: typeof a | null = a;
    const detach = registry.attach({ getModel: () => shown });
    expect(registry.isShown(a)).toBe(true);
    shown = null;
    expect(registry.isShown(a)).toBe(false);
    shown = a;
    detach();
    expect(registry.isShown(a)).toBe(false);
  });

  it("reports each content version once across views and marks syncs", () => {
    const registry = new ModelRegistry<ReturnType<typeof model>>();
    expect(registry.claimChange("a", 2)).toBe(true);
    expect(registry.claimChange("a", 2)).toBe(false);
    expect(registry.claimChange("a", 3)).toBe(true);
    expect(registry.syncing).toBe(false);
    const result = registry.sync(() => {
      expect(registry.syncing).toBe(true);
      return registry.sync(() => 4);
    });
    expect(result).toBe(4);
    expect(registry.syncing).toBe(false);
    expect(() =>
      registry.sync(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(registry.syncing).toBe(false);
  });
});

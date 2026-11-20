import assert from "node:assert/strict";
import test from "node:test";
import {
  compare,
  HARNESS,
  percentiles,
  SCHEMA,
  summarize,
} from "./perf-metrics.mjs";

const run = {
  os: "macos",
  mainPageLoadedMs: 10,
  windows: ["workbench", "workbench", "terminal", "terminal"].map(
    (kind, index) => ({
      kind,
      openToReadyMs: index + 1,
    }),
  ),
  perf: {
    mainReadyMs: 20,
    startupRssBytes: 1024 ** 2,
    afterOpenRssBytes: 2 * 1024 ** 2,
    afterCloseRssBytes: 1024 ** 2,
    editor: { typingBurstMs: 20, largeFileOpenMs: 40 },
    terminal: {
      startMs: 10,
      outputMs: 50,
      payloadBytesPerSecond: 5 * 1024 ** 2,
    },
  },
};

test("uses nearest rank for unsorted samples and handles empty and singleton inputs", () => {
  const values = [11, 1, 10, 2, 9, 3, 8, 4, 7, 5, 6];
  assert.deepEqual(percentiles(values), { p50: 6, p95: 11 });
  assert.equal(values[0], 11);
  assert.deepEqual(percentiles([7]), { p50: 7, p95: 7 });
  assert.equal(percentiles([]), null);
  assert.deepEqual(percentiles(Array.from({ length: 20 }, (_, i) => i + 1)), {
    p50: 10,
    p95: 19,
  });
});

test("summarizes each window ordinal and reports absent Windows RSS", () => {
  const windowsRun = {
    ...run,
    os: "windows",
    perf: {
      ...run.perf,
      startupRssBytes: null,
      afterOpenRssBytes: null,
      afterCloseRssBytes: null,
    },
  };
  const rows = summarize([windowsRun]);
  assert.equal(
    rows.find(({ metric }) => metric === "terminal 2 open → ready").p50,
    4,
  );
  assert.deepEqual(
    rows.find(({ metric }) => metric === "App RSS at startup"),
    {
      metric: "App RSS at startup",
      unit: "MiB",
      count: 0,
    },
  );
  assert.throws(
    () => summarize([{ ...run, mainPageLoadedMs: undefined }]),
    /invalid samples/,
  );
});

test("compares signed deltas and guards against an unsupported comparison", () => {
  const old = {
    schema: SCHEMA,
    harness: HARNESS,
    os: "macos",
    arch: "aarch64",
    runs: [run],
  };
  const newer = {
    ...old,
    runs: [
      { ...run, mainPageLoadedMs: 12, perf: { ...run.perf, mainReadyMs: 18 } },
    ],
  };
  const rows = compare(old, newer);
  assert.equal(rows[0]["p50 delta"], 2);
  assert.equal(rows[0]["p95 %"], 20);
  assert.equal(rows[1]["p50 %"], -10);
  assert.equal(
    compare({ ...old, runs: [{ ...run, mainPageLoadedMs: 0 }] }, newer)[0][
      "p95 %"
    ],
    null,
  );
  assert.throws(() => compare(old, { ...newer, schema: 42 }), /Unsupported/);
  assert.throws(
    () => compare(old, { ...newer, os: "linux" }),
    /same OS and architecture/,
  );
});

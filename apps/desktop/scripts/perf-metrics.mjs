export const SCHEMA = 1;
export const HARNESS = "turing-startup-interaction-baseline";

const metrics = [
  ["Main page loaded", "ms", (run) => run.mainPageLoadedMs],
  ["Main ready", "ms", (run) => run.perf.mainReadyMs],
  ...["workbench", "terminal"].flatMap((kind) =>
    [0, 1].map((index) => [
      `${kind} ${index + 1} open → ready`,
      "ms",
      (run) =>
        run.windows.filter((window) => window.kind === kind)[index]
          ?.openToReadyMs,
    ]),
  ),
  ["App RSS at startup", "MiB", (run) => mib(run.perf.startupRssBytes)],
  [
    "App RSS after opening windows",
    "MiB",
    (run) => mib(run.perf.afterOpenRssBytes),
  ],
  [
    "App RSS after closing windows",
    "MiB",
    (run) => mib(run.perf.afterCloseRssBytes),
  ],
  ["Monaco typing burst", "ms", (run) => run.perf.editor.typingBurstMs],
  [
    "App RSS before closing windows",
    "MiB",
    (run) => mib(run.perf.beforeCloseRssBytes),
    true,
  ],
  [
    "Monaco typing dispatch",
    "ms",
    (run) => run.perf.editor.typingDispatchMs,
    true,
  ],
  [
    "Monaco typing burst under load",
    "ms",
    (run) => run.perf.editor.typingUnderLoadMs,
    true,
  ],
  [
    "Monaco typing dispatch under load",
    "ms",
    (run) => run.perf.editor.typingUnderLoadDispatchMs,
    true,
  ],
  [
    "Monaco typing frame timeouts",
    "count",
    (run) => run.perf.editor.typingFrameTimeouts,
    true,
  ],
  [
    "Monaco large document open",
    "ms",
    (run) => run.perf.editor.largeFileOpenMs,
  ],
  [
    "PTY start → first command output",
    "ms",
    (run) => run.perf.terminal.startMs,
  ],
  ["PTY output duration", "ms", (run) => run.perf.terminal.outputMs],
  [
    "PTY output throughput",
    "MiB/s",
    (run) => mib(run.perf.terminal.payloadBytesPerSecond),
  ],
];

function mib(bytes) {
  return bytes == null ? bytes : bytes / 1024 ** 2;
}

// Nearest rank. In particular, p95 is the maximum for the default ten launches.
export function percentiles(samples) {
  if (!samples.length) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

export function summarize(runs) {
  return metrics.flatMap(([metric, unit, read, optional]) => {
    const values = runs.map(read);
    if (optional && values.every((value) => value === undefined)) return [];
    const samples = values.filter((value) => value !== null);
    if (
      samples.some((value) => !Number.isFinite(value) || value < 0) ||
      (samples.length !== 0 && samples.length !== runs.length) ||
      (samples.length === 0 &&
        !(unit === "MiB" && runs.every(({ os }) => os === "windows")))
    ) {
      throw new Error(`Missing or invalid samples for ${metric}`);
    }
    return { metric, unit, count: samples.length, ...percentiles(samples) };
  });
}

export function compare(before, after) {
  for (const baseline of [before, after]) {
    if (baseline.schema !== SCHEMA || baseline.harness !== HARNESS) {
      throw new Error("Unsupported baseline schema or harness");
    }
  }
  if (before.os !== after.os || before.arch !== after.arch) {
    throw new Error(
      "Compare baselines captured for the same OS and architecture",
    );
  }
  // Recompute from the raw runs so rounding and stale aggregate values cannot affect deltas.
  const oldRows = new Map(
    summarize(before.runs).map((row) => [row.metric, row]),
  );
  return summarize(after.runs).map((row) => {
    const old = oldRows.get(row.metric);
    return {
      metric: row.metric,
      unit: row.unit,
      oldCount: old?.count ?? 0,
      newCount: row.count,
      ...Object.fromEntries(
        ["p50", "p95"].flatMap((key) => {
          const delta =
            row[key] === undefined || old?.[key] === undefined
              ? null
              : row[key] - old[key];
          return [
            [`${key} delta`, delta],
            [
              `${key} %`,
              delta === null || old[key] === 0
                ? null
                : (delta / old[key]) * 100,
            ],
          ];
        }),
      ),
    };
  });
}

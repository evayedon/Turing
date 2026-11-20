/* global process, console */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { compare, HARNESS, SCHEMA, summarize } from "./perf-metrics.mjs";

const defaultBinary = fileURLToPath(
  new URL(
    `../src-tauri/target/release/turing-core${process.platform === "win32" ? ".exe" : ""}`,
    import.meta.url,
  ),
);
const usage =
  "Usage: perf-baseline.mjs [--runs N] [--binary PATH] [--output PATH] | --compare OLD NEW";

function options(args) {
  const result = {
    runs: 10,
    binary: defaultBinary,
    output: "turing-perf-baseline.json",
  };
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].slice(2);
    const value = args[index + 1];
    if (
      !args[index].startsWith("--") ||
      !Object.hasOwn(result, name) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error(usage);
    }
    result[name] = value;
  }
  result.runs = Number(result.runs);
  if (!Number.isSafeInteger(result.runs) || result.runs < 1) {
    throw new Error("--runs must be a positive integer");
  }
  return result;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function collect(binary, output) {
  const child = spawn(resolve(binary), [], {
    env: {
      ...process.env,
      TURING_SMOKE: "1",
      TURING_PERF: "1",
      TURING_SMOKE_TIMEOUT_SECS: "180",
      TURING_SMOKE_OUTPUT: output,
    },
    stdio: ["ignore", "ignore", "inherit"],
    timeout: 210_000,
    killSignal: "SIGKILL",
  });
  const [code, signal] = await once(child, "close");
  let run;
  try {
    run = await readJson(output);
  } catch (error) {
    throw new Error(
      `No native capture (exit ${code}, signal ${signal}): ${error.message}`,
    );
  }
  if (
    code !== 0 ||
    run.harness !== "turing-native-lifecycle-smoke" ||
    run.schema !== 1 ||
    run.status !== "passed" ||
    !run.perf
  ) {
    throw new Error(
      run.error ?? "Expected a passing capture from a perf-enabled binary",
    );
  }
  return run;
}

function printRows(rows) {
  console.table(
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value === null
            ? "—"
            : typeof value === "number"
              ? Number(value.toFixed(2))
              : value,
        ]),
      ),
    ),
  );
}

async function main(args) {
  if (args[0] === "--compare") {
    if (args.length !== 3) throw new Error(usage);
    printRows(compare(...(await Promise.all(args.slice(1).map(readJson)))));
    return;
  }
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
    return;
  }
  const { runs: count, binary, output } = options(args);
  const directory = await mkdtemp(join(tmpdir(), "turing-perf-"));
  try {
    const runs = [];
    for (let index = 0; index < count; index++) {
      try {
        runs.push(await collect(binary, join(directory, `run-${index}.json`)));
      } catch (error) {
        throw new Error(`Launch ${index + 1}/${count}: ${error.message}`);
      }
      console.error(`Captured launch ${index + 1}/${count}`);
    }
    const { os, arch } = runs[0];
    const baseline = {
      schema: SCHEMA,
      harness: HARNESS,
      capturedAt: new Date().toISOString(),
      os,
      arch,
      osRelease: release(),
      cpu: cpus()[0]?.model,
      metrics: summarize(runs),
      runs,
    };
    await writeFile(output, `${JSON.stringify(baseline, null, 2)}\n`);
    printRows(
      baseline.metrics.map((row) => ({ p50: null, p95: null, ...row })),
    );
    console.log(`Baseline saved to ${resolve(output)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

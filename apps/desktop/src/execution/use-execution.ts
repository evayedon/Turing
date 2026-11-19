import { executableLanguage } from "../editor/languages";
import { useEffect, useRef, useState } from "react";
import type {
  ExecutionLanguage,
  ExecutionPhase,
  ExecutionStream,
} from "@turing/contracts";
import type { EditorTab } from "../editor/use-editor";
import {
  executionErrorMessage,
  readExecution,
  startExecution,
  stopExecution,
} from "./execution-ipc";

export const languageLabels = { python: "Python", cpp: "C++" };

export { executableLanguage as executionLanguage } from "../editor/languages";

export function runDisabledReason(tab: EditorTab, native: boolean) {
  if (!native) return "Run requires the desktop app.";
  if (tab.source.kind === "untitled")
    return "Save this file as Python or C++ before running.";
  if (!executableLanguage(tab.name))
    return "Run supports Python and C++ source files.";
  if (tab.changedOnDisk) return "Reload the file from disk before running.";
  if (tab.draft !== tab.content) return "Save your changes before running.";
}

function appendOutput(previous: Output[], incoming: Output[]) {
  const output = previous.slice();
  for (const chunk of incoming) {
    if (!chunk.text) continue;
    const last = output.at(-1);
    if (last?.stream === chunk.stream) {
      output[output.length - 1] = { ...last, text: last.text + chunk.text };
    } else output.push(chunk);
  }
  return output;
}

const streams = ["buildStdout", "buildStderr", "stdout", "stderr"] as const;
type Output = { stream: ExecutionStream; text: string };
type Run = {
  document: { key: string; version: string };
  name: string;
  language: ExecutionLanguage;
  phase: ExecutionPhase;
  elapsedMs: number;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
  output: Output[];
  error?: string;
};

type Request = {
  id?: string;
  stop: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

export function useExecution() {
  const [run, setRun] = useState<Run>();
  const [busy, setBusy] = useState(false);
  const current = useRef<Request | undefined>(undefined);

  useEffect(
    () => () => {
      const request = current.current;
      current.current = undefined;
      if (request) {
        clearTimeout(request.timer);
        if (request.id) void stopExecution(request.id).catch(() => {});
      }
    },
    [],
  );

  async function start(tab: EditorTab, native: boolean, reveal: () => void) {
    const language = executableLanguage(tab.name);
    if (
      current.current ||
      !language ||
      tab.source.kind === "untitled" ||
      runDisabledReason(tab, native)
    )
      return;
    const request: Request = { stop: false };
    current.current = request;
    setBusy(true);
    setRun({
      document: { key: tab.key, version: tab.source.version },
      name: tab.title,
      language,
      phase: "preparing",
      elapsedMs: 0,
      exitCode: null,
      cancelled: false,
      truncated: false,
      output: [],
    });
    reveal();
    const decoders = new Map(
      streams.map((stream) => [stream, new TextDecoder()]),
    );
    function fail(error: unknown) {
      if (current.current !== request) return;
      current.current = undefined;
      setBusy(false);
      setRun(
        (previous) =>
          previous && {
            ...previous,
            phase: "failed",
            error: executionErrorMessage(error),
          },
      );
      if (request.id) void stopExecution(request.id).catch(() => {});
    }
    try {
      const started = await startExecution(tab.source, (phase) => {
        if (
          current.current !== request ||
          phase === "completed" ||
          phase === "failed" ||
          request.stop
        )
          return;
        setRun((previous) => previous && { ...previous, phase });
      });
      if (current.current !== request) {
        await stopExecution(started.id);
        return;
      }
      request.id = started.id;
      if (request.stop) await stopExecution(started.id);
      async function poll() {
        try {
          const update = await readExecution(started.id);
          if (current.current !== request) return;
          const done =
            update.phase === "completed" || update.phase === "failed";
          const output = update.output.map(({ stream, bytes }) => ({
            stream,
            text:
              decoders
                .get(stream)
                ?.decode(Uint8Array.from(bytes), { stream: true }) ?? "",
          }));
          if (done)
            for (const [stream, decoder] of decoders) {
              const text = decoder.decode();
              if (text) output.push({ stream, text });
            }
          setRun(
            (previous) =>
              previous && {
                ...previous,
                phase: !done && request.stop ? "stopping" : update.phase,
                elapsedMs: update.elapsedMs,
                exitCode: update.exitCode,
                cancelled: update.cancelled,
                truncated: update.truncated,
                output: appendOutput(previous.output, output),
                error: update.error
                  ? executionErrorMessage(update.error)
                  : undefined,
              },
          );
          if (done) {
            current.current = undefined;
            setBusy(false);
          } else
            request.timer = setTimeout(
              () => void poll(),
              update.output.length ? 0 : 75,
            );
        } catch (error) {
          fail(error);
        }
      }
      await poll();
    } catch (error) {
      fail(error);
    }
  }

  async function stop() {
    const request = current.current;
    if (!request || request.stop) return;
    request.stop = true;
    setRun((previous) => previous && { ...previous, phase: "stopping" });
    if (!request.id) return;
    try {
      await stopExecution(request.id);
    } catch (error) {
      if (current.current !== request) return;
      request.stop = false;
      setRun(
        (previous) =>
          previous && { ...previous, error: executionErrorMessage(error) },
      );
    }
  }

  return { run, busy, start, stop };
}

/* global window, document, performance, requestAnimationFrame, setTimeout, clearTimeout, cancelAnimationFrame, KeyboardEvent, TextUpdateEvent */
// Installed only in native performance harness windows.
(function () {
  "use strict";
  if (window.top !== window) return;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  function nextPaint() {
    return new Promise(function (resolve) {
      const frame = requestAnimationFrame(function () {
        clearTimeout(deadline);
        setTimeout(() => resolve(true), 0);
      });
      const deadline = setTimeout(() => {
        cancelAnimationFrame(frame);
        resolve(false);
      }, 250);
    });
  }

  async function waitFor(what, predicate, timeoutMs) {
    var end = performance.now() + (timeoutMs || 30000);
    for (;;) {
      var value = predicate();
      if (value) return value;
      if (performance.now() > end)
        throw new Error("timed out waiting for " + what);
      await sleep(1);
    }
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  function menuItem(menu, label) {
    var panel = document.querySelector(
      '[role="menu"][aria-label="' + menu + ' actions"]',
    );
    if (!panel) return null;
    var items = panel.querySelectorAll('[role="menuitem"]');
    for (var i = 0; i < items.length; i++) {
      var span = items[i].querySelector("span");
      if (span && span.textContent === label) return items[i];
    }
    return null;
  }

  async function runMenu(menu, label) {
    var triggers = document.querySelectorAll(
      '[role="menubar"] [data-menu-trigger]',
    );
    var trigger = null;
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].textContent === menu) trigger = triggers[i];
    }
    if (!trigger) throw new Error("menu " + menu + " is missing");
    if (!menuItem(menu, label)) trigger.click();
    var item = await waitFor(
      "menu item " + label,
      function () {
        var found = menuItem(menu, label);
        return found && found.getAttribute("aria-disabled") !== "true"
          ? found
          : null;
      },
      10000,
    );
    item.click();
  }

  function treeRow(path) {
    var row = document.querySelector(
      'button.tree-row[data-path="' + path + '"]',
    );
    return row && !row.disabled ? row : null;
  }

  function activeTab() {
    // The tablist owns its tabs through aria-owns; they are not descendants.
    var list = document.querySelector(
      '[role="tablist"][aria-label="Open files"]',
    );
    var ids = list ? (list.getAttribute("aria-owns") || "").split(" ") : [];
    for (var i = 0; i < ids.length; i++) {
      var tab = ids[i] && document.getElementById(ids[i]);
      if (tab && tab.getAttribute("aria-selected") === "true")
        return tab.getAttribute("aria-label");
    }
    return null;
  }

  function viewText() {
    var lines = document.querySelector(".monaco-editor .view-lines");
    // Monaco renders spaces as non-breaking spaces.
    return lines ? lines.textContent.replaceAll("\u00a0", " ") : "";
  }

  function cursorText() {
    var spans = document.querySelectorAll(".status-detail span");
    for (var i = 0; i < spans.length; i++) {
      var match = /^Ln (\d+), Col (\d+)$/.exec(spans[i].textContent.trim());
      if (match) return { line: Number(match[1]), column: Number(match[2]) };
    }
    return null;
  }

  /** Monaco's input element: an EditContext host on Chromium, else a textarea. */
  function editorInput() {
    var host = document.querySelector(".monaco-editor");
    if (!host) return null;
    var native = host.querySelector(".native-edit-context");
    if (native && native.editContext)
      return { kind: "editContext", element: native };
    var area = host.querySelector("textarea.inputarea");
    return area ? { kind: "textarea", element: area } : null;
  }

  function insert(input, text) {
    if (input.kind === "editContext") {
      var context = input.element.editContext;
      var start = context.selectionStart;
      var end = context.selectionEnd;
      context.updateText(start, end, text);
      context.updateSelection(start + text.length, start + text.length);
      var event = new TextUpdateEvent("textupdate", {
        text: text,
        updateRangeStart: start,
        updateRangeEnd: end,
        selectionStart: start + text.length,
        selectionEnd: start + text.length,
      });
      context.dispatchEvent(event);
      return;
    }
    if (document.activeElement !== input.element) input.element.focus();
    if (!document.execCommand("insertText", false, text)) {
      throw new Error("the editor input rejected scripted text");
    }
  }

  async function openTimed(path, marker) {
    const row = await waitFor("Explorer row " + path, () => treeRow(path));
    const started = performance.now();
    row.click();
    await waitFor(
      path + " in the editor",
      () =>
        activeTab() === path && viewText().includes(marker) && editorInput(),
    ).catch((error) => {
      throw new Error(
        error.message +
          " (active tab: " +
          JSON.stringify(activeTab()) +
          ", view text: " +
          JSON.stringify(viewText().slice(0, 40)) +
          ", input: " +
          (editorInput() ? editorInput().kind : "none") +
          ")",
      );
    });
    if (!(await nextPaint())) throw new Error("no frame after opening " + path);
    return round(performance.now() - started);
  }

  const text = "quick brown fox jumps over the lazy dog ".repeat(4).trimEnd();

  async function typeBurst(path) {
    const input = editorInput();
    input.element.focus();
    await waitFor(
      "editor focus",
      // Only the page's active element matters for scripted input; OS window
      // focus is not guaranteed for a background launch.
      () => document.activeElement === input.element,
    );
    const started = performance.now();
    for (const char of text) insert(input, char);
    const dispatchMs = round(performance.now() - started);
    const painted = await nextPaint();
    const elapsedMs = round(performance.now() - started);
    await waitFor(
      "the typed text in Monaco",
      () =>
        cursorText()?.column === text.length + 1 && viewText().includes(text),
    );
    await runMenu("File", "Save");
    await waitFor("the saved " + path, () => activeTab() === path);
    return { dispatchMs, elapsedMs, painted };
  }

  async function editorTask() {
    await runMenu("File", "Open Folder");
    const largeFileOpenMs = await openTimed(
      "large.txt",
      "Turing large document",
    );
    await openTimed("typing.txt", "");
    const plain = await typeBurst("typing.txt");
    await openTimed("large.txt", "Turing large document");

    await runMenu("Go", "Go to Symbol in Workspace…");
    const picker = await waitFor("a confirmed in-progress symbol scan", () => {
      const dialog = document.querySelector(
        'dialog[aria-label="Go to Symbol in Workspace"]',
      );
      return (
        dialog?.querySelector('[role="status"]')?.textContent ===
          "Indexing workspace symbols…" && dialog
      );
    });
    picker.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    const loaded = await typeBurst("large.txt");

    return {
      largeFileOpenMs,
      typingBurstMs: plain.elapsedMs,
      typingDispatchMs: plain.dispatchMs,
      typingUnderLoadMs: loaded.elapsedMs,
      typingUnderLoadDispatchMs: loaded.dispatchMs,
      typingFrameTimeouts: Number(!plain.painted) + Number(!loaded.painted),
    };
  }

  window.addEventListener(
    "turing-perf-editor",
    () => {
      editorTask().then(
        (result) => {
          document.title = "__turing_perf__" + JSON.stringify({ result });
        },
        (error) => {
          document.title =
            "__turing_perf__" + JSON.stringify({ error: String(error) });
        },
      );
    },
    { once: true },
  );
})();

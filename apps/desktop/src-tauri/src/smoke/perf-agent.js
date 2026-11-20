/* global window, document, performance, requestAnimationFrame, setTimeout, TextUpdateEvent */
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
      requestAnimationFrame(function () {
        setTimeout(resolve, 0);
      });
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
    var tab = document.querySelector(
      '[role="tablist"][aria-label="Open files"] [role="tab"][aria-selected="true"]',
    );
    return tab ? tab.getAttribute("aria-label") : null;
  }

  function viewText() {
    var lines = document.querySelector(".monaco-editor .view-lines");
    return lines ? lines.textContent : "";
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
    );
    await nextPaint();
    return round(performance.now() - started);
  }

  async function editorTask() {
    await runMenu("File", "Open Folder");
    const largeFileOpenMs = await openTimed(
      "large.txt",
      "Turing large document",
    );
    await openTimed("typing.txt", "");
    const input = editorInput();
    input.element.focus();
    const text = "quick brown fox jumps over the lazy dog ".repeat(4).trimEnd();
    const started = performance.now();
    for (const char of text) insert(input, char);
    await nextPaint();
    const typingBurstMs = round(performance.now() - started);
    await waitFor(
      "the typed text in Monaco",
      () =>
        cursorText()?.column === text.length + 1 &&
        viewText().replaceAll("\u00a0", " ").includes(text),
    );
    await runMenu("File", "Save");
    await waitFor(
      "the typing document to save",
      () => activeTab() === "typing.txt",
    );
    return { largeFileOpenMs, typingBurstMs };
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

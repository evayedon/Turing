import { describe, expect, it } from "vitest";
import {
  documentLanguage,
  executableLanguage,
  languageFromName,
} from "./languages";

describe("document languages", () => {
  it.each([
    ["hello.PY", "python"],
    ["main.c", "c"],
    ["main.cpp", "cpp"],
    ["component.jsx", "jsx"],
    ["index.tsx", "tsx"],
    ["Dockerfile", "dockerfile"],
    [".bashrc", "shell"],
    ["styles.css", "css"],
    ["schema.proto", "proto"],
    ["page.html", "html"],
    ["settings.json", "json"],
    ["ci.yml", "yaml"],
    ["query.sql", "sql"],
    ["message.xml", "xml"],
    ["Main.java", "java"],
    ["main.go", "go"],
    ["lib.rs", "rust"],
    ["notes.md", "markdown"],
  ])("identifies %s as %s", (name, language) => {
    expect(languageFromName(name).id).toBe(language);
  });

  it("suggests a mode only for strong untitled evidence and honors an override", () => {
    const untitled = { name: "Untitled-1", source: { kind: "untitled" } };
    const python = { ...untitled, draft: "def hello():\n    pass" };
    expect(documentLanguage(python).id).toBe("python");
    expect(
      documentLanguage({ ...python, languageOverride: "markdown" }).id,
    ).toBe("markdown");
    expect(documentLanguage({ ...untitled, draft: 'print("hi")' }).id).toBe(
      "plaintext",
    );
    expect(
      documentLanguage({
        ...python,
        source: { kind: "workspace" },
        name: "file.txt",
      }).id,
    ).toBe("plaintext");
  });

  it("limits execution to supported saved extensions independently of syntax", () => {
    expect(executableLanguage("app.py")).toBe("python");
    expect(executableLanguage("app.CXX")).toBe("cpp");
    expect(executableLanguage("app.h")).toBeUndefined();
    expect(executableLanguage("app.pyi")).toBeUndefined();
    expect(executableLanguage("Untitled-1")).toBeUndefined();
  });
});

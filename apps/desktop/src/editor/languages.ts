import type { ExecutionLanguage } from "@turing/contracts";

type Language = {
  id: string;
  label: string;
  extensions?: readonly string[];
  filenames?: readonly string[];
  monaco?: string;
};

// Filename metadata mirrors the bundled Monaco 0.57 contributions. Keep it
// lightweight so the workbench can identify documents before loading Monaco.
const definitions = [
  ["plaintext", "Plain Text", "txt"],
  ["abap", "abap", "abap"],
  ["aes", "aes", "aes"],
  ["apex", "Apex", "cls"],
  ["postiats", "ATS", "dats sats hats"],
  ["azcli", "Azure CLI", "azcli"],
  ["bat", "Batch", "bat cmd"],
  ["bicep", "Bicep", "bicep"],
  ["c", "C", "c h"],
  ["csharp", "C#", "cs csx cake"],
  ["cpp", "C++", "cpp cc cxx hpp hh hxx"],
  ["cameligo", "Cameligo", "mligo"],
  ["clojure", "clojure", "clj cljs cljc edn"],
  ["coffeescript", "CoffeeScript", "coffee"],
  ["csp", "CSP", "csp"],
  ["css", "CSS", "css"],
  ["cypher", "Cypher", "cypher cyp"],
  ["dart", "Dart", "dart"],
  ["msdax", "DAX", "dax msdax"],
  ["dockerfile", "Dockerfile", "dockerfile", "dockerfile containerfile"],
  ["ecl", "ECL", "ecl"],
  ["elixir", "Elixir", "ex exs"],
  ["fsharp", "F#", "fs fsi ml mli fsx fsscript"],
  ["flow9", "Flow9", "flow"],
  ["freemarker2", "FreeMarker2", "ftl ftlh ftlx"],
  [
    "freemarker2.tag-angle.interpolation-bracket",
    "FreeMarker2 (Angle/Bracket)",
    "",
  ],
  [
    "freemarker2.tag-angle.interpolation-dollar",
    "FreeMarker2 (Angle/Dollar)",
    "",
  ],
  [
    "freemarker2.tag-auto.interpolation-bracket",
    "FreeMarker2 (Auto/Bracket)",
    "",
  ],
  [
    "freemarker2.tag-auto.interpolation-dollar",
    "FreeMarker2 (Auto/Dollar)",
    "",
  ],
  [
    "freemarker2.tag-bracket.interpolation-bracket",
    "FreeMarker2 (Bracket/Bracket)",
    "",
  ],
  [
    "freemarker2.tag-bracket.interpolation-dollar",
    "FreeMarker2 (Bracket/Dollar)",
    "",
  ],
  ["go", "Go", "go"],
  ["graphql", "GraphQL", "graphql gql"],
  ["handlebars", "Handlebars", "handlebars hbs"],
  ["html", "HTML", "html htm shtml xhtml mdoc jsp asp aspx jshtm"],
  [
    "ini",
    "INI / TOML",
    "ini properties gitconfig toml",
    "config .gitattributes .gitconfig .editorconfig .editorconfig .gitconfig",
  ],
  ["java", "Java", "java jav"],
  ["javascript", "JavaScript", "js es6 mjs cjs mjs cjs", "jakefile"],
  ["jsx", "JavaScript JSX", "jsx"],
  ["json", "JSON", "json jsonc", ".eslintrc .babelrc"],
  ["julia", "julia", "jl"],
  ["kotlin", "Kotlin", "kt kts"],
  ["less", "Less", "less"],
  ["lexon", "Lexon", "lex"],
  ["liquid", "Liquid", "liquid html.liquid"],
  ["lua", "Lua", "lua"],
  ["markdown", "Markdown", "md markdown mdown mkdn mkd mdwn mdtxt mdtext"],
  ["mdx", "MDX", "mdx"],
  ["mips", "MIPS", "s"],
  ["m3", "Modula-3", "m3 i3 mg ig"],
  ["mysql", "MySQL", ""],
  ["objective-c", "Objective-C", "m"],
  ["pascal", "Pascal", "pas p pp"],
  ["pascaligo", "Pascaligo", "ligo"],
  ["perl", "Perl", "pl pm"],
  ["php", "PHP", "php php4 php5 phtml ctp"],
  ["pla", "pla", "pla"],
  ["pgsql", "PostgreSQL", ""],
  ["powershell", "PowerShell", "ps1 psm1 psd1"],
  ["powerquery", "PQ", "pq pqm"],
  ["proto", "protobuf", "proto"],
  ["pug", "Pug", "jade pug"],
  ["python", "Python", "py rpy pyw cpy gyp gypi pyi"],
  ["qsharp", "Q#", "qs"],
  ["r", "R", "r rhistory rmd rprofile rt"],
  ["razor", "Razor", "cshtml"],
  ["redis", "redis", "redis"],
  ["redshift", "Redshift", ""],
  ["restructuredtext", "reStructuredText", "rst"],
  ["ruby", "Ruby", "rb rbx rjs gemspec pp", "rakefile gemfile"],
  ["rust", "Rust", "rs rlib"],
  ["scss", "Sass", "scss"],
  ["scala", "Scala", "scala sc sbt"],
  ["scheme", "scheme", "scm ss sch rkt"],
  ["shell", "Shell", "sh bash fish", ".bashrc .zshrc .bash_profile .profile"],
  ["sb", "Small Basic", "sb"],
  ["sol", "sol", "sol"],
  ["sparql", "sparql", "rq"],
  ["sql", "SQL", "sql"],
  ["st", "StructuredText", "st iecst iecplc lc3lib tcpou tcdut tcgvl tcio"],
  ["systemverilog", "SV", "sv svh"],
  ["swift", "Swift", "swift"],
  ["tcl", "tcl", "tcl"],
  ["hcl", "Terraform", "tf tfvars hcl"],
  ["twig", "Twig", "twig"],
  ["typescript", "TypeScript", "ts cts mts mts cts"],
  ["tsx", "TypeScript TSX", "tsx"],
  ["typespec", "TypeSpec", "tsp"],
  ["verilog", "V", "v vh"],
  ["vb", "Visual Basic", "vb"],
  ["wgsl", "WebGPU Shading Language", "wgsl"],
  ["xml", "XML", "xml svg xsd xsl plist"],
  ["yaml", "YAML", "yaml yml"],
] as const;

export const languages: readonly Language[] = definitions.map(
  ([id, label, extensions, filenames]) => ({
    id,
    label,
    extensions: extensions?.split(/ +/),
    filenames: filenames?.split(/ +/),
    monaco:
      id === "jsx" ? "javascript" : id === "tsx" ? "typescript" : undefined,
  }),
);

const plaintext = languages[0];

function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function languageFromName(name: string): Language {
  const normalized = name.toLowerCase();
  const extension = extensionOf(name);
  // Uppercase .C is conventionally C++.
  if (name.endsWith(".C"))
    return languages.find(({ id }) => id === "cpp") ?? plaintext;
  return (
    languages.find(({ filenames }) => filenames?.includes(normalized)) ??
    languages.find(({ extensions }) => extensions?.includes(extension)) ??
    plaintext
  );
}

function suggestLanguage(draft: string) {
  const text = draft.slice(0, 8192);
  if (
    /^#![^\r\n]*\bpython(?:\d+(?:\.\d+)?)?\b/.test(text) ||
    /^(?:async +)?def +\w+\([^\n]*\)\s*(?:->[^:\n]+)?\s*:\s*\r?\n[ \t]+\S/m.test(
      text,
    ) ||
    /^from +[\w.]+ +import +\w+/m.test(text)
  )
    return "python";
  if (/^#![^\r\n]*\b(?:bash|zsh|fish|sh)\b/.test(text)) return "shell";
  if (/^\s*(?:<!doctype html\b|<html(?:\s|>))/i.test(text)) return "html";
  if (/^\s*<\?xml\b/.test(text)) return "xml";
  if (
    /^\s*#include\s*<[\w/]+>/.test(text) &&
    /\b(?:std::|using namespace )/.test(text)
  )
    return "cpp";
  if (
    (text.trimStart().startsWith("{") || text.trimStart().startsWith("[")) &&
    /"[^"]+"\s*:/.test(text) &&
    text.length === draft.length
  ) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      /* Incomplete or ambiguous. */
    }
  }
  return undefined;
}

export function documentLanguage(tab: {
  name: string;
  source: { kind: string };
  draft: string;
  languageOverride?: string;
}): Language {
  if (tab.languageOverride)
    return languages.find(({ id }) => id === tab.languageOverride) ?? plaintext;
  if (tab.source.kind !== "untitled") return languageFromName(tab.name);
  const suggested = suggestLanguage(tab.draft);
  return languages.find(({ id }) => id === suggested) ?? plaintext;
}

const runnableExtensions: ReadonlyMap<string, ExecutionLanguage> = new Map([
  ["py", "python"],
  ["cpp", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  ["c", "c"],
  ["rs", "rust"],
  ["go", "go"],
  ["java", "java"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["ts", "typescript"],
  ["mts", "typescript"],
  ["cts", "typescript"],
  ["cs", "csharp"],
]);

export function executableLanguage(
  name: string,
): ExecutionLanguage | undefined {
  const extension = extensionOf(name);
  return extension === "c" && name.endsWith(".C")
    ? "cpp"
    : runnableExtensions.get(extension);
}

export function suggestedFilename(tab: Parameters<typeof documentLanguage>[0]) {
  if (tab.source.kind !== "untitled") return tab.name;
  const language = documentLanguage(tab);
  const extension =
    language.id === "plaintext" ? undefined : language.extensions?.[0];
  return extension ? `${tab.name}.${extension}` : tab.name;
}

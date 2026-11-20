/// <reference types="vite/client" />

declare module "monaco-editor/languages/definitions/typescript/typescript.js" {
  export const conf: import("monaco-editor").languages.LanguageConfiguration;
  export const language: import("monaco-editor").languages.IMonarchLanguage;
}

declare module "monaco-editor/languages/definitions/javascript/javascript.js" {
  export const conf: import("monaco-editor").languages.LanguageConfiguration;
  export const language: import("monaco-editor").languages.IMonarchLanguage;
}

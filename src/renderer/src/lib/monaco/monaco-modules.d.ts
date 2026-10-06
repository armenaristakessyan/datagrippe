// Monaco ships no declarations for the Monarch grammar modules; only what grammar.ts uses is typed.
declare module 'monaco-editor/languages/definitions/pgsql/pgsql.js' {
  import type { languages } from 'monaco-editor/editor/editor.api.js'
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}

declare module 'monaco-editor/languages/definitions/sql/sql.js' {
  import type { languages } from 'monaco-editor/editor/editor.api.js'
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}

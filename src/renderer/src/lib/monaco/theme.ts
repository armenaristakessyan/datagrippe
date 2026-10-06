// Monaco themes built from the CSS design tokens (styles.css), so the editor matches the app in both themes.
import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import { cssColorToHex, tokenColor, withAlpha } from './colors'

export type ResolvedTheme = 'dark' | 'light'

export const MONACO_THEME: Record<ResolvedTheme, string> = {
  dark: 'datagrippe-dark',
  light: 'datagrippe-light',
}

const FALLBACK: Record<ResolvedTheme, Record<string, string>> = {
  dark: { surface: '#17191e', elevated: '#1d2026', fg: '#e7e9ee', muted: '#a0a6b2', subtle: '#6c7280', faint: '#4a4f5a', accent: '#7c8cff' },
  light: { surface: '#ffffff', elevated: '#ffffff', fg: '#171a21', muted: '#555c69', subtle: '#808794', faint: '#b3b8c1', accent: '#5465ff' },
}

/** Read a `--c-<name>` token from the document as #rrggbb[aa]. */
function token(styles: CSSStyleDeclaration, name: string, theme: ResolvedTheme, fallback = '#00000000'): string {
  const raw = styles.getPropertyValue(`--c-${name}`)
  return cssColorToHex(raw) ?? FALLBACK[theme][name] ?? fallback
}

function rules(entries: [token: string, color: string, fontStyle?: string][]): Monaco.editor.ITokenThemeRule[] {
  return entries.flatMap(([token, color, fontStyle]) => {
    const rule = { foreground: tokenColor(color), ...(fontStyle ? { fontStyle } : {}) }
    return token ? [{ token, ...rule }, { token: `${token}.sql`, ...rule }] : [{ token, ...rule }]
  })
}

export function buildTheme(theme: ResolvedTheme, styles: CSSStyleDeclaration): Monaco.editor.IStandaloneThemeData {
  const t = (name: string) => token(styles, name, theme)
  const surface = t('surface')
  const elevated = t('elevated')
  const fg = t('fg')
  const muted = t('muted')
  const subtle = t('subtle')
  const faint = t('faint')
  const accent = t('accent')
  const line = t('line')
  const lineStrong = t('line-strong')
  const hover = t('hover')
  const active = t('active')
  const selection = t('selection')
  const accentSoft = t('accent-soft')
  const danger = t('danger')
  const warning = t('warning')
  const info = t('info')
  const success = t('success')
  const input = t('input')
  const syn = {
    keyword: t('syn-keyword'),
    string: t('syn-string'),
    number: t('syn-number'),
    comment: t('syn-comment'),
    fn: t('syn-function'),
    operator: t('syn-operator'),
    type: t('syn-type'),
  }
  const transparent = '#00000000'

  return {
    base: theme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    // Both SQL grammars append ".sql" to token names, and the base themes style "string.sql",
    // "predefined.sql"…: every rule is declared with and without the postfix so ours win.
    rules: rules([
      ['', fg],
      ['keyword', syn.keyword],
      ['operator', syn.operator],
      ['string', syn.string],
      ['number', syn.number],
      ['comment', syn.comment, 'italic'],
      ['predefined', syn.fn],
      ['type', syn.type],
      ['identifier', fg],
      ['identifier.quote', fg],
      ['delimiter', muted],
      ['delimiter.parenthesis', muted],
      ['delimiter.square', muted],
    ]),
    colors: {
      focusBorder: withAlpha(accent, 0.5),
      foreground: fg,
      'widget.shadow': theme === 'dark' ? '#00000080' : '#0f121826',
      'widget.border': lineStrong,
      'editor.background': surface,
      'editor.foreground': fg,
      'editorGutter.background': surface,
      'editorLineNumber.foreground': faint,
      'editorLineNumber.activeForeground': muted,
      'editor.lineHighlightBackground': withAlpha(hover, 0.8),
      'editor.lineHighlightBorder': transparent,
      'editor.selectionBackground': selection,
      'editor.inactiveSelectionBackground': withAlpha(selection, 0.55),
      'editor.selectionHighlightBackground': withAlpha(accentSoft, 0.7),
      'editor.wordHighlightBackground': withAlpha(accentSoft, 0.6),
      'editor.wordHighlightStrongBackground': withAlpha(accentSoft, 0.9),
      'editor.findMatchBackground': withAlpha(warning, 0.35),
      'editor.findMatchHighlightBackground': withAlpha(warning, 0.18),
      'editor.findRangeHighlightBackground': withAlpha(accentSoft, 0.5),
      'editorCursor.foreground': accent,
      'editorWhitespace.foreground': withAlpha(faint, 0.6),
      'editorIndentGuide.background1': line,
      'editorIndentGuide.activeBackground1': lineStrong,
      'editorBracketMatch.background': accentSoft,
      'editorBracketMatch.border': transparent,
      'editorBracketHighlight.foreground1': muted,
      'editorBracketHighlight.foreground2': muted,
      'editorBracketHighlight.foreground3': muted,
      'editorOverviewRuler.border': transparent,
      'editorOverviewRuler.errorForeground': danger,
      'editorOverviewRuler.warningForeground': warning,
      'editorError.foreground': danger,
      'editorWarning.foreground': warning,
      'editorInfo.foreground': info,
      'editorRuler.foreground': line,
      'editorCodeLens.foreground': subtle,
      'editorGhostText.foreground': faint,
      'editorLink.activeForeground': accent,
      'editorWidget.background': elevated,
      'editorWidget.foreground': fg,
      'editorWidget.border': lineStrong,
      'editorWidget.resizeBorder': accent,
      'editorSuggestWidget.background': elevated,
      'editorSuggestWidget.border': lineStrong,
      'editorSuggestWidget.foreground': fg,
      'editorSuggestWidget.selectedBackground': active,
      'editorSuggestWidget.selectedForeground': fg,
      'editorSuggestWidget.selectedIconForeground': fg,
      'editorSuggestWidget.highlightForeground': accent,
      'editorSuggestWidget.focusHighlightForeground': accent,
      'editorSuggestWidgetStatus.foreground': subtle,
      'editorHoverWidget.background': elevated,
      'editorHoverWidget.foreground': fg,
      'editorHoverWidget.border': lineStrong,
      'editorHoverWidget.statusBarBackground': elevated,
      'editorMarkerNavigation.background': elevated,
      'editorMarkerNavigationError.background': danger,
      'editorStickyScroll.background': surface,
      'input.background': input,
      'input.foreground': fg,
      'input.border': line,
      'input.placeholderForeground': faint,
      'inputOption.activeBorder': accent,
      'inputOption.activeBackground': accentSoft,
      'inputOption.activeForeground': fg,
      'inputValidation.errorBackground': elevated,
      'inputValidation.errorBorder': danger,
      'list.hoverBackground': hover,
      'list.activeSelectionBackground': active,
      'list.activeSelectionForeground': fg,
      'list.inactiveSelectionBackground': hover,
      'list.focusBackground': active,
      'list.focusForeground': fg,
      'list.highlightForeground': accent,
      'list.focusOutline': transparent,
      'menu.background': elevated,
      'menu.foreground': fg,
      'menu.border': lineStrong,
      'menu.selectionBackground': active,
      'menu.selectionForeground': fg,
      'menu.separatorBackground': line,
      'quickInput.background': elevated,
      'quickInput.foreground': fg,
      'scrollbar.shadow': transparent,
      'scrollbarSlider.background': lineStrong,
      'scrollbarSlider.hoverBackground': withAlpha(faint, 0.8),
      'scrollbarSlider.activeBackground': faint,
      'minimap.background': surface,
      'minimapSlider.background': withAlpha(lineStrong, 0.6),
      'minimapSlider.hoverBackground': lineStrong,
      'textLink.foreground': accent,
      'textCodeBlock.background': input,
      'textPreformat.foreground': fg,
      'textBlockQuote.background': input,
      'descriptionForeground': subtle,
      'icon.foreground': muted,
      'toolbar.hoverBackground': hover,
      // suggest widget icons
      'symbolIcon.fieldForeground': syn.fn,
      'symbolIcon.structForeground': syn.type,
      'symbolIcon.classForeground': syn.type,
      'symbolIcon.interfaceForeground': syn.string,
      'symbolIcon.moduleForeground': muted,
      'symbolIcon.functionForeground': syn.keyword,
      'symbolIcon.methodForeground': syn.keyword,
      'symbolIcon.keywordForeground': subtle,
      'symbolIcon.variableForeground': syn.number,
      'symbolIcon.typeParameterForeground': syn.type,
      'symbolIcon.referenceForeground': success,
    },
  }
}

/** (Re)define the theme for `resolved` from the current CSS tokens and apply it. */
export function applyMonacoTheme(monaco: typeof Monaco, resolved: ResolvedTheme): void {
  const styles = getComputedStyle(document.documentElement)
  monaco.editor.defineTheme(MONACO_THEME[resolved], buildTheme(resolved, styles))
  monaco.editor.setTheme(MONACO_THEME[resolved])
}

#!/usr/bin/env bun

import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHighlighter } from 'shiki'
import type { Highlighter } from 'shiki'
import { renderMermaidASCII } from './index.ts'
import { diagramColorsToAsciiTheme } from './ascii/index.ts'
import { THEMES } from './theme.ts'
import type { ThemeName, DiagramColors } from './theme.ts'

const require = createRequire(import.meta.url)
const PACKAGE_VERSION = String(require('../package.json').version)

const ANSI_RESET = '\x1b[0m'
const ANSI_BOLD = '\x1b[1m'
const ANSI_DIM = '\x1b[2m'
const ANSI_ITALIC = '\x1b[3m'
const ANSI_UNDERLINE = '\x1b[4m'
const ANSI_STRIKE = '\x1b[9m'
const OSC = '\x1b]'
const ST = '\x1b\\'

const EMOJI_REGEX = /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u
const ANSI_REGEX = /\x1B\[[0-9;?]*[ -/]*[@-~]/g
const OSC_HYPERLINK_REGEX = /\x1b]8;;[^\x1b]*\x1b\\|\x1b]8;;\x1b\\/g
const PLAIN_CODE_LANGS = new Set(['', 'text', 'txt', 'plain', 'plaintext'])
const CODE_LANG_ALIASES: Record<string, string> = {
  cjs: 'javascript',
  console: 'bash',
  docker: 'dockerfile',
  js: 'javascript',
  jsx: 'jsx',
  md: 'markdown',
  mts: 'typescript',
  sh: 'bash',
  shell: 'bash',
  text: 'text',
  ts: 'typescript',
  tsx: 'tsx',
  yml: 'yaml',
  zsh: 'bash',
}

const DEFAULT_THEME_NAME: ThemeName = 'catppuccin-mocha'

function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const normalized = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) {
    throw new Error(`Invalid hex color: ${hex}`)
  }
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  }
}

function mixHex(fg: string, bg: string, pct: number): string {
  const front = parseHexColor(fg)
  const back = parseHexColor(bg)
  const mix = (a: number, z: number) => Math.round(a * (pct / 100) + z * (1 - pct / 100))
  const r = mix(front.r, back.r)
  const g = mix(front.g, back.g)
  const b = mix(front.b, back.b)
  return `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
}

function buildCliColors(colors: DiagramColors) {
  return {
    text: colors.fg,
    textMuted: colors.muted ?? mixHex(colors.fg, colors.bg, 75),
    inlineCode: colors.fg,
    bold: colors.accent ?? colors.fg,
    italic: colors.line ?? mixHex(colors.fg, colors.bg, 80),
    strike: colors.muted ?? mixHex(colors.fg, colors.bg, 45),
    link: colors.accent ?? mixHex(colors.fg, colors.bg, 92),
    linkUrl: colors.line ?? colors.accent ?? mixHex(colors.fg, colors.bg, 88),
    heading1: colors.accent ?? colors.fg,
    heading1Rule: colors.muted ?? mixHex(colors.fg, colors.bg, 55),
    heading2: colors.accent ?? colors.fg,
    heading2Rule: colors.muted ?? mixHex(colors.fg, colors.bg, 65),
    heading3: colors.accent ?? colors.fg,
    heading4: colors.accent ?? colors.fg,
    rule: colors.border ?? colors.line ?? mixHex(colors.fg, colors.bg, 25),
    listMarker: colors.accent ?? colors.line ?? colors.fg,
    quoteBar: colors.muted ?? mixHex(colors.fg, colors.bg, 45),
    quoteText: colors.fg,
    tableBorder: colors.border ?? colors.line ?? mixHex(colors.fg, colors.bg, 35),
    tableHeader: colors.line ?? colors.fg,
    tableText: colors.fg,
  } as const
}

function setCliTheme(themeName: ThemeName): void {
  currentThemeName = themeName
  cliColors = buildCliColors(THEMES[themeName])
}

let highlighterPromise: Promise<Highlighter> | null = null
let currentThemeName: ThemeName = DEFAULT_THEME_NAME
let cliColors = buildCliColors(THEMES[DEFAULT_THEME_NAME])

type CliColorMode = 'auto' | 'always' | 'never'
type CliHyperlinkMode = 'auto' | 'always' | 'never'
type MermaidMode = 'render' | 'source'

export interface MdvCliOptions {
  inputFile?: string
  noStyle?: boolean
  noMermaid?: boolean
  mermaid?: MermaidMode
  help?: boolean
  version?: boolean
  doctor?: boolean
  theme?: ThemeName
  listThemes?: boolean
  previewThemes?: boolean
  color?: CliColorMode
  hyperlinks?: CliHyperlinkMode
}

export interface RenderMarkdownOptions {
  useColor?: boolean
  width?: number
  useHyperlinks?: boolean
}

export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

function isThemeName(value: string): value is ThemeName {
  return value in THEMES
}

function unknownThemeMessage(theme: string): string {
  return `Unknown theme: ${theme}. Run "mdv themes" to see available themes.`
}

function unknownOptionMessage(option: string): string {
  return `Unknown option: ${option}. Run "mdv --help" for usage.`
}

function resolveCliColorMode(mode: CliColorMode | undefined): CliColorMode {
  return mode ?? 'auto'
}

function resolveCliHyperlinkMode(mode: CliHyperlinkMode | undefined): CliHyperlinkMode {
  return mode ?? 'auto'
}

function shouldUseColor(mode: CliColorMode, stdoutIsTTY: boolean): boolean {
  if (mode === 'never') return false
  if (mode === 'always') return true
  const forceColor = Number.parseInt(process.env.FORCE_COLOR ?? '0', 10) > 0
  return stdoutIsTTY || forceColor
}

function shouldUseHyperlinks(mode: CliHyperlinkMode, stdoutIsTTY: boolean): boolean {
  if (mode === 'never') return false
  if (mode === 'always') return true
  if (!stdoutIsTTY) return false
  if ((process.env.CI ?? '').length > 0) return false

  const termProgram = process.env.TERM_PROGRAM ?? ''
  const term = process.env.TERM ?? ''

  if (
    (process.env.WT_SESSION ?? '').length > 0 ||
    (process.env.KONSOLE_VERSION ?? '').length > 0 ||
    (process.env.VTE_VERSION ?? '').length > 0 ||
    (process.env.DOMTERM ?? '').length > 0
  ) {
    return true
  }

  if (['iTerm.app', 'WezTerm', 'vscode', 'Hyper', 'ghostty', 'Tabby'].includes(termProgram)) {
    return true
  }

  if (term.includes('xterm-kitty') || term.includes('foot') || term.includes('wezterm')) {
    return true
  }

  if ((process.env.TMUX ?? '').length > 0) {
    return (
      (process.env.WT_SESSION ?? '').length > 0 ||
      (process.env.KONSOLE_VERSION ?? '').length > 0 ||
      (process.env.VTE_VERSION ?? '').length > 0 ||
      ['iTerm.app', 'WezTerm', 'vscode', 'Hyper', 'ghostty', 'Tabby'].includes(termProgram)
    )
  }

  return false
}

function ansiWrap(text: string, open: string, enabled: boolean): string {
  if (!enabled || text.length === 0) return text
  return `${open}${text}${ANSI_RESET}`
}

function hexToAnsi(hex: string | undefined, enabled: boolean): string {
  if (!enabled || !hex) return ''
  const normalized = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return ''
  const r = Number.parseInt(normalized.slice(0, 2), 16)
  const g = Number.parseInt(normalized.slice(2, 4), 16)
  const b = Number.parseInt(normalized.slice(4, 6), 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

function fg(text: string, color: string | undefined, enabled: boolean): string {
  if (!enabled || !color || text.length === 0) return text
  return `${hexToAnsi(color, enabled)}${text}${ANSI_RESET}`
}

function tintText(text: string, color: string | undefined, enabled: boolean): string {
  if (!enabled || !color || text.length === 0) return text
  const prefix = hexToAnsi(color, true)
  if (!prefix) return text
  return `${prefix}${text.replaceAll(ANSI_RESET, `${ANSI_RESET}${prefix}`)}${ANSI_RESET}`
}

function style(text: string, color: string | undefined, enabled: boolean, ...opens: string[]): string {
  if (!enabled || text.length === 0) return text
  let result = text
  for (const open of opens) {
    result = ansiWrap(result, open, true)
  }
  return fg(result, color, true)
}

function stripAnsi(text: string): string {
  return text.replace(OSC_HYPERLINK_REGEX, '').replace(ANSI_REGEX, '')
}

function hyperlink(text: string, url: string, enabled: boolean): string {
  if (!enabled || text.length === 0 || url.length === 0) return text
  return `${OSC}8;;${url}${ST}${text}${OSC}8;;${ST}`
}

function charWidth(ch: string): number {
  if (ch.length === 0) return 0
  const code = ch.codePointAt(0)
  if (code === undefined) return 0
  if (EMOJI_REGEX.test(ch)) return 2
  if (
    (code >= 0x0300 && code <= 0x036f) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  ) {
    return 0
  }
  if (
    (code >= 0x2605 && code <= 0x2606) ||
    (code >= 0x2610 && code <= 0x2612) ||
    (code >= 0x25cb && code <= 0x25cf) ||
    (code >= 0x2713 && code <= 0x2717)
  ) {
    return 2
  }
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x2fff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0x3100 && code <= 0x312f) ||
    (code >= 0x3130 && code <= 0x318f) ||
    (code >= 0x3190 && code <= 0x31ff) ||
    (code >= 0x3200 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x20000
  ) {
    return 2
  }
  return 1
}

function stringWidth(text: string): number {
  let width = 0
  for (const ch of stripAnsi(text)) {
    width += charWidth(ch)
  }
  return width
}

function padDisplayEnd(text: string, width: number): string {
  const pad = Math.max(0, width - stringWidth(text))
  return `${text}${' '.repeat(pad)}`
}

function padDisplayStart(text: string, width: number): string {
  const pad = Math.max(0, width - stringWidth(text))
  return `${' '.repeat(pad)}${text}`
}

function truncateDisplayText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  if (maxWidth === 1) return '…'
  let result = ''
  let width = 0
  for (const ch of text) {
    const chWidth = charWidth(ch)
    if (width + chWidth > maxWidth - 1) break
    result += ch
    width += chWidth
  }
  return `${result}…`
}

function indentBlock(text: string, indent: string): string {
  return text.split('\n').map(line => `${indent}${line}`).join('\n')
}

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

function isFenceStart(line: string): boolean {
  return /^```/.test(line.trim())
}

function isHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line)
}

function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim()
  return /^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)
}

function isBlockquote(line: string): boolean {
  return /^>\s?/.test(line.trimStart())
}

function isListItem(line: string): boolean {
  return /^(\s*)([-+*]|\d+\.)\s+/.test(line)
}

function isIndentedContinuation(line: string): boolean {
  return /^\s{2,}\S/.test(line)
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line)
}

function isTableDivider(line: string): boolean {
  if (!isTableRow(line)) return false
  const cells = parseTableRow(line)
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell))
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let current = ''
  let inCodeSpan = false
  let isEscaped = false

  for (const ch of trimmed) {
    if (isEscaped) {
      current += ch
      isEscaped = false
      continue
    }
    if (ch === '\\') {
      current += ch
      isEscaped = true
      continue
    }
    if (ch === '`') {
      inCodeSpan = !inCodeSpan
      current += ch
      continue
    }
    if (ch === '|' && !inCodeSpan) {
      cells.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }

  cells.push(current.trim())
  return cells
}

function compactUrl(url: string, maxLength = 36): string {
  if (url.length <= maxLength) return url
  try {
    const parsed = new URL(url)
    const compact = `${parsed.hostname}${parsed.pathname}`
    if (compact.length <= maxLength) return compact
  } catch {
    // Fall back to generic truncation for non-URL values.
  }
  return `${url.slice(0, Math.max(0, maxLength - 1))}…`
}

function normalizeTerminalSymbols(text: string): string {
  return text
    .replace(/☒/g, '[x]')
    .replace(/☑/g, '[x]')
    .replace(/☐/g, '[ ]')
}

function isNumericCell(text: string): boolean {
  return /^[-+]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?%?$/.test(text.trim())
}

function blockquoteDepth(line: string): number {
  const match = line.match(/^(\s*(?:>\s*)+)/)
  return match ? (match[1].match(/>/g)?.length ?? 0) : 0
}

function parseTaskMarker(text: string): { checked: boolean; body: string } | null {
  const match = text.match(/^\[([ xX])\]\s+(.*)$/)
  if (!match) return null
  return { checked: match[1]!.toLowerCase() === 'x', body: match[2] ?? '' }
}

function renderInline(text: string, useColor: boolean, useHyperlinks = false): string {
  const placeholders: string[] = []
  const stash = (value: string) => {
    const idx = placeholders.push(value) - 1
    return `\u0000${idx}\u0000`
  }

  const styledText = normalizeTerminalSymbols(normalizeNewlines(text))
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (full: string) => stash(full))
    .replace(/`([^`]+)`/g, (_, code: string) => {
      if (!useColor) return stash(code)
      const body = ` ${code} `
      return stash(`${fg(body, cliColors.inlineCode, true)}`)
    })
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label: string, url: string) => {
      const compact = compactUrl(url)
      const plain = `${label} (${compact})`
      if (!useColor) return stash(plain)
      const linkedLabel = hyperlink(style(label, cliColors.link, true, ANSI_UNDERLINE), url, useHyperlinks)
      return stash(`${linkedLabel}${fg(` (${compact})`, cliColors.linkUrl, true)}`)
    })
    .replace(/\*\*([^*]+)\*\*/g, (_, value: string) => stash(style(value, undefined, useColor, ANSI_BOLD)))
    .replace(/__([^_]+)__/g, (_, value: string) => stash(style(value, undefined, useColor, ANSI_BOLD)))
    .replace(/~~([^~]+)~~/g, (_, value: string) => stash(style(value, cliColors.strike, useColor, ANSI_STRIKE)))
    .replace(/(^|[^\*])\*([^*\n]+)\*(?!\*)/g, (_, prefix: string, value: string) => `${prefix}${stash(style(value, cliColors.italic, useColor, ANSI_ITALIC))}`)
    .replace(/(^|[^\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, (_, prefix: string, value: string) => `${prefix}${stash(style(value, cliColors.italic, useColor, ANSI_ITALIC))}`)

  let restored = styledText
  for (let i = 0; i <= placeholders.length; i += 1) {
    if (!/\u0000\d+\u0000/.test(restored)) break
    restored = restored.replace(/\u0000(\d+)\u0000/g, (_, idx: string) => placeholders[Number(idx)] ?? '')
  }

  return restored
}

function renderHeading(line: string, width: number, useColor: boolean): string {
  const match = line.match(/^(#{1,6})\s+(.*)$/)
  if (!match) return renderInline(line, useColor)

  const level = (match[1] ?? '#').length
  const text = renderInline(match[2] ?? '', useColor, false)
  if (!useColor) return `${'#'.repeat(level)} ${stripAnsi(text)}`

  if (level === 1) {
    return style(text, cliColors.heading1, true, ANSI_BOLD)
  }
  if (level === 2) {
    return style(text, cliColors.heading2, true, ANSI_BOLD)
  }
  if (level === 3) {
    return style(text, cliColors.heading3, true, ANSI_BOLD)
  }
  const prefixed = `${'#'.repeat(level)} ${text}`
  return style(prefixed, cliColors.heading4, true, ANSI_BOLD)
}

function renderRule(width: number, useColor: boolean): string {
  const line = '─'.repeat(Math.max(12, Math.min(width, 72)))
  return useColor ? fg(line, cliColors.rule, true) : line
}

function renderListBlock(lines: string[], useColor: boolean, useHyperlinks = false): string {
  const rendered: string[] = []
  let continuationIndent = ''

  for (const line of lines) {
    const match = line.match(/^(\s*)([-+*]|\d+\.)\s+(.*)$/)
    if (!match) {
      const trimmed = line.trim()
      const continuation = renderInline(trimmed, useColor, useHyperlinks)
      rendered.push(`${continuationIndent}${useColor ? tintText(continuation, cliColors.textMuted, true) : continuation}`)
      continue
    }

    const indent = match[1] ?? ''
    const rawMarker = match[2] ?? '-'
    const rawBody = match[3] ?? ''
    const task = parseTaskMarker(rawBody)
    const visibleMarker = task ? (task.checked ? '[x]' : '[ ]') : rawMarker
    const marker = useColor ? visibleMarker : visibleMarker
    const body = renderInline(task ? task.body : rawBody, useColor, useHyperlinks)
    continuationIndent = `${indent}${' '.repeat(stringWidth(visibleMarker) + 1)}`
    rendered.push(`${indent}${marker} ${useColor ? tintText(body, cliColors.text, true) : body}`)
  }

  return rendered.join('\n')
}

function renderBlockquote(lines: string[], useColor: boolean, useHyperlinks = false): string {
  return lines.map(line => {
    const depth = blockquoteDepth(line)
    const content = line.trimStart().replace(/^(>\s*)+/, '')
    const prefixUnit = useColor ? fg('│ ', cliColors.quoteBar, true) : '> '
    const prefix = prefixUnit.repeat(Math.max(1, depth))
    const body = useColor
      ? tintText(renderInline(content, useColor, useHyperlinks), depth > 1 ? cliColors.textMuted : cliColors.quoteText, true)
      : renderInline(content, useColor, useHyperlinks)
    return `${prefix}${body}`
  }).join('\n')
}

function renderTable(lines: string[], useColor: boolean, maxWidth: number): string {
  const rows = lines.map(parseTableRow)
  const header = rows[0] ?? []
  const body = rows.slice(2)
  const numericCols = header.map((_, colIdx) => body.length > 0 && body.every(row => isNumericCell(row[colIdx] ?? '')))
  const widths = header.map((_, colIdx) => {
    let width = 0
    for (const row of [header, ...body]) {
      const rendered = renderInline(row[colIdx] ?? '', false)
      width = Math.max(width, stringWidth(rendered))
    }
    return width
  })
  const minWidths = header.map((_, colIdx) => numericCols[colIdx] ? 4 : 6)
  const tableWidth = () => widths.reduce((sum, width) => sum + width, 0) + (3 * widths.length) + 1
  let truncated = false

  while (tableWidth() > maxWidth) {
    let targetIdx = -1
    let targetWidth = -1
    for (let i = 0; i < widths.length; i++) {
      if (widths[i]! > minWidths[i]! && widths[i]! > targetWidth) {
        targetWidth = widths[i]!
        targetIdx = i
      }
    }
    if (targetIdx === -1) break
    widths[targetIdx] -= 1
    truncated = true
  }

  const makeBorder = (left: string, mid: string, right: string) =>
    `${left}${widths.map(width => '─'.repeat(width + 2)).join(mid)}${right}`
  const renderRow = (row: string[], isHeader: boolean) => {
    const cells = row.map((cell, idx) => {
      const plainCell = renderInline(cell ?? '', false)
      const clipped = truncateDisplayText(plainCell, widths[idx] ?? 0)
      if (clipped !== plainCell) truncated = true
      let rendered = useColor ? tintText(clipped, cliColors.tableText, true) : clipped
      if (isHeader) rendered = style(rendered, cliColors.tableHeader, useColor, ANSI_BOLD)
      const align = !isHeader && numericCols[idx] ? padDisplayStart : padDisplayEnd
      return ` ${align(rendered, widths[idx] ?? 0)} `
    })
    if (!useColor) return `│${cells.join('│')}│`
    const separator = fg('│', cliColors.tableBorder, true)
    return `${separator}${cells.join(separator)}${separator}`
  }

  const renderedTable = [
    useColor ? fg(makeBorder('┌', '┬', '┐'), cliColors.tableBorder, true) : makeBorder('┌', '┬', '┐'),
    renderRow(header, true),
    useColor ? fg(makeBorder('├', '┼', '┤'), cliColors.tableBorder, true) : makeBorder('├', '┼', '┤'),
    ...body.map(row => renderRow(row, false)),
    useColor ? fg(makeBorder('└', '┴', '┘'), cliColors.tableBorder, true) : makeBorder('└', '┴', '┘'),
  ].join('\n')

  if (!truncated) return renderedTable
  const note = useColor
    ? tintText('↳ table truncated to fit terminal width', cliColors.textMuted, true)
    : '↳ table truncated to fit terminal width'
  return `${renderedTable}\n${note}`
}

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [currentThemeName],
      langs: [],
    })
  }
  return highlighterPromise
}

function normalizeCodeLanguage(lang: string): string {
  const normalized = lang.trim().toLowerCase()
  return CODE_LANG_ALIASES[normalized] ?? normalized
}

function tokenStylePrefix(color: string | undefined, fontStyle: number): string {
  const parts: string[] = []
  const fgCode = hexToAnsi(color, true)
  if (fgCode) parts.push(fgCode)
  if (fontStyle & 2) parts.push(ANSI_BOLD)
  if (fontStyle & 1) parts.push(ANSI_ITALIC)
  if (fontStyle & 4) parts.push(ANSI_UNDERLINE)
  if (fontStyle & 8) parts.push(ANSI_STRIKE)
  return parts.join('')
}

async function renderCodeBlock(code: string, lang: string, useColor: boolean): Promise<string> {
  const normalizedLang = normalizeCodeLanguage(lang)
  if (!useColor || PLAIN_CODE_LANGS.has(normalizedLang)) return code

  try {
    const highlighter = await getHighlighter()
    const highlighterApi = highlighter as unknown as {
      loadLanguage: (language: string) => Promise<void>
      codeToTokensBase: (
        input: string,
        options: { lang: string; theme: string }
      ) => Array<Array<{ content: string; color?: string; fontStyle?: number }>>
    }
    await highlighterApi.loadLanguage(normalizedLang)
    const lines = highlighterApi.codeToTokensBase(code, { lang: normalizedLang, theme: currentThemeName })
    const rendered = lines
      .map(line =>
        line
          .map(token => {
            const prefix = tokenStylePrefix(token.color, token.fontStyle ?? 0)
            if (!prefix) return token.content
            return `${prefix}${token.content}${ANSI_RESET}`
          })
          .join('')
      )
      .join('\n')
    return renderStyledCodeBlock(rendered, normalizedLang)
  } catch {
    return code
  }
}

function renderStyledCodeBlock(code: string, lang: string): string {
  const codeLines = code.split('\n')
  const label = lang.length > 0 ? ` ${lang} ` : ' code '
  const contentWidth = Math.max(
    stringWidth(label),
    ...codeLines.map(line => stringWidth(line)),
    12,
  )
  const bottom = `╰${'─'.repeat(contentWidth + 2)}╯`
  const border = cliColors.tableBorder
  const headerColor = cliColors.heading4
  const body = codeLines.map(line => {
    const padded = padDisplayEnd(line, contentWidth)
    return `${fg('│ ', border, true)}${padded}${fg(' │', border, true)}`
  })
  return [
    `${fg('╭─', border, true)}${style(label, headerColor, true, ANSI_BOLD)}${fg(`${'─'.repeat(Math.max(1, contentWidth - stringWidth(label) + 1))}╮`, border, true)}`,
    ...body,
    fg(bottom, border, true),
  ].join('\n')
}

export function preprocessMermaidBlocks(
  markdown: string,
  wrapRenderedBlocks = true,
  options: {
    renderMermaid?: boolean
    colorMode?: 'none' | 'ansi16' | 'ansi256' | 'truecolor' | 'html'
    theme?: ThemeName
    onWarning?: (message: string) => void
  } = {}
): string {
  const lines = normalizeNewlines(markdown).split('\n')
  const output: string[] = []

  let inMermaid = false
  let indent = ''
  let mermaidLines: string[] = []
  let mermaidStartLine = 0
  const renderMermaid = options.renderMermaid ?? true

  const flushMermaid = () => {
    const mermaidText = mermaidLines.join('\n')
    if (!renderMermaid) {
      output.push(`${indent}\`\`\`mermaid`)
      output.push(...indentBlock(mermaidText, indent).split('\n'))
      output.push(`${indent}\`\`\``)
      inMermaid = false
      indent = ''
      mermaidLines = []
      return
    }

    let rendered = ''
    try {
      rendered = renderMermaidASCII(mermaidText.trim(), {
        colorMode: options.colorMode ?? 'none',
        theme: diagramColorsToAsciiTheme(THEMES[options.theme ?? currentThemeName]),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      options.onWarning?.(`Mermaid block at line ${mermaidStartLine} could not be rendered: ${reason}`)
      rendered = ''
    }

    if (rendered.length > 0) {
      if (wrapRenderedBlocks) output.push(`${indent}\`\`\`text`)
      output.push(...indentBlock(rendered, indent).split('\n'))
      if (wrapRenderedBlocks) output.push(`${indent}\`\`\``)
    } else {
      output.push(`${indent}\`\`\`mermaid`)
      output.push(...indentBlock(mermaidText, indent).split('\n'))
      output.push(`${indent}\`\`\``)
    }

    inMermaid = false
    indent = ''
    mermaidLines = []
  }

  for (const line of lines) {
    if (!inMermaid) {
      const match = line.match(/^([ \t]*)```mermaid[ \t]*$/)
      if (match) {
        inMermaid = true
        indent = match[1] ?? ''
        mermaidStartLine = output.length + 1
        mermaidLines = []
        continue
      }
      output.push(line)
      continue
    }

    if (/^[ \t]*```[ \t]*$/.test(line)) {
      flushMermaid()
      continue
    }

    mermaidLines.push(line)
  }

  if (inMermaid) {
    output.push(`${indent}\`\`\`mermaid`)
    output.push(...indentBlock(mermaidLines.join('\n'), indent).split('\n'))
  }

  return output.join('\n')
}

export async function renderMarkdownToTerminal(
  markdown: string,
  options: RenderMarkdownOptions = {}
): Promise<string> {
  const useColor = options.useColor ?? true
  const useHyperlinks = options.useHyperlinks ?? false
  const width = Math.max(40, options.width ?? (process.stdout.columns || 80) - 4)
  const lines = normalizeNewlines(markdown).split('\n')
  const output: string[] = []

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''

    if (isBlank(line)) {
      if (output.length === 0 || output[output.length - 1] === '') continue
      output.push('')
      continue
    }

    const fenceMatch = line.match(/^```([^\s`]*)[^\n]*$/)
    if (fenceMatch) {
      const lang = fenceMatch[1] ?? ''
      const codeLines: string[] = []
      let closed = false
      while (i + 1 < lines.length) {
        i += 1
        const next = lines[i] ?? ''
        if (/^```[ \t]*$/.test(next)) {
          closed = true
          break
        }
        codeLines.push(next)
      }
      if (!closed) i -= 1
      output.push(await renderCodeBlock(codeLines.join('\n'), lang, useColor))
      output.push('')
      continue
    }

    if (isHeading(line)) {
      output.push(renderHeading(line, width, useColor))
      output.push('')
      continue
    }

    if (isHorizontalRule(line)) {
      output.push(renderRule(width, useColor))
      output.push('')
      continue
    }

    if (isBlockquote(line)) {
      const quoteLines = [line]
      while (i + 1 < lines.length && isBlockquote(lines[i + 1] ?? '')) {
        i += 1
        quoteLines.push(lines[i] ?? '')
      }
      output.push(renderBlockquote(quoteLines, useColor, useHyperlinks))
      output.push('')
      continue
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableDivider(lines[i + 1] ?? '')) {
      const tableLines = [line, lines[i + 1] ?? '']
      i += 1
      while (i + 1 < lines.length && isTableRow(lines[i + 1] ?? '')) {
        i += 1
        tableLines.push(lines[i] ?? '')
      }
      output.push(renderTable(tableLines, useColor, width))
      output.push('')
      continue
    }

    if (isListItem(line)) {
      const listLines = [line]
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? ''
        if (isBlank(next) || isHeading(next) || isHorizontalRule(next) || isFenceStart(next) || isBlockquote(next) || (isTableRow(next) && i + 2 < lines.length && isTableDivider(lines[i + 2] ?? ''))) {
          break
        }
        if (!isListItem(next) && !/^\s{2,}\S/.test(next)) break
        i += 1
        listLines.push(next)
      }
      output.push(renderListBlock(listLines, useColor, useHyperlinks))
      output.push('')
      continue
    }

    const paragraphLines = [line]
    while (i + 1 < lines.length) {
      const next = lines[i + 1] ?? ''
      if (
        isBlank(next) ||
        isHeading(next) ||
        isHorizontalRule(next) ||
        isFenceStart(next) ||
        isBlockquote(next) ||
        isListItem(next) ||
        (isTableRow(next) && i + 2 < lines.length && isTableDivider(lines[i + 2] ?? ''))
      ) {
        break
      }
      i += 1
      paragraphLines.push(lines[i] ?? '')
    }
    const paragraph = renderInline(paragraphLines.join(' '), useColor, useHyperlinks)
    output.push(useColor ? tintText(paragraph, cliColors.text, true) : paragraph)
    output.push('')
  }

  while (output.length > 0 && output[output.length - 1] === '') {
    output.pop()
  }

  return output.join('\n')
}

export function parseMdvArgs(argv: string[]): MdvCliOptions {
  const options: MdvCliOptions = {}

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg) continue

    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '-v':
      case '--version':
        options.version = true
        break
      case 'doctor':
        options.doctor = true
        break
      case '-n':
      case '--no-style':
      case '--no-mdv':
      case '--no-glow':
        options.noStyle = true
        break
      case '--no-mermaid':
        options.noMermaid = true
        options.mermaid = 'source'
        break
      case '--mermaid': {
        const value = argv[i + 1]
        if (!value) throw new Error('Missing value for --mermaid')
        if (value !== 'render' && value !== 'source') {
          throw new Error(`Invalid value for --mermaid: ${value}. Expected render or source.`)
        }
        options.mermaid = value
        options.noMermaid = value === 'source'
        i += 1
        break
      }
      case '--no-color':
        options.color = 'never'
        break
      case '--theme': {
        const theme = argv[i + 1]
        if (!theme) throw new Error('Missing value for --theme')
        if (!isThemeName(theme)) throw new Error(unknownThemeMessage(theme))
        options.theme = theme as ThemeName
        i += 1
        break
      }
      case '--preview':
        options.previewThemes = true
        break
      case '--color': {
        const value = argv[i + 1]
        if (!value) throw new Error('Missing value for --color')
        if (value !== 'auto' && value !== 'always' && value !== 'never') {
          throw new Error(`Invalid value for --color: ${value}. Expected auto, always, or never.`)
        }
        options.color = value
        i += 1
        break
      }
      case '--hyperlinks': {
        const value = argv[i + 1]
        if (!value) throw new Error('Missing value for --hyperlinks')
        if (value !== 'auto' && value !== 'always' && value !== 'never') {
          throw new Error(`Invalid value for --hyperlinks: ${value}. Expected auto, always, or never.`)
        }
        options.hyperlinks = value
        i += 1
        break
      }
      case '--list-themes':
        options.listThemes = true
        break
      case '-':
        options.inputFile = '-'
        break
      default:
        if (arg.startsWith('--color=')) {
          const value = arg.slice('--color='.length)
          if (value !== 'auto' && value !== 'always' && value !== 'never') {
            throw new Error(`Invalid value for --color: ${value}. Expected auto, always, or never.`)
          }
          options.color = value
          break
        }
        if (arg.startsWith('--hyperlinks=')) {
          const value = arg.slice('--hyperlinks='.length)
          if (value !== 'auto' && value !== 'always' && value !== 'never') {
            throw new Error(`Invalid value for --hyperlinks: ${value}. Expected auto, always, or never.`)
          }
          options.hyperlinks = value
          break
        }
        if (arg === 'themes') {
          options.listThemes = true
          break
        }
        if (arg.startsWith('-')) {
          throw new Error(unknownOptionMessage(arg))
        }
        if (options.inputFile) {
          throw new Error(`Unexpected extra argument: ${arg}`)
        }
        options.inputFile = arg
        break
    }
  }

  return options
}

async function readStdin(): Promise<string> {
  let input = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    input += chunk
  }
  return input
}

async function readInput(inputFile?: string): Promise<string> {
  if (inputFile && inputFile !== '-') {
    return readFile(inputFile, 'utf8')
  }
  if (!process.stdin.isTTY || inputFile === '-') {
    return readStdin()
  }
  throw new Error('Usage: mdv [OPTIONS] [FILE]\n       cat FILE | mdv -\nRun "mdv --help" for more examples.')
}

function renderThemePreview(name: ThemeName, useColor: boolean): string {
  const previousTheme = currentThemeName
  const previousColors = cliColors
  setCliTheme(name)
  const title = name === DEFAULT_THEME_NAME ? `${name} (default)` : name
  const graph = renderMermaidASCII('graph LR\n  A --> B', {
    colorMode: useColor ? 'truecolor' : 'none',
    theme: diagramColorsToAsciiTheme(THEMES[name]),
  })
  const sample = [
    renderHeading(`# ${title}`, 48, useColor),
    renderInline('Bold **accent** with `code` and [link](https://example.com)', useColor),
    graph,
  ].join('\n')
  setCliTheme(previousTheme)
  cliColors = previousColors
  return sample
}

function listThemes(preview = false, useColor = false): string {
  const lines: string[] = ['mdv themes', '']
  for (const name of Object.keys(THEMES) as ThemeName[]) {
    if (!preview) {
      lines.push(name === DEFAULT_THEME_NAME ? `* ${name} (default)` : `* ${name}`)
      continue
    }
    lines.push(renderThemePreview(name, useColor))
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function showDoctor(colorMode: CliColorMode, hyperlinkMode: CliHyperlinkMode, styled: boolean, hyperlinks: boolean, mermaidMode: MermaidMode): string {
  return [
    'mdv doctor',
    '',
    `version: ${PACKAGE_VERSION}`,
    `entry: ${resolvePath(process.argv[1] ?? 'unknown')}`,
    `cwd: ${process.cwd()}`,
    `theme: ${currentThemeName}`,
    `mermaid: ${mermaidMode}`,
    `color: ${colorMode}`,
    `hyperlinks: ${hyperlinkMode}`,
    `styled-output: ${styled ? 'yes' : 'no'}`,
    `hyperlink-output: ${hyperlinks ? 'yes' : 'no'}`,
    `stdout-is-tty: ${process.stdout.isTTY ? 'yes' : 'no'}`,
    `stdin-is-tty: ${process.stdin.isTTY ? 'yes' : 'no'}`,
    `columns: ${process.stdout.columns ?? 'unknown'}`,
  ].join('\n')
}

function showHelp(): string {
  return [
    'mdv - terminal Markdown with Mermaid ASCII support',
    '',
    'Usage:',
    '  mdv [OPTIONS] [FILE]',
    '  cat FILE | mdv -',
    '  mdv themes',
    '  mdv doctor',
    '',
    'Options:',
    '  -n, --no-style    Output raw Markdown with Mermaid rendered as ```text blocks',
    '  --no-mermaid      Keep Mermaid fenced blocks as source instead of rendering',
    '  --mermaid MODE    Use render or source for Mermaid fenced blocks',
    '  --theme NAME      Use a built-in theme (default: catppuccin-mocha)',
    '  --list-themes     List built-in themes',
    '  --preview         Show theme previews with "mdv themes"',
    '  --color MODE      Use auto, always, or never for ANSI colors',
    '  --hyperlinks MODE Use auto, always, or never for terminal hyperlinks',
    '  --no-color        Disable ANSI colors',
    '  -v, --version     Show mdv version',
    '  -h, --help        Show this help message',
    '',
    'Examples:',
    '  mdv README.md',
    '  cat README.md | mdv -',
    '  mdv --theme dracula README.md',
    '  mdv themes --preview',
  ].join('\n')
}

export async function runMdvCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const options = parseMdvArgs(argv)
    setCliTheme(options.theme ?? DEFAULT_THEME_NAME)
    const colorMode = resolveCliColorMode(options.color)
    const hyperlinkMode = resolveCliHyperlinkMode(options.hyperlinks)
    const styledOutput = !options.noStyle && shouldUseColor(colorMode, Boolean(process.stdout.isTTY))
    const hyperlinkOutput = styledOutput && shouldUseHyperlinks(hyperlinkMode, Boolean(process.stdout.isTTY))
    const mermaidMode = options.mermaid ?? (options.noMermaid ? 'source' : 'render')

    if (options.version) {
      process.stdout.write(`${PACKAGE_VERSION}\n`)
      return 0
    }
    if (options.help) {
      process.stdout.write(`${showHelp()}\n`)
      return 0
    }
    if (options.doctor) {
      process.stdout.write(`${showDoctor(colorMode, hyperlinkMode, styledOutput, hyperlinkOutput, mermaidMode)}\n`)
      return 0
    }
    if (options.listThemes) {
      process.stdout.write(`${listThemes(options.previewThemes ?? false, styledOutput)}\n`)
      return 0
    }

    const input = await readInput(options.inputFile)
    const warnings: string[] = []
    const rawMarkdown = preprocessMermaidBlocks(input, true, {
      renderMermaid: mermaidMode === 'render',
      colorMode: styledOutput ? 'truecolor' : 'none',
      theme: currentThemeName,
      onWarning: message => warnings.push(message),
    })

    if (!styledOutput) {
      if (warnings.length > 0) {
        for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`)
      }
      process.stdout.write(rawMarkdown.endsWith('\n') ? rawMarkdown : `${rawMarkdown}\n`)
      return 0
    }

    const rendered = await renderMarkdownToTerminal(rawMarkdown, {
      useColor: true,
      useHyperlinks: hyperlinkOutput,
      width: process.stdout.columns || 80,
    })
    const output = rendered.endsWith('\n') ? rendered : `${rendered}\n`
    if (warnings.length > 0) {
      for (const warning of warnings) process.stderr.write(`warning: ${warning}\n`)
    }
    process.stdout.write(output)
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message}\n`)
    return 1
  } finally {
    if (highlighterPromise) {
      const highlighter = await highlighterPromise.catch(() => null)
      await highlighter?.dispose?.()
      highlighterPromise = null
    }
  }
}

const isMain = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  return fileURLToPath(import.meta.url) === resolvePath(entry)
})()

if (isMain) {
  void runMdvCli().then(code => {
    process.exitCode = code
  })
}

export type GlowmCliOptions = MdvCliOptions

export const parseGlowmArgs = parseMdvArgs

export const runGlowmCli = runMdvCli

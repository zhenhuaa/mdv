// ============================================================================
// ASCII renderer — character display width utilities
//
// CJK (Chinese, Japanese, Korean) and other East Asian wide characters
// occupy 2 terminal columns instead of 1. These utilities measure the
// actual display width of strings so that box borders align correctly.
// ============================================================================

/**
 * Sentinel value placed in a canvas cell immediately after a wide character.
 * canvasToString() skips these cells when building output.
 */
export const WIDE_CHAR_PLACEHOLDER = '\x00'

/**
 * Get the display width of a single character in a terminal.
 * CJK and other East Asian wide characters return 2; most others return 1.
 */
export function charWidth(ch: string): number {
  if (ch.length === 0) return 0
  const code = ch.codePointAt(0)!
  if (isCjkAmbiguousWideSymbol(code)) return 2
  if (isWideChar(code)) return 2
  return 1
}

/**
 * Get the display width of a string (sum of character display widths).
 */
export function stringWidth(str: string): number {
  let w = 0
  for (const ch of str) {
    w += charWidth(ch)
  }
  return w
}

/**
 * Check if a Unicode code point is a wide (full-width) character.
 * Covers CJK Unified Ideographs, Hangul, Katakana, full-width forms, etc.
 */
function isWideChar(code: number): boolean {
  return (
    // CJK Radicals Supplement .. Ideographic Description Characters
    (code >= 0x2E80 && code <= 0x2FFF) ||
    // CJK Symbols and Punctuation, Hiragana, Katakana, Bopomofo, etc.
    (code >= 0x3000 && code <= 0x303F) ||
    // CJK Unified Ideographs Extension A + Yijing + CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x9FFF) ||
    // Hangul Jamo
    (code >= 0x1100 && code <= 0x115F) ||
    // Hangul Jamo Extended-A
    (code >= 0xA960 && code <= 0xA97C) ||
    // Hangul Syllables
    (code >= 0xAC00 && code <= 0xD7AF) ||
    // Hangul Jamo Extended-B
    (code >= 0xD7B0 && code <= 0xD7FF) ||
    // CJK Compatibility Ideographs
    (code >= 0xF900 && code <= 0xFAFF) ||
    // Halfwidth and Fullwidth Forms (fullwidth range)
    (code >= 0xFF01 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6) ||
    // Hiragana
    (code >= 0x3040 && code <= 0x309F) ||
    // Katakana
    (code >= 0x30A0 && code <= 0x30FF) ||
    // Katakana Phonetic Extensions
    (code >= 0x31F0 && code <= 0x31FF) ||
    // CJK Unified Ideographs Extension B..F and Supplement
    (code >= 0x20000 && code <= 0x2FA1F) ||
    // CJK Compatibility Ideographs Supplement
    (code >= 0x2F800 && code <= 0x2FA1F)
  )
}

/**
 * Some ambiguous-width symbols are commonly rendered as wide in CJK terminal
 * fonts. Treat them as width 2 to keep ASCII boxes aligned.
 */
function isCjkAmbiguousWideSymbol(code: number): boolean {
  return (
    (code >= 0x2605 && code <= 0x2606) ||
    (code >= 0x2610 && code <= 0x2612) ||
    (code >= 0x25CB && code <= 0x25CF) ||
    (code >= 0x2713 && code <= 0x2717)
  )
}

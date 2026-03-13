// ============================================================================
// ASCII renderer — sequence diagrams
//
// Renders sequenceDiagram text to ASCII/Unicode art using a column-based layout.
// Each actor occupies a column with a vertical lifeline; messages are horizontal
// arrows between lifelines. Blocks (loop/alt/opt/par) wrap around message groups.
//
// Layout is fundamentally different from flowcharts — no grid or A* pathfinding.
// Instead: actors → columns, messages → rows, all positioned linearly.
// ============================================================================

import { parseSequenceDiagram } from '../sequence/parser.ts'
import type { SequenceDiagram, Block } from '../sequence/types.ts'
import type { Canvas, AsciiConfig, RoleCanvas, CharRole, AsciiTheme, ColorMode, DrawingCoord } from './types.ts'
import { mkCanvas, mkRoleCanvas, canvasToString, increaseSize, increaseRoleCanvasSize, setRole, drawText } from './canvas.ts'
import { splitLines, maxLineWidth, lineCount } from './multiline-utils.ts'
import { charWidth, stringWidth } from './char-width.ts'

/** Classify a box-drawing character as 'border' or 'text'. */
function classifyBoxChar(ch: string): CharRole {
  if (/^[┌┐└┘├┤┬┴┼│─╭╮╰╯+\-|]$/.test(ch)) return 'border'
  return 'text'
}

/**
 * Render a Mermaid sequence diagram to ASCII/Unicode text.
 *
 * Pipeline: parse → layout (columns + rows) → draw onto canvas → string.
 */
export function renderSequenceAscii(text: string, config: AsciiConfig, colorMode?: ColorMode, theme?: AsciiTheme): string {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('%%'))
  const diagram = parseSequenceDiagram(lines)

  if (diagram.actors.length === 0) return ''

  const useAscii = config.useAscii

  // Box-drawing characters
  const H = useAscii ? '-' : '─'
  const V = useAscii ? '|' : '│'
  const TL = useAscii ? '+' : '┌'
  const TR = useAscii ? '+' : '┐'
  const BL = useAscii ? '+' : '└'
  const BR = useAscii ? '+' : '┘'
  const JT = useAscii ? '+' : '┬' // top junction on lifeline
  const JB = useAscii ? '+' : '┴' // bottom junction on lifeline
  const JL = useAscii ? '+' : '├' // left junction
  const JR = useAscii ? '+' : '┤' // right junction
  const SELF_MESSAGE_LOOP_W = 4

  // ---- LAYOUT: compute lifeline X positions ----

  const actorIdx = new Map<string, number>()
  diagram.actors.forEach((a, i) => actorIdx.set(a.id, i))

  const boxPad = 1
  // Use max line width for multi-line actor labels
  const actorBoxWidths = diagram.actors.map(a => maxLineWidth(a.label) + 2 * boxPad + 2)
  const halfBox = actorBoxWidths.map(w => Math.ceil(w / 2))
  // Calculate actor box heights based on number of lines in label
  const actorBoxHeights = diagram.actors.map(a => lineCount(a.label) + 2) // lines + top/bottom border
  const actorBoxH = Math.max(...actorBoxHeights, 3) // Use max height for consistent lifeline positioning

  // Compute minimum gap between adjacent lifelines based on message labels.
  // For messages spanning multiple actors, distribute the required width across gaps.
  const adjMaxWidth: number[] = new Array(Math.max(diagram.actors.length - 1, 0)).fill(0)

  for (const msg of diagram.messages) {
    const fi = actorIdx.get(msg.from)!
    const ti = actorIdx.get(msg.to)!
    if (fi === ti) continue // self-messages don't affect spacing
    const lo = Math.min(fi, ti)
    const hi = Math.max(fi, ti)
    // Required gap per span = (max line width + arrow decorations) / number of gaps
    const needed = maxLineWidth(msg.label) + 4
    const numGaps = hi - lo
    const perGap = Math.ceil(needed / numGaps)
    for (let g = lo; g < hi; g++) {
      adjMaxWidth[g] = Math.max(adjMaxWidth[g]!, perGap)
    }
  }

  // Compute lifeline x-positions (greedy left-to-right)
  const llX: number[] = [halfBox[0]!]
  for (let i = 1; i < diagram.actors.length; i++) {
    const gap = Math.max(
      halfBox[i - 1]! + halfBox[i]! + 2,
      adjMaxWidth[i - 1]! + 2,
      10,
    )
    llX[i] = llX[i - 1]! + gap
  }

  // ---- LAYOUT: compute vertical positions for messages ----

  // For each message index, track the y where its arrow is drawn.
  // Also track block start/end y positions and divider y positions.
  const msgArrowY: number[] = []
  const msgLabelY: number[] = []
  const blockStartY = new Map<number, number>()
  const blockEndY = new Map<number, number>()
  const divYMap = new Map<string, number>() // "blockIdx:divIdx" → y
  const notePositions: Array<{ x: number; y: number; width: number; height: number; lines: string[] }> = []

  let curY = actorBoxH // start right below header boxes

  for (let m = 0; m < diagram.messages.length; m++) {
    // Block openings at this message
    for (let b = 0; b < diagram.blocks.length; b++) {
      if (diagram.blocks[b]!.startIndex === m) {
        curY += 2 // 1 blank + 1 header row
        blockStartY.set(b, curY - 1)
      }
    }

    // Dividers at this message index
    for (let b = 0; b < diagram.blocks.length; b++) {
      for (let d = 0; d < diagram.blocks[b]!.dividers.length; d++) {
        if (diagram.blocks[b]!.dividers[d]!.index === m) {
          curY += 1
          divYMap.set(`${b}:${d}`, curY)
          curY += 1
        }
      }
    }

    curY += 1 // blank row before message

    const msg = diagram.messages[m]!
    const isSelf = msg.from === msg.to

    // Calculate height needed for multi-line message labels
    const msgLineCount = lineCount(msg.label)

    if (isSelf) {
      // Self-message occupies 3+ rows: top-arm, label-col(s), bottom-arm
      msgLabelY[m] = curY + 1
      msgArrowY[m] = curY
      curY += 2 + msgLineCount // top-arm + label lines + bottom-arm
    } else {
      // Normal message: label row(s) then arrow row
      msgLabelY[m] = curY
      msgArrowY[m] = curY + msgLineCount  // arrow goes after all label lines
      curY += msgLineCount + 1  // label lines + arrow row
    }

    // Notes after this message
    for (let n = 0; n < diagram.notes.length; n++) {
      if (diagram.notes[n]!.afterIndex === m) {
        curY += 1
        const note = diagram.notes[n]!
        const nLines = splitLines(note.text)
        let nWidth = Math.max(...nLines.map(l => stringWidth(l))) + 4
        const nHeight = nLines.length + 2

        // Determine x position based on note.position
        const aIdx = actorIdx.get(note.actorIds[0]!) ?? 0
        let nx: number
        if (note.position === 'left') {
          nx = llX[aIdx]! - nWidth - 1
        } else if (note.position === 'right') {
          nx = llX[aIdx]! + 2
        } else {
          // 'over' — center over actor(s), align with first lifeline
          if (note.actorIds.length >= 2) {
            const aIdx2 = actorIdx.get(note.actorIds[1]!) ?? aIdx
            // Center between first and last lifeline, but make sure it spans both
            const firstX = llX[Math.min(aIdx, aIdx2)]!
            const lastX = llX[Math.max(aIdx, aIdx2)]!
            const midX = Math.floor((firstX + lastX) / 2)
            nx = midX - Math.floor(nWidth / 2)
            // Ensure note box covers both lifelines
            // For 'over' spanning multiple actors, we need the box to cover from firstX to lastX
            // Left edge at or before firstX, right edge at or after lastX
            const targetLeft = firstX - 1
            const targetRight = lastX + 2
            nx = targetLeft
            // nWidth must be at least targetRight - targetLeft, expand if needed
            const minWidth = targetRight - targetLeft
            if (nWidth < minWidth) {
              nWidth = minWidth
            }
            // Debug note positioning

          } else {
            // Single actor - center on its lifeline
            nx = llX[aIdx]! - Math.floor(nWidth / 2)
          }
        }
        nx = Math.max(0, nx)

        notePositions.push({ x: nx, y: curY, width: nWidth, height: nHeight, lines: nLines })
        curY += nHeight
      }
    }

    // Block closings after this message
    for (let b = 0; b < diagram.blocks.length; b++) {
      if (diagram.blocks[b]!.endIndex === m) {
        curY += 1
        blockEndY.set(b, curY)
        curY += 1
      }
    }
  }

  curY += 1 // gap before footer
  const footerY = curY
  const totalH = footerY + actorBoxH

  // Total canvas width
  const lastLL = llX[llX.length - 1] ?? 0
  const lastHalf = halfBox[halfBox.length - 1] ?? 0
  let totalW = lastLL + lastHalf + 2

  // Ensure canvas is wide enough for self-message labels and notes
  for (let m = 0; m < diagram.messages.length; m++) {
    const msg = diagram.messages[m]!
    if (msg.from === msg.to) {
      const fi = actorIdx.get(msg.from)!
      const selfRight = llX[fi]! + SELF_MESSAGE_LOOP_W + 2 + stringWidth(msg.label)
      totalW = Math.max(totalW, selfRight + 1)
    }
  }
  for (const np of notePositions) {
    totalW = Math.max(totalW, np.x + np.width + 1)
  }

  const canvas = mkCanvas(totalW, totalH - 1)
  const rc = mkRoleCanvas(totalW, totalH - 1)

  /** Set a character on the canvas and track its role. */
  function setC(x: number, y: number, ch: string, role: CharRole): void {
    if (x >= 0 && x < canvas.length && y >= 0 && y < (canvas[0]?.length ?? 0)) {
      canvas[x]![y] = ch
      setRole(rc, x, y, role)
    }
  }

  /** Draw text and keep roleCanvas in sync so labels don't inherit line colors. */
  function drawRoleText(start: DrawingCoord, text: string, role: CharRole, forceOverwrite = true): void {
    drawText(canvas, start, text, forceOverwrite)
    let x = start.x
    for (const ch of text) {
      const width = charWidth(ch)
      increaseRoleCanvasSize(rc, x + width - 1, start.y)
      for (let dx = 0; dx < width; dx++) {
        setRole(rc, x + dx, start.y, role)
      }
      x += width
    }
  }

  // ---- DRAW: helper to place a bordered actor box (supports multi-line labels) ----

  function drawActorBox(cx: number, topY: number, label: string): void {
    const lines = splitLines(label)
    const maxW = maxLineWidth(label)
    const w = maxW + 2 * boxPad + 2
    const h = lines.length + 2  // lines + top/bottom border
    const left = cx - Math.floor(w / 2)

    // Top border
    setC(left, topY, TL, 'border')
    for (let x = 1; x < w - 1; x++) setC(left + x, topY, H, 'border')
    setC(left + w - 1, topY, TR, 'border')

    // Content lines (centered horizontally within the box)
    for (let i = 0; i < lines.length; i++) {
      const row = topY + 1 + i
      setC(left, row, V, 'border')
      setC(left + w - 1, row, V, 'border')
      // Center this line within the box
      const line = lines[i]!
      const ls = left + 1 + boxPad + Math.floor((maxW - stringWidth(line)) / 2)
      drawRoleText({ x: ls, y: row }, line, 'text')
    }

    // Bottom border
    const bottomY = topY + h - 1
    setC(left, bottomY, BL, 'border')
    for (let x = 1; x < w - 1; x++) setC(left + x, bottomY, H, 'border')
    setC(left + w - 1, bottomY, BR, 'border')
  }

  // ---- DRAW: lifelines ----

  for (let i = 0; i < diagram.actors.length; i++) {
    const x = llX[i]!
    for (let y = actorBoxH; y <= footerY; y++) {
      setC(x, y, V, 'line')
    }
  }

  // ---- DRAW: actor header + footer boxes (drawn over lifelines) ----

  for (let i = 0; i < diagram.actors.length; i++) {
    const actor = diagram.actors[i]!
    drawActorBox(llX[i]!, 0, actor.label)
    drawActorBox(llX[i]!, footerY, actor.label)

    // Lifeline junctions on box borders (Unicode only)
    if (!useAscii) {
      setC(llX[i]!, actorBoxH - 1, JT, 'junction')
      setC(llX[i]!, footerY, JB, 'junction')
    }
  }

  // ---- DRAW: messages ----

  for (let m = 0; m < diagram.messages.length; m++) {
    const msg = diagram.messages[m]!
    const fi = actorIdx.get(msg.from)!
    const ti = actorIdx.get(msg.to)!
    const fromX = llX[fi]!
    const toX = llX[ti]!
    const isSelf = fi === ti
    const isDashed = msg.lineStyle === 'dashed'
    const isFilled = msg.arrowHead === 'filled'

    // Arrow line character (solid vs dashed)
    const lineChar = isDashed ? (useAscii ? '.' : '╌') : H

    if (isSelf) {
      // Self-message: 3-row loop to the right of the lifeline
      //   ├──┐           (row 0 = msgArrowY)
      //   │  │ Label     (row 1)
      //   │◄─┘           (row 2)
      const y0 = msgArrowY[m]!
      const loopW = SELF_MESSAGE_LOOP_W

      // Row 0: start junction + horizontal + top-right corner
      setC(fromX, y0, JL, 'junction')
      for (let x = fromX + 1; x < fromX + loopW; x++) setC(x, y0, lineChar, 'line')
      setC(fromX + loopW, y0, useAscii ? '+' : '┐', 'corner')

      // Row 1: vertical on right side + label
      setC(fromX + loopW, y0 + 1, V, 'line')
      const labelX = fromX + loopW + 2
      drawRoleText({ x: labelX, y: y0 + 1 }, msg.label, 'text')

      // Row 2: arrow-back + horizontal + bottom-right corner
      const arrowChar = isFilled ? (useAscii ? '<' : '◀') : (useAscii ? '<' : '◁')
      setC(fromX, y0 + 2, arrowChar, 'arrow')
      for (let x = fromX + 1; x < fromX + loopW; x++) setC(x, y0 + 2, lineChar, 'line')
      setC(fromX + loopW, y0 + 2, useAscii ? '+' : '┘', 'corner')
    } else {
      // Normal message: label on row above, arrow on row below
      const labelY = msgLabelY[m]!
      const arrowY = msgArrowY[m]!
      const leftToRight = fromX < toX

      // Draw label centered between the two lifelines (supports multi-line)
      const midX = Math.floor((fromX + toX) / 2)
      const msgLines = splitLines(msg.label)

      for (let lineIdx = 0; lineIdx < msgLines.length; lineIdx++) {
        const line = msgLines[lineIdx]!
        const labelStart = midX - Math.floor(stringWidth(line) / 2)
        const y = labelY + lineIdx
        drawRoleText({ x: labelStart, y }, line, 'text')
      }

      // Draw arrow line
      if (leftToRight) {
        for (let x = fromX + 1; x < toX; x++) setC(x, arrowY, lineChar, 'line')
        // Arrowhead at destination
        const ah = isFilled ? (useAscii ? '>' : '▶') : (useAscii ? '>' : '▷')
        setC(toX, arrowY, ah, 'arrow')
      } else {
        for (let x = toX + 1; x < fromX; x++) setC(x, arrowY, lineChar, 'line')
        const ah = isFilled ? (useAscii ? '<' : '◀') : (useAscii ? '<' : '◁')
        setC(toX, arrowY, ah, 'arrow')
      }
    }
  }

  // ---- DRAW: blocks (loop, alt, opt, par, etc.) ----
  
  // Pre-calculate lifeline positions for block border handling
  const lifelineXs = new Set(llX)

  for (let b = 0; b < diagram.blocks.length; b++) {
    const block = diagram.blocks[b]!
    const topY = blockStartY.get(b)
    const botY = blockEndY.get(b)
    if (topY === undefined || botY === undefined) continue

    // Find the leftmost/rightmost content involved in this block's messages.
    // Self-message loops extend to the right of their actor lifeline, so the
    // block needs to enclose the loop itself, not just the actor column.
    let minContentX = totalW
    let maxContentX = 0
    let sawContent = false
    for (let m = block.startIndex; m <= block.endIndex; m++) {
      if (m >= diagram.messages.length) break
      const msg = diagram.messages[m]!
      const f = actorIdx.get(msg.from) ?? 0
      const t = actorIdx.get(msg.to) ?? 0
      const fromX = llX[f]!
      const toX = llX[t]!
      sawContent = true
      minContentX = Math.min(minContentX, fromX, toX)
      maxContentX = Math.max(
        maxContentX,
        fromX === toX
          ? fromX + SELF_MESSAGE_LOOP_W + 2 + stringWidth(msg.label)
          : Math.max(fromX, toX),
      )
    }

    if (!sawContent) {
      minContentX = llX[0] ?? 0
      maxContentX = llX[llX.length - 1] ?? 0
    }

    const bLeft = Math.max(0, minContentX - 4)
    const bRight = Math.min(totalW - 1, maxContentX + 4)

    // Top border with block type label
    setC(bLeft, topY, TL, 'border')
    for (let x = bLeft + 1; x < bRight; x++) {
      if (lifelineXs.has(x) && !useAscii) {
        setC(x, topY, '┬', 'junction')
      } else {
        setC(x, topY, H, 'border')
      }
    }
    setC(bRight, topY, TR, 'border')
    // Write block header label over the top border (supports multi-line)
    const hdrLabel = block.label ? `${block.type} [${block.label}]` : block.type
    const hdrLines = splitLines(hdrLabel)

    for (let lineIdx = 0; lineIdx < hdrLines.length && topY + lineIdx < botY; lineIdx++) {
      const line = hdrLines[lineIdx]!
      drawRoleText({ x: bLeft + 1, y: topY + lineIdx }, line, 'text')
    }

    // Bottom border
    setC(bLeft, botY, BL, 'border')
    for (let x = bLeft + 1; x < bRight; x++) {
      if (lifelineXs.has(x) && !useAscii) {
        setC(x, botY, '┴', 'junction')
      } else {
        setC(x, botY, H, 'border')
      }
    }
    setC(bRight, botY, BR, 'border')

    // Side borders - skip positions where there's a lifeline
    for (let y = topY + 1; y < botY; y++) {
      // Only draw left border if not a lifeline
      if (!lifelineXs.has(bLeft)) {
        setC(bLeft, y, V, 'border')
      }
      // Only draw right border if not a lifeline
      if (!lifelineXs.has(bRight)) {
        setC(bRight, y, V, 'border')
      }
    }

    // Dividers
    for (let d = 0; d < block.dividers.length; d++) {
      const dY = divYMap.get(`${b}:${d}`)
      if (dY === undefined) continue
      const dashChar = isDashedH()
      // Only draw junction if not on lifeline
      if (!lifelineXs.has(bLeft)) {
        setC(bLeft, dY, JL, 'junction')
      }
      for (let x = bLeft + 1; x < bRight; x++) {
        // Use junction char where divider crosses lifeline
        if (lifelineXs.has(x) && !useAscii) {
          setC(x, dY, '┼', 'junction')
        } else {
          setC(x, dY, dashChar, 'line')
        }
      }
      if (!lifelineXs.has(bRight)) {
        setC(bRight, dY, JR, 'junction')
      }
      // Divider label
      const dLabel = block.dividers[d]!.label
      if (dLabel) {
        const dStr = `[${dLabel}]`
        drawRoleText({ x: bLeft + 1, y: dY }, dStr, 'text')
      }
    }
  }

  // ---- DRAW: notes ----

  for (const np of notePositions) {
    // Ensure canvas is big enough
    increaseSize(canvas, np.x + np.width, np.y + np.height)
    increaseRoleCanvasSize(rc, np.x + np.width, np.y + np.height)
    
    // Find which lifelines are covered by this note
    const coveredLifelines: number[] = []
    for (let i = 0; i < diagram.actors.length; i++) {
      const lx = llX[i]!
      if (lx >= np.x && lx < np.x + np.width) {
        coveredLifelines.push(lx)
      }
    }
    
    // Top border - use junction chars where lifelines intersect
    // Check if corners are on lifelines
    const leftCornerOnLifeline = coveredLifelines.includes(np.x)
    const rightCornerOnLifeline = coveredLifelines.includes(np.x + np.width - 1)
    
    if (!leftCornerOnLifeline) {
      setC(np.x, np.y, TL, 'border')
    }
    for (let x = 1; x < np.width - 1; x++) {
      const absX = np.x + x
      const hasLifeline = coveredLifelines.includes(absX)
      const ch = hasLifeline && !useAscii ? '┼' : H
      setC(absX, np.y, ch, 'junction')
    }
    if (!rightCornerOnLifeline) {
      setC(np.x + np.width - 1, np.y, TR, 'border')
    }
    
    // Content rows
    for (let l = 0; l < np.lines.length; l++) {
      const ly = np.y + 1 + l
      const lineText = np.lines[l] ?? ''
      
      // Left and right borders (skip lifeline positions, use ┼ for lifeline crossings)
      for (let x = 0; x < np.width; x++) {
        const absX = np.x + x
        const isLifeline = coveredLifelines.includes(absX)
        
        if (x === 0 || x === np.width - 1) {
          // Corner positions: border only if not lifeline
          if (!isLifeline) {
            setC(absX, ly, V, 'border')
          }
        } else if (isLifeline) {
          // Lifeline crossing through note: show cross
          if (!useAscii) {
            setC(absX, ly, '┼', 'junction')
          }
        }
      }
      drawRoleText({ x: np.x + 2, y: ly }, lineText, 'text')
    }
    
    // Bottom border - use junction chars where lifelines intersect
    const by = np.y + np.height - 1
    if (!leftCornerOnLifeline) {
      setC(np.x, by, BL, 'border')
    }
    for (let x = 1; x < np.width - 1; x++) {
      const absX = np.x + x
      const hasLifeline = coveredLifelines.includes(absX)
      if (hasLifeline && !useAscii) {
        setC(absX, by, '┼', 'junction')
      } else {
        setC(absX, by, H, 'border')
      }
    }
    if (!rightCornerOnLifeline) {
      setC(np.x + np.width - 1, by, BR, 'border')
    }
  }

  return canvasToString(canvas, { roleCanvas: rc, colorMode, theme })

  // ---- Helper: dashed horizontal character ----
  function isDashedH(): string {
    return useAscii ? '-' : '╌'
  }
}

import { describe, it, expect } from 'bun:test'
import { renderMermaidAscii } from '../ascii/index.ts'
import { mkCanvas, drawText, canvasToString } from '../ascii/canvas.ts'
import { stringWidth } from '../ascii/char-width.ts'

const noColor = { colorMode: 'none' as const }

describe('ASCII multi-line labels', () => {
  describe('flowchart nodes', () => {
    it('renders multi-line node labels', () => {
      const ascii = renderMermaidAscii('graph TD\n  A[Line1<br>Line2]', { useAscii: false, ...noColor })
      expect(ascii).toContain('Line1')
      expect(ascii).toContain('Line2')
      // Lines should be on different rows
      const lines = ascii.split('\n')
      const line1Row = lines.findIndex(l => l.includes('Line1'))
      const line2Row = lines.findIndex(l => l.includes('Line2'))
      expect(line2Row).toBeGreaterThan(line1Row)
    })

    it('handles 3+ line labels', () => {
      const ascii = renderMermaidAscii('graph TD\n  A[A<br>B<br>C]', { useAscii: false, ...noColor })
      expect(ascii).toContain('A')
      expect(ascii).toContain('B')
      expect(ascii).toContain('C')
      // Verify vertical ordering
      const lines = ascii.split('\n')
      const aRow = lines.findIndex(l => l.includes('A') && !l.includes('─') && !l.includes('-'))
      const bRow = lines.findIndex(l => l.includes('B'))
      const cRow = lines.findIndex(l => l.includes('C'))
      expect(bRow).toBeGreaterThan(aRow)
      expect(cRow).toBeGreaterThan(bRow)
    })

    it('renders in ASCII mode (not Unicode)', () => {
      const ascii = renderMermaidAscii('graph TD\n  A[Line1<br>Line2]', { useAscii: true, ...noColor })
      expect(ascii).toContain('Line1')
      expect(ascii).toContain('Line2')
      // Should use ASCII box characters
      expect(ascii).toContain('+')
      expect(ascii).toContain('-')
    })
  })

  describe('flowchart edge labels', () => {
    it('renders multi-line edge labels', () => {
      const ascii = renderMermaidAscii('graph TD\n  A --> B\n  A -->|Line1<br>Line2| C', { useAscii: false, ...noColor })
      expect(ascii).toContain('Line1')
      expect(ascii).toContain('Line2')
    })
  })

  describe('flowchart subgraph labels', () => {
    it('renders multi-line subgraph labels', () => {
      const ascii = renderMermaidAscii(`graph TD
        subgraph sg [Group<br>Header]
          A[Node]
        end
      `, { useAscii: false, ...noColor })
      expect(ascii).toContain('Group')
      expect(ascii).toContain('Header')
    })
  })

  describe('sequence diagram', () => {
    it('renders multi-line actor labels', () => {
      const ascii = renderMermaidAscii(`sequenceDiagram
        participant A as Actor<br>One
        A->>A: msg
      `, { useAscii: false, ...noColor })
      expect(ascii).toContain('Actor')
      expect(ascii).toContain('One')
    })

    it('renders multi-line message labels', () => {
      const ascii = renderMermaidAscii(`sequenceDiagram
        participant A
        participant B
        A->>B: Line1<br>Line2
      `, { useAscii: false, ...noColor })
      expect(ascii).toContain('Line1')
      expect(ascii).toContain('Line2')
    })

    it('preserves existing note multi-line support', () => {
      const ascii = renderMermaidAscii(`sequenceDiagram
        participant A
        A->>A: self
        Note over A: Note line 1<br>Note line 2
      `, { useAscii: false, ...noColor })
      expect(ascii).toContain('Note line 1')
      expect(ascii).toContain('Note line 2')
    })
  })

  describe('class diagram', () => {
    it('renders multi-line class names', () => {
      const ascii = renderMermaidAscii(`classDiagram
        class MyClass["Long<br>Name"]
      `, { useAscii: false, ...noColor })
      expect(ascii).toContain('Long')
      expect(ascii).toContain('Name')
    })

    it('renders multi-line relationship labels', () => {
      const ascii = renderMermaidAscii(`classDiagram
        A --> B : uses<br>implements
      `, { useAscii: false, ...noColor })
      expect(ascii).toContain('uses')
      expect(ascii).toContain('implements')
    })
  })

  describe('ER diagram', () => {
    it('renders multi-line entity names', () => {
      const ascii = renderMermaidAscii(`erDiagram
        "Entity<br>Name" {
          string id
        }
      `, { useAscii: false })
      expect(ascii).toContain('Entity')
      expect(ascii).toContain('Name')
    })

    it('renders multi-line relationship labels', () => {
      const ascii = renderMermaidAscii(`erDiagram
        A ||--o{ B : "has<br>many"
      `, { useAscii: false })
      expect(ascii).toContain('has')
      expect(ascii).toContain('many')
    })
  })

  describe('edge cases', () => {
    it('handles empty lines from consecutive <br>', () => {
      const ascii = renderMermaidAscii('graph TD\n  A[Line1<br><br>Line3]', { useAscii: false, ...noColor })
      expect(ascii).toContain('Line1')
      expect(ascii).toContain('Line3')
    })

    it('handles single-line labels (no <br>)', () => {
      const ascii = renderMermaidAscii('graph TD\n  A[SingleLine]', { useAscii: false, ...noColor })
      expect(ascii).toContain('SingleLine')
    })

    it('handles very long lines', () => {
      const long = 'A'.repeat(30)
      const ascii = renderMermaidAscii(`graph TD\n  A[${long}<br>Short]`, { useAscii: false, ...noColor })
      expect(ascii).toContain(long)
      expect(ascii).toContain('Short')
    })

    it('handles mixed short and long lines', () => {
      const ascii = renderMermaidAscii('graph TD\n  A[Short<br>VeryLongSecondLine<br>Med]', { useAscii: false, ...noColor })
      expect(ascii).toContain('Short')
      expect(ascii).toContain('VeryLongSecondLine')
      expect(ascii).toContain('Med')
    })

    it('renders CJK labels without placeholder leakage or border misalignment', () => {
      const ascii = renderMermaidAscii('graph TD\n  A[你好]', { useAscii: false, ...noColor })
      expect(ascii).toContain('你好')
      expect(ascii).not.toContain('\x00')

      const lines = ascii.split('\n')
      const boxLines = lines.filter(line => line.includes('┌') || line.includes('你好') || line.includes('└'))
      expect(boxLines.length).toBeGreaterThanOrEqual(3)

      const widths = boxLines.map(stringWidth)
      expect(new Set(widths).size).toBe(1)
    })

    it('clears both cells when overwriting half of a wide character', () => {
      const canvas = mkCanvas(2, 0)
      drawText(canvas, { x: 0, y: 0 }, '你', true)
      drawText(canvas, { x: 1, y: 0 }, 'A', true)

      expect(canvasToString(canvas)).toBe(' A ')
    })
  })

  describe('multiline-utils functions', () => {
    it('splitLines splits on newlines', () => {
      // Test through the rendering pipeline
      const ascii = renderMermaidAscii('graph TD\n  A[One<br>Two<br>Three]', { useAscii: false, ...noColor })
      const lines = ascii.split('\n')
      // All three words should appear on separate lines
      expect(lines.some(l => l.includes('One'))).toBe(true)
      expect(lines.some(l => l.includes('Two'))).toBe(true)
      expect(lines.some(l => l.includes('Three'))).toBe(true)
    })

    it('maxLineWidth uses longest line for box sizing', () => {
      // Box should be wide enough for the longest line
      const ascii = renderMermaidAscii('graph TD\n  A[X<br>LongLine<br>Y]', { useAscii: false, ...noColor })
      // The box should contain LongLine without truncation
      expect(ascii).toContain('LongLine')
    })
  })
})

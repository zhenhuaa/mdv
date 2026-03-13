import { describe, expect, it } from 'bun:test'
import { renderMermaidASCII } from '../ascii/index.ts'
import { stringWidth } from '../ascii/char-width.ts'

describe('ASCII sequence diagrams', () => {
  it('keeps self-message loop corners intact inside a block', () => {
    const ascii = renderMermaidASCII(
      `sequenceDiagram
      A->>B: start
      alt x
        B->>B: self
      end`,
      { useAscii: false, colorMode: 'none' },
    )

    expect(ascii).toContain('├───┐')
    expect(ascii).toContain('◀───┘')
    expect(ascii).not.toContain('├───│')
    expect(ascii).not.toContain('◀───│')
  })

  it('keeps CJK rows at a consistent terminal width', () => {
    const ascii = renderMermaidASCII(
      `sequenceDiagram
      participant Player as 玩家
      participant Game as 游戏客户端
      participant Share as 分享服务
      Player->>Game: 点击分享
      alt 审核中
        Game->>Game: 自处理
      else 审核拒绝
        Game-->>Player: 已失效
      end
      Note over Game,Share: 审核异步完成`,
      { useAscii: false, colorMode: 'none' },
    )

    expect(ascii).not.toContain('\x00')

    const widths = ascii.split('\n').map(stringWidth)
    expect(new Set(widths).size).toBe(1)
  })

  it('keeps overlapped message labels in text color instead of lifeline color', () => {
    const ascii = renderMermaidASCII(
      `sequenceDiagram
      participant A
      participant B
      participant C
      A->>C: hello`,
      { useAscii: false, colorMode: 'truecolor' },
    )

    expect(ascii).toContain('\x1b[38;2;205;214;244mhello\x1b[0m')
    expect(ascii).not.toContain('\x1b[38;2;117;121;141mhello\x1b[0m')
  })
})

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { stringWidth } from '../ascii/char-width.ts'
import { preprocessMermaidBlocks, renderMarkdownToTerminal, parseGlowmArgs, parseMdvArgs, runGlowmCli, runMdvCli } from '../mdv.ts'

describe('preprocessMermaidBlocks', () => {
  it('replaces mermaid fences with fenced ASCII text blocks', () => {
    const input = [
      '# Demo',
      '',
      '```mermaid',
      'graph LR',
      '  A --> B',
      '```',
      '',
      'tail',
    ].join('\n')

    const output = preprocessMermaidBlocks(input, true)

    expect(output).toContain('```text')
    expect(output).not.toContain('```mermaid')
    expect(output).toContain('A')
    expect(output).toContain('B')
  })

  it('keeps mermaid fences untouched when rendering is disabled', () => {
    const input = [
      '# Demo',
      '',
      '```mermaid',
      'graph LR',
      '  A --> B',
      '```',
    ].join('\n')

    const output = preprocessMermaidBlocks(input, true, { renderMermaid: false })

    expect(output).toContain('```mermaid')
    expect(output).not.toContain('```text')
    expect(output).toContain('A --> B')
  })
})

describe('renderMarkdownToTerminal', () => {
  it('renders headings, tables, quotes, code, and mermaid ASCII without literal fences', async () => {
    const markdown = preprocessMermaidBlocks([
      '# 标题',
      '',
      '| 字段 | 说明 |',
      '| --- | --- |',
      '| `shareCode` | 分享码 |',
      '',
      '> 审核中可以传播',
      '',
      '```ts',
      'const answer = 42',
      '```',
      '',
      '```mermaid',
      'sequenceDiagram',
      '  participant A as 玩家A',
      '  participant B as 玩家B',
      '  A->>B: 分享',
      '```',
    ].join('\n'))

    const output = await renderMarkdownToTerminal(markdown, { useColor: false, width: 80 })

    expect(output).toContain('# 标题')
    expect(output).toContain('┌')
    expect(output).toContain('> 审核中可以传播')
    expect(output).toContain('const answer = 42')
    expect(output).toContain('玩家A')
    expect(output).toContain('玩家B')
    expect(output).not.toContain('```')
  })

  it('uses catppuccin mocha colors for markdown headings', async () => {
    const output = await renderMarkdownToTerminal('# Title\n\n## Subtitle\n\n### Section\n\n#### Deep\n\n正文', { useColor: true, width: 80 })

    expect(output).toContain('\x1b[38;2;203;166;247m')
    expect(output).toContain('\x1b[38;2;203;166;247m\x1b[1mTitle')
    expect(output).toContain('\x1b[38;2;203;166;247m\x1b[1mSubtitle')
    expect(output).toContain('\x1b[38;2;203;166;247m\x1b[1mSection')
    expect(output).toContain('\x1b[38;2;203;166;247m\x1b[1m#### Deep')
    expect(output).toContain('\x1b[38;2;205;214;244m正文')
    expect(output).not.toContain('\x1b[38;2;88;91;112m\x1b[1mSubtitle')
    expect(output).not.toContain('\x1b[38;2;108;112;134m\x1b[1m#### Deep')
  })

  it('does not treat underscores inside heading filenames or dates as italic markers', async () => {
    const output = await renderMarkdownToTerminal('# 2026_2_11 影棚分享导入导出功能-一期', { useColor: true, width: 120 })

    expect(output).toContain('2026_2_11 影棚分享导入导出功能-一期')
    expect(output).not.toContain('\x1b[3m2')
  })

  it('keeps inline code inside bold text', async () => {
    const output = await renderMarkdownToTerminal('1. **网站组只存 `dataUrl`**', { useColor: true, width: 80 })
    expect(output).toContain('dataUrl')
    expect(output).not.toContain('[48;2;')
  })

  it('renders colored code blocks with a visible frame', async () => {
    const output = await renderMarkdownToTerminal('```ts\nconst answer = 42\n```', { useColor: true, width: 80 })

    expect(output).toContain('╭')
    expect(output).toContain('typescript')
    expect(output).toContain('│ ')
    expect(output).toContain('╰')
  })

  it('keeps code block top border aligned for bash fences', async () => {
    const output = await renderMarkdownToTerminal(
      '```bash\nbun install -g mdv\nmdv README.md\n```',
      { useColor: true, width: 80 }
    )

    const frameLines = output
      .split('\n')
      .filter(line => line.includes('╭') || line.includes('│ ') || line.includes('╰'))
      .map(line => line.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, ''))

    expect(frameLines[0]).toContain('╭─ bash ')
    expect(frameLines[1]).toContain('│ bun install -g mdv')
    expect(frameLines[2]).toContain('│ mdv README.md')
    expect(frameLines[3]).toContain('╰')
    expect(new Set(frameLines.map(line => stringWidth(line))).size).toBe(1)
  })

  it('keeps catppuccin mocha base text color across inline markdown styles', async () => {
    const output = await renderMarkdownToTerminal(
      'plain **bold** tail *italic* tail ~~gone~~ [link](https://example.com) `code` end',
      { useColor: true, width: 120 }
    )

    expect(output).toContain('\x1b[38;2;205;214;244mplain ')
    expect(output).toContain('\x1b[1mbold\x1b[0m')
    expect(output).toContain('\x1b[38;2;88;91;112m')
    expect(output).toContain('\x1b[38;2;108;112;134m')
    expect(output).toContain('\x1b[38;2;203;166;247m')
    expect(output).toContain('\x1b[38;2;205;214;244m end')
  })

  it('renders link text with stronger contrast than muted body text', async () => {
    const output = await renderMarkdownToTerminal(
      '[link](https://example.com/docs/path)',
      { useColor: true, width: 120 }
    )

    expect(output).toContain('\x1b[38;2;203;166;247m\x1b[4mlink\x1b[0m')
    expect(output).toContain('\x1b[38;2;88;91;112m (https://example.com/docs/path)\x1b[0m')
    expect(output).not.toContain('\x1b[2m')
  })

  it('emits OSC 8 hyperlinks when terminal hyperlink output is enabled', async () => {
    const output = await renderMarkdownToTerminal(
      '[link](https://example.com/docs/path)',
      { useColor: true, useHyperlinks: true, width: 120 }
    )

    expect(output).toContain('\x1b]8;;https://example.com/docs/path\x1b\\')
    expect(output).toContain('\x1b]8;;\x1b\\')
    expect(output).toContain('link')
  })

  it('compacts long links in inline markdown output', async () => {
    const output = await renderMarkdownToTerminal(
      '[docs](https://example.com/very/long/path/that/should/be/shortened/for/terminal/readability)',
      { useColor: false, width: 120 }
    )

    expect(output).toContain('docs (https://example.com/very/long/path/')
    expect(output).toContain('…')
    expect(output).not.toContain('should/be/shortened/for/terminal/readability')
  })

  it('keeps markdown image syntax unchanged in terminal output', async () => {
    const output = await renderMarkdownToTerminal(
      '![示意图](./images/demo.png)',
      { useColor: false, width: 120 }
    )

    expect(output).toContain('![示意图](./images/demo.png)')
  })

  it('does not split table cells on pipes inside inline code spans', async () => {
    const output = await renderMarkdownToTerminal(
      [
        '| 参数 | 说明 |',
        '| --- | --- |',
        '| `--mermaid <render|source>` | 显式指定 Mermaid block 是渲染成图还是保留源码 |',
        '| `--color <auto|always|never>` | 控制 ANSI 颜色输出策略 |',
      ].join('\n'),
      { useColor: false, width: 120 }
    )

    expect(output).toContain('│ --mermaid <render|source>   │')
    expect(output).toContain('│ --color <auto|always|never> │')
    expect(output).not.toContain('│ source>`')
    expect(output).not.toContain('│ always')
  })

  it('keeps deep heading levels visibly prefixed', async () => {
    const output = await renderMarkdownToTerminal('#### Details', { useColor: true, width: 80 })
    expect(output).toContain('#### Details')
  })

  it('right-aligns numeric table columns', async () => {
    const output = await renderMarkdownToTerminal(
      ['| Name | Count |', '| --- | --- |', '| A | 2 |', '| B | 12 |'].join('\n'),
      { useColor: false, width: 80 }
    )

    expect(output).toContain('│ A    │     2 │')
    expect(output).toContain('│ B    │    12 │')
  })

  it('truncates overly wide tables to fit the terminal width', async () => {
    const output = await renderMarkdownToTerminal(
      [
        '| Name | Description | Value |',
        '| --- | --- | --- |',
        '| Alpha | This is a very long description that should not overflow the terminal table width | 1200 |',
      ].join('\n'),
      { useColor: false, width: 40 }
    )

    expect(output).toContain('…')
    expect(output).toContain('↳ table truncated to fit terminal width')
  })

  it('keeps truncated CJK tables aligned at terminal display width', async () => {
    const output = await renderMarkdownToTerminal(
      [
        '| 条目 | 详细信息 | 备注说明 |',
        '| --- | --- | --- |',
        '| 活动时间 | 0324 版本（4月1日正式上线，3月27日先锋服上线）上线后常驻并持续运营 | 过程中确认 |',
      ].join('\n'),
      { useColor: false, width: 44 }
    )

    const lines = output.split('\n').filter(line => line.startsWith('┌') || line.startsWith('│') || line.startsWith('├') || line.startsWith('└'))
    expect(lines.length).toBeGreaterThan(0)
    expect(new Set(lines.map(line => stringWidth(line))).size).toBe(1)
  })

  it('keeps checkbox-heavy truncated tables aligned at terminal display width', async () => {
    const output = await renderMarkdownToTerminal(
      [
        '| 埋点activity | 端游埋点：yjwj_yingpengfx_20260401 |  |  |  |  |  |  |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        '| 数据展现形式 | ☒ Grafana数据看板<br>☐ POPO消息推送<br>☐ 邮件推送<br>注意，数据需求默认展现形式为数据看板，由数据组开发配置完成，而且非特殊复杂情况，不使用低代码前端开发资源；如有POPO消息推送或邮件推送需求，需要特别指出，并排数据组开发人员完成 |  |  |  |  |  |  |',
      ].join('\n'),
      { useColor: false, width: 80 }
    )

    const lines = output.split('\n').filter(line => line.startsWith('┌') || line.startsWith('│') || line.startsWith('├') || line.startsWith('└'))
    expect(lines.length).toBeGreaterThan(0)
    expect(new Set(lines.map(line => stringWidth(line))).size).toBe(1)
  })

  it('normalizes ambiguous checkbox symbols to ASCII in terminal output', async () => {
    const output = await renderMarkdownToTerminal('| A |\n| --- |\n| ☒ done<br>☐ todo |', { useColor: false, width: 40 })

    expect(output).toContain('[x] done / [ ] todo')
    expect(output).not.toContain('☒')
    expect(output).not.toContain('☐')
  })

  it('renders task list markers and indented continuation lines cleanly', async () => {
    const output = await renderMarkdownToTerminal(
      ['- [x] shipped', '  still documented', '- [ ] pending'].join('\n'),
      { useColor: false, width: 80 }
    )

    expect(output).toContain('[x] shipped')
    expect(output).toContain('    still documented')
    expect(output).toContain('[ ] pending')
  })

  it('does not color ordered list markers separately', async () => {
    const output = await renderMarkdownToTerminal('1. item', { useColor: true, width: 80 })

    expect(output).toContain('1. ')
    expect(output).toContain('\x1b[38;2;205;214;244mitem')
    expect(output).not.toContain('\x1b[38;2;203;166;247m1.')
  })

  it('renders nested blockquotes with repeated quote rails', async () => {
    const output = await renderMarkdownToTerminal(
      ['> outer', '>> inner'].join('\n'),
      { useColor: false, width: 80 }
    )

    expect(output).toContain('> outer')
    expect(output).toContain('> > inner')
  })
})

describe('parseMdvArgs', () => {
  it('accepts mdv no-style alias', () => {
    expect(parseMdvArgs(['--no-mdv', 'doc.md'])).toEqual({
      inputFile: 'doc.md',
      noStyle: true,
    })
  })

  it('accepts backward-compatible no-glow flag', () => {
    expect(parseGlowmArgs(['--no-glow', 'doc.md'])).toEqual({
      inputFile: 'doc.md',
      noStyle: true,
    })
  })

  it('accepts theme selection and theme listing flags', () => {
    expect(parseMdvArgs(['--theme', 'dracula', '--list-themes', '--preview'])).toEqual({
      theme: 'dracula',
      listThemes: true,
      previewThemes: true,
    })
  })

  it('accepts themes subcommand', () => {
    expect(parseMdvArgs(['themes'])).toEqual({
      listThemes: true,
    })
  })

  it('accepts color control and doctor flags', () => {
    expect(parseMdvArgs(['doctor', '--color', 'always', '--no-color', '--no-mermaid', '--mermaid', 'render'])).toEqual({
      doctor: true,
      color: 'never',
      noMermaid: false,
      mermaid: 'render',
    })
  })

  it('accepts hyperlink control flags', () => {
    expect(parseMdvArgs(['--hyperlinks', 'always', '--hyperlinks=never'])).toEqual({
      hyperlinks: 'never',
    })
  })
})

describe('runMdvCli', () => {
  it('shows mdv in help output', async () => {
    const stdout: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    try {
      const code = await runMdvCli(['--help'])
      expect(code).toBe(0)
    } finally {
      process.stdout.write = originalWrite
    }

    expect(stdout.join('')).toContain('mdv [OPTIONS] [FILE]')
    expect(stdout.join('')).toContain('mdv themes')
    expect(stdout.join('')).toContain('mdv doctor')
    expect(stdout.join('')).toContain('--theme NAME')
    expect(stdout.join('')).toContain('--list-themes')
    expect(stdout.join('')).toContain('--color MODE')
    expect(stdout.join('')).toContain('--hyperlinks MODE')
    expect(stdout.join('')).toContain('--no-mermaid')
    expect(stdout.join('')).toContain('--mermaid MODE')
    expect(stdout.join('')).toContain('--version')
    expect(stdout.join('')).not.toContain('glowm [OPTIONS] [FILE]')
    expect(stdout.join('')).not.toContain('mdview [OPTIONS] [FILE]')
  })

  it('lists built-in themes', async () => {
    const stdout: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    try {
      const code = await runMdvCli(['themes'])
      expect(code).toBe(0)
    } finally {
      process.stdout.write = originalWrite
    }

    expect(stdout.join('')).toContain('catppuccin-mocha (default)')
    expect(stdout.join('')).toContain('dracula')
    expect(stdout.join('')).toContain('tokyo-night')
  })

  it('supports theme previews', async () => {
    const stdout: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    try {
      const code = await runMdvCli(['themes', '--preview', '--color', 'always'])
      expect(code).toBe(0)
    } finally {
      process.stdout.write = originalWrite
    }

    expect(stdout.join('')).toContain('catppuccin-mocha (default)')
    expect(stdout.join('')).toContain('\x1b[38;2;')
    expect(stdout.join('')).toContain('accent')
    expect(stdout.join('')).toContain('A')
    expect(stdout.join('')).toContain('B')
    expect(stdout.join('')).toContain('►')
  })

  it('shows version output', async () => {
    const stdout: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    try {
      const code = await runMdvCli(['--version'])
      expect(code).toBe(0)
    } finally {
      process.stdout.write = originalWrite
    }

    expect(stdout.join('')).toContain('1.1.3')
  })

  it('shows doctor output', async () => {
    const stdout: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    try {
      const code = await runMdvCli(['doctor', '--theme', 'dracula', '--color', 'never'])
      expect(code).toBe(0)
    } finally {
      process.stdout.write = originalWrite
    }

    expect(stdout.join('')).toContain('mdv doctor')
    expect(stdout.join('')).toContain('theme: dracula')
    expect(stdout.join('')).toContain('mermaid: render')
    expect(stdout.join('')).toContain('color: never')
    expect(stdout.join('')).toContain('hyperlinks: auto')
    expect(stdout.join('')).toContain('hyperlink-output:')
  })

  it('shows helpful theme errors', async () => {
    const stderr: string[] = []
    const originalWrite = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stderr.write

    try {
      const code = await runMdvCli(['--theme', 'bad-theme', 'README.md'])
      expect(code).toBe(1)
    } finally {
      process.stderr.write = originalWrite
    }

    expect(stderr.join('')).toContain('Run "mdv themes"')
  })

  it('keeps mermaid source when no-mermaid is enabled', async () => {
    const stdout: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    const dir = mkdtempSync(join(tmpdir(), 'mdv-test-'))
    const file = join(dir, 'sample.md')
    writeFileSync(file, '```mermaid\ngraph LR\n  A --> B\n```\n', 'utf8')
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    try {
      const code = await runMdvCli(['--no-mermaid', '--color', 'never', file])
      expect(code).toBe(0)
    } finally {
      process.stdout.write = originalWrite
      rmSync(dir, { recursive: true, force: true })
    }

    const output = stdout.join('')
    expect(output).toContain('```mermaid')
    expect(output).toContain('graph LR')
    expect(output).not.toContain('```text')
  })

  it('keeps mermaid source when mermaid mode is source', async () => {
    const stdout: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    const dir = mkdtempSync(join(tmpdir(), 'mdv-test-'))
    const file = join(dir, 'sample.md')
    writeFileSync(file, '```mermaid\ngraph LR\n  A --> B\n```\n', 'utf8')
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    try {
      const code = await runMdvCli(['--mermaid', 'source', '--color', 'never', file])
      expect(code).toBe(0)
    } finally {
      process.stdout.write = originalWrite
      rmSync(dir, { recursive: true, force: true })
    }

    const output = stdout.join('')
    expect(output).toContain('```mermaid')
    expect(output).not.toContain('```text')
  })

  it('renders mermaid when mermaid mode is render', async () => {
    const stdout: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    const dir = mkdtempSync(join(tmpdir(), 'mdv-test-'))
    const file = join(dir, 'sample.md')
    writeFileSync(file, '```mermaid\ngraph LR\n  A --> B\n```\n', 'utf8')
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write

    try {
      const code = await runMdvCli(['--no-mermaid', '--mermaid', 'render', '--color', 'never', file])
      expect(code).toBe(0)
    } finally {
      process.stdout.write = originalWrite
      rmSync(dir, { recursive: true, force: true })
    }

    const output = stdout.join('')
    expect(output).toContain('```text')
    expect(output).not.toContain('```mermaid')
  })

  it('keeps the legacy runGlowmCli alias working', async () => {
    await expect(runGlowmCli(['--help'])).resolves.toBe(0)
  })
})

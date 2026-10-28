import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripVTControlCharacters as stripAnsi } from 'node:util'
import { marked, type Tokens } from 'marked'
import React from 'react'
import { call as copy } from '../../commands/copy/copy.js'
import { Markdown, StreamingMarkdown } from '../../components/Markdown.js'
import { MarkdownTable } from '../../components/MarkdownTable.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import { processMemoryFile, stripHtmlComments } from '../../utils/claudemd.js'
import { enableConfigs } from '../../utils/config.js'
import { applyMarkdown } from '../../utils/markdown.js'
import { renderToString } from '../../utils/staticRender.js'
import baseline from './markdownRendering.baseline.json'

// Run in a fresh process: exercise real rendering/configuration without shared
// module mocks or settings mutations from the rest of the unit suite.
enableConfigs()
const output: Record<string, unknown> = {}
for (const [name, fixture] of Object.entries(baseline)) {
  if (typeof fixture !== 'object' || !('terminal' in fixture)) continue
  let codes: { code: string; lang?: string }[] = []
  if (fixture.codes.length) {
    const picker = await copy(
      () => { throw new Error('Expected the code block picker') },
      {
        messages: [{
          type: 'assistant',
          message: { content: [{ type: 'text', text: fixture.input }] },
        }],
      } as unknown as Parameters<typeof copy>[1],
      '',
    )
    if (!React.isValidElement<{ codeBlocks: typeof codes }>(picker)) {
      throw new Error('Missing code block picker')
    }
    codes = picker.props.codeBlocks
  }
  output[name] = {
    input: fixture.input,
    terminal: stripAnsi(applyMarkdown(fixture.input, 'dark')),
    codes,
  }
}
const table = marked.lexer(baseline.table.input).find(t => t.type === 'table') as Tokens.Table
output.tableComponent = await renderToString(
  <MarkdownTable token={table} highlight={null} forceWidth={80} />, 80,
)
const defaultState = getDefaultAppState()
const state = {
  ...defaultState,
  settings: { ...defaultState.settings, syntaxHighlightingDisabled: true },
}
const combined = [baseline.headings.input, baseline.tight.input, baseline.table.input].join('\n\n')
for (const Component of [Markdown, StreamingMarkdown]) {
  output[Component.name] = await renderToString(
    <AppStateProvider initialState={state}><Component>{combined}</Component></AppStateProvider>, 80,
  )
}
output.memory = { input: baseline.memory.input, ...stripHtmlComments(baseline.memory.input) }
const dir = process.argv[2]!
await mkdir(dir, { recursive: true })
await writeFile(join(dir, 'CLAUDE.md'), baseline.memory.input)
await writeFile(join(dir, 'included.md'), 'Included rule\n')
output.memoryFiles = (
  await processMemoryFile(join(dir, 'CLAUDE.md'), 'Project', new Set(), true)
).map(f => ({ name: f.path.split(/[\\/]/).at(-1), content: f.content }))
console.log(JSON.stringify(output))

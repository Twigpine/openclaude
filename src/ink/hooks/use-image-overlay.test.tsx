import { PassThrough } from 'node:stream'
import { expect, test } from 'bun:test'
import React from 'react'
import { Box, createRoot, Text } from '../../ink.js'
import instances from '../instances.js'
import { useImageOverlay } from './use-image-overlay.js'

function Probe({ k, show }: { k: string; show: boolean }): React.ReactNode {
  const ref = useImageOverlay(
    77,
    show ? { key: k, draw: () => `<draw ${k}>`, clear: '<clear>' } : null,
  )
  return (
    <Box flexDirection="column">
      <Text>hello</Text>
      <Box ref={ref} width={4} height={2} />
      <Text>after</Text>
    </Box>
  )
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 5))
}

// Tests render synchronously inside React's commit (onImmediateRender), so
// that frame runs before layout effects register the overlay; in the app
// the render is deferred past them. An explicit onRender() afterwards gives
// the frame that sees the new declaration (as useDeclaredCursor notes).
async function show(
  root: { render: (n: React.ReactNode) => void },
  stdout: NodeJS.WriteStream,
  node: React.ReactNode,
): Promise<void> {
  root.render(node)
  await settle()
  instances.get(stdout)!.onRender()
  await settle()
}

test('an image overlay is drawn at its box, skipped when unchanged, redrawn on change, cleared on removal', async () => {
  const stdout = new PassThrough()
  const tty = stdout as unknown as NodeJS.WriteStream & { columns: number; rows: number }
  tty.columns = 40
  tty.rows = 20
  // Main-screen TTY rendering: the frame ends on a fresh line, which is
  // where the renderer's cursor bookkeeping (frame.cursor) says it is.
  tty.isTTY = true
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const root = await createRoot({ stdout: tty, patchConsole: false })
  try {
    await show(root, tty, <Probe k="a" show />)
    // Frame: hello, 2 box rows, after, then the cursor on row 4. The image
    // is drawn from the saved cursor 3 rows up (the box's top row), and the
    // cursor is restored.
    expect(output).toContain('\x1b7\x1b[3A<draw a>\x1b8')

    // Nothing changed: the next frame does not resend the image.
    output = ''
    instances.get(tty)!.onRender()
    await settle()
    expect(output).not.toContain('<draw')

    await show(root, tty, <Probe k="b" show />)
    expect(output).toContain('<draw b>')

    output = ''
    await show(root, tty, <Probe k="b" show={false} />)
    expect(output).toContain('<clear>')
    expect(output).not.toContain('<draw')
  } finally {
    root.unmount()
  }
})

test('graceful shutdown (which skips unmount) still clears drawn images', async () => {
  const stdout = new PassThrough()
  const tty = stdout as unknown as NodeJS.WriteStream & { columns: number; rows: number }
  tty.columns = 40
  tty.rows = 20
  // Not a TTY: the synchronous fd-1 cleanup write is skipped, so this test
  // checks the bookkeeping without writing escapes to the test runner.
  stdout.on('data', () => {})
  const root = await createRoot({ stdout: tty, patchConsole: false })
  root.render(<Probe k="a" show />)
  await settle()
  const ink = instances.get(tty)!
  ink.onRender()
  const placed = (ink as unknown as { placedImages: Map<number, unknown> }).placedImages
  expect(placed.size).toBe(1)
  ink.detachForShutdown()
  expect(placed.size).toBe(0)
  root.unmount()
})

async function renderOnce(rows: number, node: React.ReactNode): Promise<string> {
  const stdout = new PassThrough()
  const tty = stdout as unknown as NodeJS.WriteStream & { columns: number; rows: number }
  tty.columns = 40
  tty.rows = rows
  tty.isTTY = true
  let output = ''
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const root = await createRoot({ stdout: tty, patchConsole: false })
  try {
    await show(root, tty, node)
    return output
  } finally {
    root.unmount()
  }
}

function TopImage(): React.ReactNode {
  const ref = useImageOverlay(78, { key: 'top', draw: () => '<draw top>', clear: '<clear>' })
  return (
    <Box flexDirection="column">
      <Box ref={ref} width={4} height={2} />
      <Text>one</Text>
      <Text>two</Text>
      <Text>three</Text>
    </Box>
  )
}

test('a box pushed into scrollback by the cursor row is not drawn', async () => {
  // 5-row frame: the cursor's line after it scrolls the top row away in a
  // 5-row terminal, so the box at row 0 is no longer fully visible.
  expect(await renderOnce(5, <TopImage />)).not.toContain('<draw top>')
  expect(await renderOnce(6, <TopImage />)).toContain('<draw top>')
})

function ClippedImage(): React.ReactNode {
  const ref = useImageOverlay(79, { key: 'clip', draw: () => '<draw clip>', clear: '<clear>' })
  return (
    <Box flexDirection="column">
      <Box height={2} overflowY="hidden" flexDirection="column">
        <Box ref={ref} width={4} height={4} flexShrink={0} />
      </Box>
      {/* Enough rows below that only the clip, not the frame edge, can stop
          the 4-row image from spilling over them. */}
      <Text>below 1</Text>
      <Text>below 2</Text>
      <Text>below 3</Text>
      <Text>below 4</Text>
    </Box>
  )
}

test('an image cut by an ancestor that hides overflow is not drawn', async () => {
  expect(await renderOnce(20, <ClippedImage />)).not.toContain('<draw clip>')
})

function BorderedImage({ height }: { height: number }): React.ReactNode {
  const ref = useImageOverlay(80, { key: `b${height}`, draw: () => `<draw b${height}>`, clear: '<clear>' })
  return (
    <Box flexDirection="column">
      <Box height={6} overflowY="hidden" borderStyle="round" flexDirection="column">
        <Box ref={ref} width={4} height={height} flexShrink={0} />
      </Box>
      <Text>below 1</Text>
      <Text>below 2</Text>
    </Box>
  )
}

test('clipping excludes a clipping parent’s border, as the text renderer does', async () => {
  // A 6-row bordered box has 4 inner rows: a 4-row image fits, a 5-row one
  // would cover the bottom border.
  expect(await renderOnce(20, <BorderedImage height={4} />)).toContain('<draw b4>')
  expect(await renderOnce(20, <BorderedImage height={5} />)).not.toContain('<draw b5>')
})

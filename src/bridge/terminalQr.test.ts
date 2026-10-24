import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { create, toString as qrToString } from 'qrcode'

// Baseline hashes preserve UTF-8 block orientation, margins and newlines.
const cases = [
  { name: 'short', text: 'OpenClaude', size: 21,
    hash: '41a36c2faefdd6de7fe1b77037fa2ef1eeb39e0c8f08ab301b18eaa1ccfe90fe' },
  { name: 'Unicode', text: 'Connect 😀 café 中文', size: 25,
    hash: 'd8ea7e54a8b468d797e449c5cf586167eac0317433ce8b397ce8b60ca2a87752' },
  { name: 'large', text: 'session:abc123/😀?key=xyz&n=42;'.repeat(48), size: 133,
    hash: '3c29fcd0e7a3881f98aa60ae5367329c60d314d9e3c3fb58be0f942cabdc02ba' },
]

describe('terminal QR output used by bridge, session and mobile', () => {
  for (const fixture of cases) {
    test(fixture.name, async () => {
      const options = { type: 'utf8' as const, errorCorrectionLevel: 'L' as const }
      const output = await qrToString(fixture.text, options)
      expect(createHash('sha256').update(output).digest('hex')).toBe(fixture.hash)
      // Bridge callers also pass small; UTF-8 output is already half-height.
      expect(await qrToString(fixture.text, { ...options, small: true })).toBe(output)

      const { modules } = create(fixture.text, options)
      expect(modules.size).toBe(fixture.size)
      const rows = output.split('\n')
      expect(rows).toHaveLength(Math.ceil(fixture.size / 2) + 4)
      expect(rows.every(row => row.length === fixture.size + 8)).toBe(true)
      expect(rows.slice(0, 2).concat(rows.slice(-2)).every(row => !row.trim())).toBe(true)

      // Expand the terminal glyphs back into modules to catch clipping,
      // inversion and swapped half-blocks, including the odd final row.
      const pixels = new Map([
        [' ', [0, 0]], ['▀', [1, 0]], ['▄', [0, 1]], ['█', [1, 1]],
      ])
      for (let y = 0; y < fixture.size + 1; y++) {
        const row = rows[2 + Math.floor(y / 2)]!
        expect(row.slice(0, 4) + row.slice(-4)).toBe(' '.repeat(8))
        for (let x = 0; x < fixture.size; x++) {
          const pixel = pixels.get(row[x + 4]!)?.[y % 2]
          expect(pixel).toBe(y < fixture.size ? modules.get(y, x) : 0)
        }
      }
    })
  }
})

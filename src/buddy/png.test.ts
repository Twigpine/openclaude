import { describe, expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'
import { encodePng } from './png.js'

function chunks(png: Buffer): Array<{ type: string; data: Buffer }> {
  const out: Array<{ type: string; data: Buffer }> = []
  let p = 8
  while (p < png.length) {
    const len = png.readUInt32BE(p)
    out.push({ type: png.toString('ascii', p + 4, p + 8), data: png.subarray(p + 8, p + 8 + len) })
    p += 12 + len
  }
  return out
}

describe('encodePng', () => {
  test('writes a valid RGBA PNG whose pixels round-trip', () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 9, 8, 7, 6])
    const png = encodePng(2, 2, rgba)
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const parts = chunks(png)
    expect(parts.map(c => c.type)).toEqual(['IHDR', 'IDAT', 'IEND'])
    const ihdr = parts[0]!.data
    expect(ihdr.readUInt32BE(0)).toBe(2)
    expect(ihdr.readUInt32BE(4)).toBe(2)
    expect([ihdr[8], ihdr[9]]).toEqual([8, 6])
    const raw = inflateSync(parts[1]!.data)
    // Each row: filter byte 0, then the row's RGBA bytes.
    expect([...raw]).toEqual([0, ...rgba.subarray(0, 8), 0, ...rgba.subarray(8, 16)])
  })

  test('rejects a buffer of the wrong size', () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow()
  })
})

import { describe, expect, test } from 'bun:test'
import { kittyDelete, kittyShowPng } from './kittyGraphics.js'

const APC = /\x1b_G([^;\x1b]*)(?:;([^\x1b]*))?\x1b\\/g

describe('kitty graphics', () => {
  test('a small image is one command that keeps the cursor still and asks for no reply', () => {
    const seq = kittyShowPng(new Uint8Array([1, 2, 3]), { id: 5, columns: 11, rows: 4 })
    const cmds = [...seq.matchAll(APC)]
    expect(cmds).toHaveLength(1)
    expect(cmds[0]![1]).toBe('a=T,f=100,t=d,i=5,c=11,r=4,C=1,q=2')
    expect(Buffer.from(cmds[0]![2]!, 'base64')).toEqual(Buffer.from([1, 2, 3]))
  })

  test('a large image is split into 4096-byte chunks that reassemble exactly', () => {
    const png = new Uint8Array(10_000).map((_, i) => i % 251)
    const cmds = [...kittyShowPng(png, { id: 9, columns: 2, rows: 1 }).matchAll(APC)]
    expect(cmds.length).toBe(4)
    expect(cmds[0]![1]).toBe('a=T,f=100,t=d,i=9,c=2,r=1,C=1,q=2,m=1')
    expect(cmds.slice(1, -1).every(c => c[1] === 'm=1,q=2')).toBe(true)
    expect(cmds.at(-1)![1]).toBe('m=0,q=2')
    for (const c of cmds.slice(0, -1)) {
      expect(c[2]!.length).toBe(4096)
      expect(c[2]).not.toContain('=')
    }
    expect(Buffer.from(cmds.map(c => c[2]).join(''), 'base64')).toEqual(Buffer.from(png))
  })

  test('delete frees the image by id, quietly', () => {
    expect(kittyDelete(42)).toBe('\x1b_Ga=d,d=I,i=42,q=2\x1b\\')
  })
})

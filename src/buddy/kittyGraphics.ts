// Escape sequences for the kitty terminal graphics protocol
// (https://sw.kovidgoyal.net/kitty/graphics-protocol/), used by kitty,
// Ghostty, WezTerm and iTerm2 3.6+. Only the subset the hero sprite needs:
// transmit-and-display a PNG at the cursor, and delete it again.

const APC = '\x1b_G'
const ST = '\x1b\\'
/** Payloads are sent in base64 chunks of at most 4096 bytes. */
const CHUNK = 4096

function command(keys: string, payload = ''): string {
  return `${APC}${keys}${payload ? `;${payload}` : ''}${ST}`
}

export type KittyPlacement = {
  /** Image id; reusing it replaces the previous image. */
  id: number
  /** Size on screen, in terminal cells. */
  columns: number
  rows: number
}

/**
 * Transmit a PNG and show it at the cursor, scaled into columns × rows
 * cells. The cursor does not move (C=1) and the terminal sends no reply
 * (q=2), so this can sit inside a frame write.
 */
export function kittyShowPng(png: Uint8Array, placement: KittyPlacement): string {
  const data = Buffer.from(png).toString('base64')
  const first = `a=T,f=100,t=d,i=${placement.id},c=${placement.columns},r=${placement.rows},C=1,q=2`
  if (data.length <= CHUNK) return command(first, data)
  let out = ''
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const part = data.slice(offset, offset + CHUNK)
    const more = offset + CHUNK < data.length ? 1 : 0
    // Only the first chunk carries the image keys; the rest carry m= (and q=).
    out += command(offset === 0 ? `${first},m=${more}` : `m=${more},q=2`, part)
  }
  return out
}

/** Remove an image (and free its data) wherever it is on screen. */
export function kittyDelete(id: number): string {
  return command(`a=d,d=I,i=${id},q=2`)
}

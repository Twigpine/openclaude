import { createContext } from 'react'
import type { DOMElement } from '../dom.js'

/**
 * An image drawn by the terminal on top of a box, for terminals with an
 * image protocol. The renderer knows nothing about the protocol: it moves
 * the cursor to the box's top-left cell, writes `draw()`, and puts the
 * cursor back. `draw()` must leave the cursor where it found it and must
 * replace any earlier image with the same id; `clear` removes the image.
 */
export type ImageOverlay = {
  /** The box the image covers (its nodeCache rect gives the position). */
  readonly node: DOMElement
  /** Changes whenever the picture changes; an unchanged key at an
   *  unchanged position is not redrawn unless the frame itself changed. */
  readonly key: string
  readonly draw: () => string
  readonly clear: string
}

/** Register (or with `null`, remove) the overlay with this id. */
export type ImageOverlaySetter = (id: number, overlay: ImageOverlay | null) => void

const ImageOverlayContext = createContext<ImageOverlaySetter>(() => {})

export default ImageOverlayContext

import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import ImageOverlayContext, {
  type ImageOverlay,
} from '../components/ImageOverlayContext.js'
import type { DOMElement } from '../dom.js'

/**
 * Draw a terminal image over a box. Returns a ref callback for that box;
 * the renderer places the image at the box's position after each frame
 * (inside the same synchronized write) and clears it when `overlay` becomes
 * null or the component unmounts.
 *
 * Timing matches useDeclaredCursor: the declaration is made in a layout
 * effect, before the deferred onRender reads it, so the first frame that
 * shows the box already carries the image.
 */
export function useImageOverlay(
  id: number,
  overlay: Omit<ImageOverlay, 'node'> | null,
): (element: DOMElement | null) => void {
  const setOverlay = useContext(ImageOverlayContext)
  const nodeRef = useRef<DOMElement | null>(null)
  const setNode = useCallback((node: DOMElement | null) => {
    nodeRef.current = node
  }, [])

  // No dependency array: re-declare every commit so the latest frame (and a
  // remounted node) always reaches the renderer.
  useLayoutEffect(() => {
    const node = nodeRef.current
    setOverlay(id, overlay && node ? { ...overlay, node } : null)
  })

  useLayoutEffect(() => {
    return () => setOverlay(id, null)
  }, [id, setOverlay])

  return setNode
}

// Procedural pixel canvas for the hero companions.
//
// Heroes are drawn from simple shapes (ellipses, capsules, polygons) in a
// fixed 48×40 design space, then rasterised at a chosen scale. Scale 1 is the
// full-size art; scale 0.5 is the 24×20 half-block sprite that sits beside
// the prompt. Shapes scale cleanly, but faces do not: a 2-pixel eye shrunk to
// one pixel reads as noise. So eyes, mouths and blush are drawn as fixed
// pixel stamps when the canvas is compact (scale < 1), positioned by the same
// design-space coordinates.
//
// Pixels are palette keys ('.' = transparent), the same frame format the
// renderer turns into half-block runs.

export const HERO_DESIGN_WIDTH = 48
export const HERO_DESIGN_HEIGHT = 40

export const HERO_PALETTE = {
  K: '#231815', // outline
  B: '#8f5d3d', // marten fur
  b: '#a8744c', // fur highlight
  D: '#5f3c29', // fur shadow, paws, boots
  C: '#f4dca6', // cream belly, horns
  E: '#17110f', // eye
  W: '#ffffff', // eye glint
  N: '#3b2622', // nose, mouth
  P: '#ee8f86', // blush, inner ear
  G: '#226633', // hood green
  g: '#4fae54', // tunic green
  R: '#d8423c', // feather, scarf, heart
  S: '#f0c8a0', // skin
  H: '#7a522e', // hair, wood
  Y: '#f2c14e', // gold trim
  X: '#c8cdd2', // steel
  p: '#b98af0', // light purple
  Q: '#7a46be', // robe purple
  w: '#f1f2f6', // white cloth, beard
  n: '#3a3d46', // dark grey
  M: '#5b606c', // ninja grey
  V: '#2f4a8c', // navy coat
  d: '#ee6a4c', // dragon scales
  o: '#f58a66', // dragon highlight
  F: '#b83a2e', // dragon wing
  O: '#ffa23a', // flame orange
  A: '#ffe066', // spark yellow
  u: '#a5dcff', // visor blue
  U: '#3f78e0', // suit blue
  T: '#3ba99a', // octopus teal
  t: '#7fd6c2', // octopus highlight
  L: '#1c1e23', // leather jacket
  l: '#565d6b', // leather sheen
  h: '#c3c6cc', // salt-and-pepper hair
  a: '#7c8089', // hair shadow
  c: '#5fe3ff', // chip glow
} as const

export type PaletteKey = keyof typeof HERO_PALETTE
type Pixel = PaletteKey | '.'

export type EyeStyle = 'open' | 'up' | 'down' | 'shut' | 'happy'
export type MouthStyle = 'flat' | 'smile' | 'frown' | 'o'

export type HeroCanvas = {
  /** True below scale 1: faces switch to fixed pixel stamps. */
  readonly compact: boolean
  ell(cx: number, cy: number, rx: number, ry: number, c: PaletteKey): void
  cap(x1: number, y1: number, x2: number, y2: number, r: number, c: PaletteKey): void
  poly(points: ReadonlyArray<readonly [number, number]>, c: PaletteKey): void
  /** One device pixel at a design-space point. */
  dot(x: number, y: number, c: PaletteKey): void
  /** A run of device pixels to the right of a design-space point. */
  row(x: number, y: number, n: number, c: PaletteKey): void
  /** A small pixel pattern, top-left at a design-space point, unscaled. */
  stamp(x: number, y: number, pattern: readonly string[]): void
  eye(x: number, y: number, style: EyeStyle): void
  mouth(x: number, y: number, style: MouthStyle): void
  blush(x: number, y: number): void
}

export type HeroRaster = {
  canvas: HeroCanvas
  width: number
  height: number
  /** Mirror the pixels drawn so far left-to-right. */
  flip(): void
  /** Outline every shape (`outline` pixels thick, default 1) and return
   *  the rows as palette strings. */
  finish(outline?: number): string[]
  /** Like finish, plus, for each outline pixel, the index of the nearest
   *  drawn pixel (-1 elsewhere), so an outline can take that pixel's colour. */
  finishWithSources(outline?: number): { rows: string[]; source: Int32Array }
}

const MIN_RADIUS = 0.55

export function createHeroRaster(scale: number): HeroRaster {
  const width = Math.round(HERO_DESIGN_WIDTH * scale)
  const height = Math.round(HERO_DESIGN_HEIGHT * scale)
  const buf: Pixel[] = new Array<Pixel>(width * height).fill('.')
  const compact = scale < 1
  // From scale 2 up there are enough pixels to draw faces as smooth curves
  // instead of pixel-art dots.
  const smooth = scale >= 2
  // Above scale 1 a design pixel covers several device pixels, so single
  // dots (glints, mouths, sparks) become blocks instead of specks.
  const block = Math.max(1, Math.round(scale))

  const put = (x: number, y: number, c: PaletteKey): void => {
    const px = Math.floor(x)
    const py = Math.floor(y)
    if (px >= 0 && px < width && py >= 0 && py < height) buf[py * width + px] = c
  }

  const fillEllipse = (cx: number, cy: number, rx: number, ry: number, c: PaletteKey): void => {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x + 0.5 - cx) / rx
        const dy = (y + 0.5 - cy) / ry
        if (dx * dx + dy * dy <= 1) put(x, y, c)
      }
    }
  }

  const fillCapsule = (x1: number, y1: number, x2: number, y2: number, r: number, c: PaletteKey): void => {
    const vx = x2 - x1
    const vy = y2 - y1
    const len2 = vx * vx + vy * vy || 1
    for (let y = Math.floor(Math.min(y1, y2) - r); y <= Math.ceil(Math.max(y1, y2) + r); y++) {
      for (let x = Math.floor(Math.min(x1, x2) - r); x <= Math.ceil(Math.max(x1, x2) + r); x++) {
        const px = x + 0.5 - x1
        const py = y + 0.5 - y1
        const k = Math.max(0, Math.min(1, (px * vx + py * vy) / len2))
        const ex = px - k * vx
        const ey = py - k * vy
        if (ex * ex + ey * ey <= r * r) put(x, y, c)
      }
    }
  }

  const fillPolygon = (pts: ReadonlyArray<readonly [number, number]>, c: PaletteKey): void => {
    const xs = pts.map(p => p[0])
    const ys = pts.map(p => p[1])
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
        const px = x + 0.5
        const py = y + 0.5
        let inside = false
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i]!
          const [xj, yj] = pts[j]!
          if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside
          }
        }
        if (inside) put(x, y, c)
      }
    }
  }

  const stampAt = (dx: number, dy: number, pattern: readonly string[]): void => {
    pattern.forEach((line, row) => {
      for (let col = 0; col < line.length; col++) {
        const ch = line[col]!
        if (ch !== '.') put(dx + col, dy + row, ch as PaletteKey)
      }
    })
  }

  const canvas: HeroCanvas = {
    compact,
    ell: (cx, cy, rx, ry, c) =>
      fillEllipse(cx * scale, cy * scale, Math.max(MIN_RADIUS, rx * scale), Math.max(MIN_RADIUS, ry * scale), c),
    cap: (x1, y1, x2, y2, r, c) =>
      fillCapsule(x1 * scale, y1 * scale, x2 * scale, y2 * scale, Math.max(MIN_RADIUS, r * scale), c),
    poly: (points, c) => fillPolygon(points.map(([x, y]) => [x * scale, y * scale] as const), c),
    dot: (x, y, c) => {
      const px = Math.floor(x * scale)
      const py = Math.floor(y * scale)
      for (let dy = 0; dy < block; dy++) for (let dx = 0; dx < block; dx++) put(px + dx, py + dy, c)
    },
    row: (x, y, n, c) => {
      const px = Math.floor(x * scale)
      const py = Math.floor(y * scale)
      for (let dy = 0; dy < block; dy++) for (let i = 0; i < n * block; i++) put(px + i, py + dy, c)
    },
    stamp: (x, y, pattern) => stampAt(Math.floor(x * scale), Math.floor(y * scale), pattern),
    eye(x, y, style) {
      if (compact) {
        const ex = Math.round(x * scale) - 1
        const ey = Math.round(y * scale) - 1
        switch (style) {
          case 'shut':
          case 'down':
            return stampAt(ex, ey + 1, ['EE'])
          case 'happy':
            return stampAt(ex, ey, ['.E.', 'E.E'])
          case 'up':
            return stampAt(ex, ey - 1, ['WE', 'EE'])
          default:
            return stampAt(ex, ey, ['WE', 'EE'])
        }
      }
      if (smooth) {
        switch (style) {
          case 'shut':
            // A soft downward curve, like a closed, relaxed eye.
            canvas.cap(x - 1.9, y + 0.5, x, y + 1.3, 0.45, 'E')
            canvas.cap(x, y + 1.3, x + 1.9, y + 0.5, 0.45, 'E')
            return
          case 'happy':
            canvas.cap(x - 1.9, y + 1.2, x, y - 0.3, 0.5, 'E')
            canvas.cap(x, y - 0.3, x + 1.9, y + 1.2, 0.5, 'E')
            return
          case 'down':
            canvas.ell(x, y + 1, 1.9, 1.6, 'E')
            canvas.ell(x - 0.8, y + 0.4, 0.6, 0.5, 'W')
            return
          default: {
            const dy = style === 'up' ? -1 : 0
            canvas.ell(x, y + dy, 1.9, 2.5, 'E')
            canvas.ell(x - 0.75, y + dy - 1.1, 0.75, 0.85, 'W')
            canvas.ell(x + 0.8, y + dy + 1.1, 0.35, 0.35, 'W')
            return
          }
        }
      }
      if (style === 'shut') return canvas.row(x - 2, y + 1, 4, 'E')
      if (style === 'happy') {
        canvas.dot(x - 2, y + 1, 'E')
        canvas.dot(x - 1, y, 'E')
        canvas.dot(x, y, 'E')
        canvas.dot(x + 1, y + 1, 'E')
        return
      }
      if (style === 'down') {
        canvas.ell(x, y + 1, 1.9, 1.7, 'E')
        canvas.dot(x - 1, y, 'W')
        return
      }
      const dy = style === 'up' ? -1 : 0
      canvas.ell(x, y + dy, 1.9, 2.5, 'E')
      canvas.dot(x - 1, y + dy - 2, 'W')
      canvas.dot(x - 1, y + dy - 1, 'W')
    },
    mouth(x, y, style) {
      if (compact) {
        const mx = Math.round(x * scale)
        const my = Math.round(y * scale)
        return stampAt(mx, my, style === 'smile' ? ['NN'] : ['N'])
      }
      if (smooth) {
        switch (style) {
          case 'smile':
            canvas.cap(x - 1, y + 0.1, x + 0.5, y + 1, 0.4, 'N')
            canvas.cap(x + 0.5, y + 1, x + 2, y + 0.1, 0.4, 'N')
            return
          case 'frown':
            canvas.cap(x - 1, y + 1, x + 0.5, y + 0.2, 0.4, 'N')
            canvas.cap(x + 0.5, y + 0.2, x + 2, y + 1, 0.4, 'N')
            return
          case 'o':
            canvas.ell(x + 0.5, y + 0.7, 0.85, 0.95, 'N')
            return
          default:
            canvas.cap(x - 0.2, y + 0.4, x + 1.3, y + 0.4, 0.35, 'N')
            return
        }
      }
      switch (style) {
        case 'smile':
          canvas.dot(x - 1, y, 'N')
          canvas.dot(x, y + 1, 'N')
          canvas.dot(x + 1, y + 1, 'N')
          canvas.dot(x + 2, y, 'N')
          return
        case 'frown':
          canvas.dot(x - 1, y + 1, 'N')
          canvas.dot(x, y, 'N')
          canvas.dot(x + 1, y, 'N')
          canvas.dot(x + 2, y + 1, 'N')
          return
        case 'o':
          canvas.row(x, y, 2, 'N')
          canvas.row(x, y + 1, 2, 'N')
          return
        default:
          canvas.row(x, y, 2, 'N')
      }
    },
    blush(x, y) {
      if (compact) return stampAt(Math.round(x * scale), Math.round(y * scale), ['P'])
      canvas.ell(x, y, 1.4, 0.9, 'P')
    },
  }

  return {
    canvas,
    width,
    height,
    flip() {
      for (let y = 0; y < height; y++) {
        const line = buf.slice(y * width, (y + 1) * width).reverse()
        for (let x = 0; x < width; x++) buf[y * width + x] = line[x]!
      }
    },
    finish(outline = 1) {
      return this.finishWithSources(outline).rows
    },
    finishWithSources(outline = 1) {
      // Outline = every empty pixel within `outline` of a drawn one. A
      // two-pass chamfer distance transform (3 per straight step, 4 per
      // diagonal) finds them in linear time and keeps thick outlines round;
      // it also carries along which drawn pixel is nearest.
      const far = 1 << 30
      const dist = new Int32Array(width * height)
      const near = new Int32Array(width * height).fill(-1)
      for (let i = 0; i < dist.length; i++) {
        if (buf[i] === '.') dist[i] = far
        else near[i] = i
      }
      const relax = (i: number, j: number, step: number): void => {
        const d = dist[j]! + step
        if (d < dist[i]!) {
          dist[i] = d
          near[i] = near[j]!
        }
      }
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x
          if (dist[i] === 0) continue
          if (x > 0) relax(i, i - 1, 3)
          if (y > 0) {
            relax(i, i - width, 3)
            if (x > 0) relax(i, i - width - 1, 4)
            if (x < width - 1) relax(i, i - width + 1, 4)
          }
        }
      }
      for (let y = height - 1; y >= 0; y--) {
        for (let x = width - 1; x >= 0; x--) {
          const i = y * width + x
          if (dist[i] === 0) continue
          if (x < width - 1) relax(i, i + 1, 3)
          if (y < height - 1) {
            relax(i, i + width, 3)
            if (x < width - 1) relax(i, i + width + 1, 4)
            if (x > 0) relax(i, i + width - 1, 4)
          }
        }
      }
      const limit = outline * 3
      const source = new Int32Array(width * height).fill(-1)
      const rows: string[] = []
      for (let y = 0; y < height; y++) {
        const chars: string[] = new Array(width)
        for (let x = 0; x < width; x++) {
          const i = y * width + x
          const d = dist[i]!
          if (d === 0) chars[x] = buf[i]!
          else if (d <= limit) {
            chars[x] = 'K'
            source[i] = near[i]!
          } else chars[x] = '.'
        }
        rows.push(chars.join(''))
      }
      return { rows, source }
    },
  }
}

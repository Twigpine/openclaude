import { describe, expect, test } from 'bun:test'
import {
  corsair,
  ember,
  FORM_NAMES,
  FORMS,
  kage,
  kaio,
  merlin,
  parseForm,
  robinhood,
  SPECIES,
  strawhat,
  keynote,
  twig,
} from './types.js'

describe('species constants', () => {
  // The constants are runtime-constructed via String.fromCharCode (see the
  // canary note in types.ts) and force-cast to their literal types — a single
  // wrong byte would produce a different runtime string that TypeScript
  // cannot catch. Plain literals are safe HERE because test files are never
  // part of the build output the canary check greps.
  test('charCode-encoded constants decode to their declared literals', () => {
    expect(robinhood).toBe('robinhood')
    expect(kaio).toBe('kaio')
    expect(strawhat).toBe('strawhat')
    expect(merlin).toBe('merlin')
    expect(kage).toBe('kage')
    expect(ember).toBe('ember')
    expect(corsair).toBe('corsair')
    expect(twig).toBe('twig')
    expect(keynote).toBe('keynote')
  })

  test('the pool contains each hero exactly once', () => {
    expect(new Set(SPECIES).size).toBe(SPECIES.length)
    expect(SPECIES.length).toBe(7)
  })

  test('twig and keynote are chosen forms only, so the hatch roll never changes', () => {
    expect(SPECIES as readonly string[]).not.toContain(twig)
    expect(SPECIES as readonly string[]).not.toContain(keynote)
    expect(FORMS).toEqual([...SPECIES, twig, keynote])
  })

  test('forms parse from their id or display name, any case', () => {
    expect(parseForm('kaio')).toBe(kaio)
    expect(parseForm('Nova')).toBe(kaio)
    expect(parseForm('INKY')).toBe(strawhat)
    expect(parseForm(' twig ')).toBe(twig)
    expect(parseForm('random')).toBeUndefined()
    for (const form of FORMS) expect(parseForm(FORM_NAMES[form])).toBe(form)
  })
})

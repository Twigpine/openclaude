import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { execFileSync, spawnSync } from 'child_process'
import { cpSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, win32 } from 'path'
import { fileURLToPath } from 'url'
import {
  getClaudeConfigHomeDir,
  getClaudeConfigHomeDirOverrideForTesting,
  setClaudeConfigHomeDirForTesting,
} from '../../utils/envUtils.js'
import {
  acquireSharedMutationLock,
  releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import {
  invalidateCache,
  buildRepoMap,
  extractTagsWithCache,
} from './index.js'
import {
  CACHE_VERSION,
  getCachedTags,
  loadCache,
  saveCache,
  setCachedTags,
  statFile,
} from './cache.js'
import { clearSymbolExtractorCaches, extractTags } from './symbolExtractor.js'
import { buildGraph } from './graph.js'
import { getRepoFiles } from './gitFiles.js'
import { rankFiles } from './pagerank.js'
import { initParser, resolveProjectRoot } from './parser.js'
import { renderMap } from './renderer.js'
import { countTokens } from './tokenize.js'
import type { CacheData, FileTags } from './types.js'

const FIXTURE_ROOT = join(import.meta.dir, '__fixtures__', 'mini-repo')
const FIXTURE_FILES = ['fileA.ts', 'fileB.ts', 'fileC.ts', 'fileD.ts', 'fileE.ts']
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

beforeAll(async () => {
  await initParser()
})

async function withWritableConfigHome<T>(
  callback: (configDir: string) => Promise<T>,
): Promise<T> {
  await acquireSharedMutationLock('context/repoMap/repoMap.test.ts config home')
  const previousConfigHomeOverride = getClaudeConfigHomeDirOverrideForTesting()
  let configDir: string | undefined

  try {
    configDir = mkdtempSync(join(tmpdir(), 'repomap-test-config-'))
    setClaudeConfigHomeDirForTesting(configDir)
    getClaudeConfigHomeDir.cache?.clear?.()
    return await callback(configDir)
  } finally {
    setClaudeConfigHomeDirForTesting(previousConfigHomeOverride)
    getClaudeConfigHomeDir.cache?.clear?.()
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
    }
    releaseSharedMutationLock()
  }
}

// Clean up cache between tests to avoid cross-test interference
afterEach(() => {
  invalidateCache(FIXTURE_ROOT)
  clearSymbolExtractorCaches()
})

describe('symbol extraction', () => {
  test('extracts function and class defs from a TypeScript file', async () => {
    const result = await extractTags('fileC.ts', FIXTURE_ROOT)
    expect(result).not.toBeNull()

    const defs = result!.tags.filter(t => t.kind === 'def')
    const defNames = defs.map(t => t.name)

    expect(defNames).toContain('DataStore')
    expect(defNames).toContain('createStore')
    expect(defNames).toContain('StoreConfig')
    expect(defs.filter(d => d.name === 'StoreConfig')).toHaveLength(1)

    // All defs should have kind='def'
    for (const d of defs) {
      expect(d.kind).toBe('def')
    }
  })

  test('extracts TypeScript const arrow and function expression definitions', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-ts-const-functions-'))
    try {
      writeFileSync(
        join(tempDir, 'actions.ts'),
        [
          'export const makeUser = () => ({ id: 1 })',
          'export const named = function named() { return 1 }',
          '',
        ].join('\n'),
      )

      const result = await extractTags('actions.ts', tempDir)
      expect(result).not.toBeNull()

      const defs = result!.tags
        .filter(tag => tag.kind === 'def')
        .map(tag => tag.name)

      expect(defs).toContain('makeUser')
      expect(defs).toContain('named')

      const map = await buildRepoMap({
        root: tempDir,
        files: ['actions.ts'],
        maxTokens: 1024,
      })
      expect(map.map).toContain('makeUser')
      expect(map.map).toContain('named')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('extracts references to imported symbols', async () => {
    const result = await extractTags('fileA.ts', FIXTURE_ROOT)
    expect(result).not.toBeNull()

    const refs = result!.tags.filter(t => t.kind === 'ref')
    const refNames = refs.map(t => t.name)

    // fileA imports CacheLayer from fileB and StoreConfig from fileC
    expect(refNames).toContain('CacheLayer')
    expect(refNames).toContain('StoreConfig')
  })

  test('parses TSX files with the TSX grammar', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-tsx-'))
    try {
      writeFileSync(
        join(tempDir, 'Widget.tsx'),
        [
          'export function Widget(): JSX.Element {',
          '  return <div className="widget">Hello</div>',
          '}',
          '',
        ].join('\n'),
      )

      const result = await extractTags('Widget.tsx', tempDir)
      expect(result).not.toBeNull()
      expect(result!.tags.some(tag =>
        tag.kind === 'def' && tag.name === 'Widget',
      )).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test('extracts call references from TypeScript files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-ts-calls-'))
    try {
      writeFileSync(
        join(tempDir, 'calls.ts'),
        [
          "import { computeTotal } from './helpers'",
          '',
          'export function run(items: number[]) {',
          '  const total = computeTotal(items)',
          '  const loaded = store.load(total)',
          "  require('legacy')",
          '  return new Widget(loaded)',
          '}',
          '',
        ].join('\n'),
      )

      const result = await extractTags('calls.ts', tempDir)
      expect(result).not.toBeNull()

      const refs = result!.tags.filter(tag => tag.kind === 'ref')
      const refNames = refs.map(tag => tag.name)

      // Plain calls were previously missing entirely.
      expect(refNames).toContain('computeTotal')
      // Constructor references still resolve, as before.
      expect(refNames).toContain('Widget')
      // `require` is module loading, not a symbol reference (matches the
      // JavaScript query).
      expect(refNames).not.toContain('require')
      // Member calls are intentionally excluded: `.load()` could belong to any
      // class, so they would add mostly-noise edges to the graph.
      expect(refNames).not.toContain('load')

      const callRefs = refs.filter(tag => tag.subKind === 'call')
      expect(callRefs.map(tag => tag.name)).toEqual(['computeTotal'])
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('ranks a file that is only reached through calls', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-ts-call-rank-'))
    try {
      writeFileSync(
        join(tempDir, 'helpers.ts'),
        [
          'export function computeTotal(items: number[]) {',
          '  return items.length',
          '}',
          '',
          'export function parseAmount(raw: string) {',
          '  return Number(raw)',
          '}',
          '',
        ].join('\n'),
      )
      // Calls both helpers without referencing them in any type position.
      writeFileSync(
        join(tempDir, 'main.ts'),
        [
          'export function run(raw: string) {',
          '  return computeTotal([parseAmount(raw)])',
          '}',
          '',
        ].join('\n'),
      )
      writeFileSync(
        join(tempDir, 'unrelated.ts'),
        [
          'export function standalone() {',
          '  return 1',
          '}',
          '',
          'export function another() {',
          '  return 2',
          '}',
          '',
        ].join('\n'),
      )

      const files = ['main.ts', 'helpers.ts', 'unrelated.ts']
      const tags = await Promise.all(files.map(file => extractTags(file, tempDir)))
      const graph = buildGraph(
        tags.filter((entry): entry is FileTags => entry !== null),
      )
      expect(graph.hasEdge('main.ts', 'helpers.ts')).toBe(true)
      expect(graph.getEdgeAttribute('main.ts', 'helpers.ts', 'weight')).toBeGreaterThan(0)

      const result = await buildRepoMap({ root: tempDir, files, maxTokens: 1024 })
      expect(result.map.split('\n')[0]).toBe('helpers.ts:')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('extracts definitions and references from JavaScript files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-js-'))
    try {
      writeFileSync(
        join(tempDir, 'main.js'),
        [
          'class Widget {',
          '  render() { return helper() }',
          '}',
          'function helper() { return new Widget() }',
          'const makeWidget = () => new Widget()',
          'exports.fromCommonJs = function() { return makeWidget() }',
          '',
        ].join('\n'),
      )

      const result = await extractTags('main.js', tempDir)
      expect(result).not.toBeNull()

      const defs = result!.tags
        .filter(tag => tag.kind === 'def')
        .map(tag => tag.name)
      const refs = result!.tags
        .filter(tag => tag.kind === 'ref')
        .map(tag => tag.name)

      expect(defs).toContain('Widget')
      expect(defs).toContain('helper')
      expect(defs).toContain('makeWidget')
      expect(defs).toContain('fromCommonJs')
      expect(refs).toContain('Widget')
      expect(refs).toContain('helper')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('extracts definitions and references from Go files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-go-'))
    try {
      writeFileSync(
        join(tempDir, 'server.go'),
        [
          'package main',
          '',
          'type Server struct {',
          '\tName string',
          '}',
          '',
          'type Alias = Server',
          '',
          'func NewServer(name string) *Server {',
          '\treturn &Server{Name: name}',
          '}',
          '',
          'func (s *Server) Start() error {',
          '\treturn nil',
          '}',
          '',
          'func main() {',
          '\ts := NewServer("x")',
          '\t_ = s.Start()',
          '}',
          '',
        ].join('\n'),
      )

      const result = await extractTags('server.go', tempDir)
      expect(result).not.toBeNull()

      const defs = result!.tags
        .filter(tag => tag.kind === 'def')
        .map(tag => tag.name)
      const refs = result!.tags
        .filter(tag => tag.kind === 'ref')
        .map(tag => tag.name)

      // Type declarations (including aliases), functions, and methods.
      expect(defs).toContain('Server')
      expect(defs).toContain('Alias')
      expect(defs).toContain('NewServer')
      expect(defs).toContain('Start')
      expect(defs).toContain('main')

      const methods = result!.tags.filter(
        tag => tag.kind === 'def' && tag.subKind === 'method',
      )
      expect(methods.map(tag => tag.name)).toEqual(['Start'])

      // Package-qualified and selector calls resolve to their callee name.
      expect(refs).toContain('NewServer')
      expect(refs).toContain('Start')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('extracts definitions and references from Rust files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-rust-'))
    try {
      writeFileSync(
        join(tempDir, 'lib.rs'),
        [
          'mod util;',
          '',
          'pub struct Server {',
          '    name: String,',
          '}',
          '',
          'pub enum Mode {',
          '    Fast,',
          '}',
          '',
          'pub trait Starter {',
          '    fn start(&self);',
          '}',
          '',
          'impl Server {',
          '    pub fn new(name: &str) -> Server {',
          '        Server { name: name.to_string() }',
          '    }',
          '',
          '    pub fn start(&self) {',
          '        helper();',
          '    }',
          '}',
          '',
          'fn helper() {}',
          '',
        ].join('\n'),
      )

      const result = await extractTags('lib.rs', tempDir)
      expect(result).not.toBeNull()

      const defs = result!.tags.filter(tag => tag.kind === 'def')
      const defNames = defs.map(tag => tag.name)
      const refs = result!.tags
        .filter(tag => tag.kind === 'ref')
        .map(tag => tag.name)

      expect(defNames).toContain('util')
      expect(defNames).toContain('Server')
      expect(defNames).toContain('Mode')
      expect(defNames).toContain('Starter')
      // `impl Server` methods are definitions owned by their type.
      expect(defNames).toContain('new')
      expect(defNames).toContain('start')
      expect(defNames).toContain('helper')

      const serverDef = defs.find(tag => tag.name === 'Server')
      expect(serverDef?.subKind).toBe('class')
      const modeDef = defs.find(tag => tag.name === 'Mode')
      expect(modeDef?.subKind).toBe('enum')
      const traitDef = defs.find(tag => tag.name === 'Starter')
      expect(traitDef?.subKind).toBe('interface')

      // `impl Server` references the type; `helper()` is a bare call.
      expect(refs).toContain('Server')
      expect(refs).toContain('helper')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('captures bodyless trait methods, generic impls, and turbofish calls in Rust', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-rust-generics-'))
    try {
      writeFileSync(
        join(tempDir, 'service.rs'),
        [
          'trait Service {',
          '    fn validate(&self, id: u32) -> bool;',
          '}',
          '',
          'struct Store<T> {',
          '    value: T,',
          '}',
          '',
          'impl<T> Store<T> {',
          '    fn get(&self) -> &T {',
          '        &self.value',
          '    }',
          '}',
          '',
          'fn helper<T>(v: T) -> T {',
          '    v',
          '}',
          '',
          'fn run(service: &Service, store: &Store<u32>, id: u32) {',
          '    let _ = helper::<u32>(id);',
          '    let _ = service.validate(id);',
          '    let _ = store.get::<u32>();',
          '    let _ = Store::<u32>::count(id);',
          '}',
          '',
        ].join('\n'),
      )

      const result = await extractTags('service.rs', tempDir)
      expect(result).not.toBeNull()

      const defs = result!.tags.filter(tag => tag.kind === 'def')
      const refs = result!.tags
        .filter(tag => tag.kind === 'ref')
        .map(tag => tag.name)

      // `fn validate(&self, id: u32) -> bool;` has no body, so it parses as
      // function_signature_item. The name is unique to the trait, so an impl
      // method cannot mask it.
      const traitMethod = defs.find(tag => tag.name === 'validate')
      expect(traitMethod?.subKind).toBe('method')

      // `impl<T> Store<T>` carries a generic_type node, not a bare type.
      expect(refs).toContain('Store')

      // Explicit type arguments wrap the callee in generic_function.
      expect(refs).toContain('helper')
      expect(refs).toContain('validate')
      expect(refs).toContain('get')
      expect(refs).toContain('count')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('extracts definitions and references from C files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-c-'))
    try {
      writeFileSync(
        join(tempDir, 'point.h'),
        [
          '#pragma once',
          '',
          'typedef struct Point Point;',
          '',
          'struct Forward;',
          '',
          'int add(int a, int b);',
          '',
          'char *dup_string(const char *s);',
          '',
        ].join('\n'),
      )
      writeFileSync(
        join(tempDir, 'point.c'),
        [
          '#include "point.h"',
          '',
          'struct Node {',
          '    struct Node *next;',
          '    Point value;',
          '};',
          '',
          'struct Forward;',
          '',
          'union Value {',
          '    int i;',
          '    float f;',
          '};',
          '',
          'enum Color { RED, GREEN };',
          '',
          'typedef struct {',
          '    int x;',
          '    int y;',
          '} Coord;',
          '',
          'typedef int len_t;',
          '',
          'static int helper(int v) {',
          '    return v + 1;',
          '}',
          '',
          'char *dup_string(const char *s) {',
          '    return 0;',
          '}',
          '',
          'int add(int a, int b) {',
          '    Coord c = { 0, 0 };',
          '    return helper(c.x) + process(c) + util_scale(b);',
          '}',
          '',
        ].join('\n'),
      )

      const result = await extractTags('point.c', tempDir)
      expect(result).not.toBeNull()

      const defs = result!.tags.filter(tag => tag.kind === 'def')
      const defNames = defs.map(tag => tag.name)
      const refs = result!.tags
        .filter(tag => tag.kind === 'ref')
        .map(tag => tag.name)

      // Structs, unions, enums and typedefs with a body are definitions; the
      // typedef in front of an anonymous struct still provides the name.
      expect(defNames).toContain('Node')
      expect(defNames).toContain('Value')
      expect(defNames).toContain('Color')
      expect(defNames).toContain('Coord')
      expect(defNames).toContain('len_t')

      expect(defs.find(tag => tag.name === 'Node')?.subKind).toBe('class')
      expect(defs.find(tag => tag.name === 'Value')?.subKind).toBe('class')
      expect(defs.find(tag => tag.name === 'Color')?.subKind).toBe('enum')
      expect(defs.find(tag => tag.name === 'len_t')?.subKind).toBe('type')

      // `struct Forward;` and `struct Node *next;` only mention the type, so
      // they must not add definitions, and Node stays a single definition.
      expect(defNames).not.toContain('Forward')
      expect(defs.filter(tag => tag.name === 'Node')).toHaveLength(1)

      // char *dup_string(...) puts the function declarator under a
      // pointer_declarator and must still be captured.
      expect(defs.find(tag => tag.name === 'helper')?.subKind).toBe('function')
      expect(defs.find(tag => tag.name === 'dup_string')?.subKind).toBe(
        'function',
      )
      expect(defs.find(tag => tag.name === 'add')?.subKind).toBe('function')

      // Calls and type mentions drive the reference graph.
      expect(refs).toContain('helper')
      expect(refs).toContain('process')
      expect(refs).toContain('util_scale')
      expect(refs).toContain('Coord')
      expect(refs).toContain('Point')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('captures C header prototypes as definitions', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-c-header-'))
    try {
      writeFileSync(
        join(tempDir, 'point.h'),
        [
          '#pragma once',
          '',
          'typedef int len_t;',
          '',
          'int add(int a, int b);',
          '',
          'char *dup_string(const char *s);',
          '',
        ].join('\n'),
      )

      const result = await extractTags('point.h', tempDir)
      expect(result).not.toBeNull()

      const defs = result!.tags.filter(tag => tag.kind === 'def')
      // Headers declare the API without a body, so declarations have to count
      // as definitions or the file would drop out of the map.
      expect(defs.find(tag => tag.name === 'add')?.subKind).toBe('function')
      expect(defs.find(tag => tag.name === 'dup_string')?.subKind).toBe(
        'function',
      )
      expect(defs.find(tag => tag.name === 'len_t')?.subKind).toBe('type')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('extracts definitions and references from C++ files', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-cpp-'))
    try {
      writeFileSync(
        join(tempDir, 'store.cpp'),
        [
          '#include "store.h"',
          '',
          'namespace app {',
          '',
          'class Store {',
          'public:',
          '    Store(int size);',
          '    ~Store();',
          '    int count() const;',
          'private:',
          '    int size_;',
          '};',
          '',
          'Store::Store(int size) : size_(size) {}',
          '',
          'int Store::count() const {',
          '    return helper(size_);',
          '}',
          '',
          'bool operator==(const Store &a, const Store &b) {',
          '    return a.count() == b.count();',
          '}',
          '',
          'using StorePtr = Store *;',
          '',
          'template <typename T>',
          'class Box {',
          'public:',
          '    T get() const { return value_; }',
          'private:',
          '    T value_;',
          '};',
          '',
          'enum class Mode { Fast, Slow };',
          '',
          'int helper(int v) {',
          '    return v + 1;',
          '}',
          '',
          'void run(Store *s) {',
          '    s->count();',
          '    helper(3);',
          '    app::helper(4);',
          '}',
          '',
          '}  // namespace app',
          '',
        ].join('\n'),
      )

      const result = await extractTags('store.cpp', tempDir)
      expect(result).not.toBeNull()

      const defs = result!.tags.filter(tag => tag.kind === 'def')
      const refs = result!.tags
        .filter(tag => tag.kind === 'ref')
        .map(tag => tag.name)

      expect(defs.find(tag => tag.name === 'app')?.subKind).toBe('module')
      expect(defs.find(tag => tag.name === 'Store')?.subKind).toBe('class')
      expect(defs.find(tag => tag.name === 'StorePtr')?.subKind).toBe('type')
      expect(defs.find(tag => tag.name === 'Box')?.subKind).toBe('class')
      expect(defs.find(tag => tag.name === 'Mode')?.subKind).toBe('enum')

      // In-class declarations and out-of-class definitions both count as
      // methods, so count appears twice for the two lines that declare it.
      const countDefs = defs.filter(tag => tag.name === 'count')
      expect(countDefs).toHaveLength(2)
      expect(countDefs.every(tag => tag.subKind === 'method')).toBe(true)

      // Destructors and operators carry their own name nodes.
      expect(defs.find(tag => tag.name === '~Store')?.subKind).toBe('method')
      expect(defs.some(tag => tag.name === 'operator==')).toBe(true)
      expect(defs.find(tag => tag.name === 'get')?.subKind).toBe('method')
      expect(defs.find(tag => tag.name === 'run')?.subKind).toBe('function')

      // s->count(), helper(3) and app::helper(4) all name their callee.
      expect(refs).toContain('count')
      expect(refs).toContain('helper')
      expect(refs).toContain('Store')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('builds a map for a C repo and ranks the referenced file first', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-c-map-'))
    try {
      writeFileSync(
        join(tempDir, 'widget.c'),
        [
          '#include "widget.h"',
          '',
          'int widget_render(const char *input) {',
          '    return helper(input);',
          '}',
          '',
          'static int helper(const char *input) {',
          '    return 0;',
          '}',
          '',
        ].join('\n'),
      )
      writeFileSync(
        join(tempDir, 'main.c'),
        [
          '#include "widget.h"',
          '',
          'int main(void) {',
          '    return widget_render("x");',
          '}',
          '',
        ].join('\n'),
      )

      const result = await buildRepoMap({
        root: tempDir,
        files: ['main.c', 'widget.c'],
        maxTokens: 1024,
      })

      expect(result.map).toContain('widget.c:')
      expect(result.map).toContain('int widget_render(const char *input) {')
      // main.c calls widget_render, so widget.c ranks first.
      expect(result.map.split('\n')[0]).toBe('widget.c:')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('builds a map for a Go repo and ranks the referenced file first', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-go-map-'))
    try {
      writeFileSync(
        join(tempDir, 'store.go'),
        [
          'package store',
          '',
          'type Store struct{}',
          '',
          'func NewStore() *Store {',
          '\treturn &Store{}',
          '}',
          '',
        ].join('\n'),
      )
      writeFileSync(
        join(tempDir, 'main.go'),
        [
          'package main',
          '',
          'func main() {',
          '\ts := store.NewStore()',
          '\t_ = s',
          '}',
          '',
        ].join('\n'),
      )

      const result = await buildRepoMap({
        root: tempDir,
        files: ['main.go', 'store.go'],
        maxTokens: 1024,
      })

      expect(result.map).toContain('store.go:')
      expect(result.map).toContain('func NewStore() *Store {')
      // store.go is referenced by main.go, so it ranks first.
      expect(result.map.split('\n')[0]).toBe('store.go:')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('builds a non-empty map for JavaScript-only repos', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-js-only-'))
    try {
      writeFileSync(
        join(tempDir, 'main.js'),
        [
          'export class JavaScriptOnly {}',
          'export function createJavaScriptOnly() {',
          '  return new JavaScriptOnly()',
          '}',
          '',
        ].join('\n'),
      )

      const result = await buildRepoMap({
        root: tempDir,
        maxTokens: 1024,
        files: ['main.js'],
      })

      expect(result.map).toContain('main.js:')
      expect(result.map).toContain('JavaScriptOnly')
      expect(result.fileCount).toBe(1)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('shares concurrent query loads for the same language', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-js-concurrent-'))
    try {
      const files = Array.from({ length: 20 }, (_, i) => `file${i}.js`)
      for (const file of files) {
        writeFileSync(
          join(tempDir, file),
          `export function ${file.replace('.js', '')}() { return 1 }\n`,
        )
      }

      const results = await Promise.all(
        files.map(file => extractTags(file, tempDir)),
      )

      expect(results.every(result => result !== null)).toBe(true)
      expect(
        results.every(result =>
          result!.tags.some(tag => tag.kind === 'def'),
        ),
      ).toBe(true)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })
})

describe('graph', () => {
  test('builds edges between files that reference each other\'s symbols', async () => {
    const allTags: FileTags[] = []
    for (const f of FIXTURE_FILES) {
      const tags = await extractTags(f, FIXTURE_ROOT)
      if (tags) allTags.push(tags)
    }

    const graph = buildGraph(allTags)

    // fileA imports from fileB (references CacheLayer defined in fileB)
    expect(graph.hasEdge('fileA.ts', 'fileB.ts')).toBe(true)

    // fileA imports from fileC (references StoreConfig, DataStore defined in fileC)
    expect(graph.hasEdge('fileA.ts', 'fileC.ts')).toBe(true)

    // fileB imports from fileC (references DataStore defined in fileC)
    expect(graph.hasEdge('fileB.ts', 'fileC.ts')).toBe(true)

    // fileD imports from fileA
    expect(graph.hasEdge('fileD.ts', 'fileA.ts')).toBe(true)

    // fileE is isolated — no edges to/from it
    expect(graph.degree('fileE.ts')).toBe(0)
  })

  test('skips edge creation when one symbol is defined in too many files', () => {
    const tags: FileTags[] = [
      {
        path: 'source.ts',
        tags: [
          {
            kind: 'ref',
            name: 'SharedName',
            line: 1,
            signature: 'const value = SharedName',
          },
        ],
      },
    ]

    for (let i = 0; i < 101; i++) {
      tags.push({
        path: `defs/file${i}.ts`,
        tags: [
          {
            kind: 'def',
            name: 'SharedName',
            line: 1,
            signature: `export const SharedName = ${i}`,
          },
        ],
      })
    }

    const graph = buildGraph(tags)
    expect(graph.outDegree('source.ts')).toBe(0)
  })

  test('does not create zero-weight edges for symbols defined in every file', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-zero-weight-'))
    try {
      for (const file of ['a.ts', 'b.ts']) {
        writeFileSync(
          join(tempDir, file),
          [
            'export class Config {}',
            'export function useConfig(input: Config): Config { return input }',
            '',
          ].join('\n'),
        )
      }

      const result = await buildRepoMap({
        root: tempDir,
        files: ['a.ts', 'b.ts'],
        maxTokens: 2048,
      })

      expect(result.fileCount).toBe(2)
      expect(result.map).toContain('a.ts:')
      expect(result.map).toContain('b.ts:')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })
})

describe('tag cache extraction', () => {
  test('preserves input file order when mixing cached and uncached tags', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-cache-order-'))
    try {
      const files = ['b.ts', 'a.ts', 'c.ts']
      for (const file of files) {
        const symbolName = file.replace('.ts', '').toUpperCase()
        writeFileSync(join(tempDir, file), `export const ${symbolName} = 1\n`)
      }

      const fileStats = new Map(files.map(file => [file, statFile(tempDir, file)]))
      const cache = { version: CACHE_VERSION, entries: {}, renderedEntries: {} }
      const cachedTags = await extractTags('b.ts', tempDir)
      expect(cachedTags).not.toBeNull()
      setCachedTags(
        cache,
        cachedTags!.path,
        tempDir,
        cachedTags!.tags,
        fileStats.get(cachedTags!.path) ?? undefined,
      )

      const result = await extractTagsWithCache({
        files,
        root: tempDir,
        cache,
        fileStats,
      })

      expect(result.map(fileTags => fileTags.path)).toEqual(files)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })
})

describe('parser project root resolution', () => {
  test('resolves source checkout roots for Windows paths', () => {
    const filePath = 'C:\\repo\\src\\context\\repoMap\\parser.ts'
    expect(resolveProjectRoot(filePath)).toBe('C:\\repo\\')
  })

  test('resolves bundled roots from dist paths', () => {
    const filePath = win32.join('C:\\repo', 'dist', 'cli.mjs')
    expect(resolveProjectRoot(filePath)).toBe('C:\\repo\\')
  })
})

describe('pagerank', () => {
  test('ranks the most-imported file highest', async () => {
    const result = await buildRepoMap({
      root: FIXTURE_ROOT,
      maxTokens: 2048,
      files: FIXTURE_FILES,
    })

    // The map starts with the highest-ranked file
    const firstFile = result.map.split('\n')[0]
    expect(firstFile).toBe('fileC.ts:')

    // fileE should be ranked lowest (or near last)
    const lines = result.map.split('\n')
    const filePositions = FIXTURE_FILES.map(f => {
      const idx = lines.findIndex(l => l === `${f}:`)
      return { file: f, position: idx }
    }).filter(x => x.position >= 0)
    .sort((a, b) => a.position - b.position)

    // fileC should be first
    expect(filePositions[0]!.file).toBe('fileC.ts')

    // fileE should be last (or among the last)
    const lastFile = filePositions[filePositions.length - 1]!.file
    expect(['fileD.ts', 'fileE.ts']).toContain(lastFile)
  })

  test('directory focus boosts matching file nodes', () => {
    const graph = buildGraph([
      {
        path: 'src/tools/isolated.ts',
        tags: [
          {
            kind: 'def',
            name: 'IsolatedTool',
            line: 1,
            signature: 'export class IsolatedTool {}',
          },
        ],
      },
      {
        path: 'src/core.ts',
        tags: [
          {
            kind: 'def',
            name: 'Core',
            line: 1,
            signature: 'export class Core {}',
          },
          {
            kind: 'ref',
            name: 'Helper',
            line: 2,
            signature: 'new Helper()',
          },
        ],
      },
      {
        path: 'src/helper.ts',
        tags: [
          {
            kind: 'def',
            name: 'Helper',
            line: 1,
            signature: 'export class Helper {}',
          },
        ],
      },
    ])

    const noFocus = rankFiles(graph).map(file => file.path)
    const dirFocus = rankFiles(graph, ['src/tools/']).map(file => file.path)

    expect(noFocus[0]).not.toBe('src/tools/isolated.ts')
    expect(dirFocus[0]).toBe('src/tools/isolated.ts')
  })

  test('symbol focus boosts matching files in the core build path', async () => {
    const result = await buildRepoMap({
      root: FIXTURE_ROOT,
      maxTokens: 2048,
      files: FIXTURE_FILES,
      focusSymbols: ['ConsoleLogger'],
    })

    const firstFile = result.map.split('\n')[0]
    expect(firstFile).toBe('fileE.ts:')
    expect(result.map).toContain('export class ConsoleLogger implements Logger')
  })
})

describe('renderer', () => {
  test('respects the token budget within 5%', async () => {
    const maxTokens = 500
    const result = await buildRepoMap({
      root: FIXTURE_ROOT,
      maxTokens,
      files: FIXTURE_FILES,
    })

    const actualTokens = countTokens(result.map)
    expect(actualTokens).toBeLessThanOrEqual(maxTokens * 1.05)
    expect(result.tokenCount).toBeLessThanOrEqual(maxTokens * 1.05)
  })

  test('drops files that don\'t fit rather than listing their names', async () => {
    // Very tight budget — should only fit 1-2 files
    const result = await buildRepoMap({
      root: FIXTURE_ROOT,
      maxTokens: 100,
      files: FIXTURE_FILES,
    })

    // Count how many files appear as headers in the output
    const fileHeaders = result.map.split('\n').filter(l => l.endsWith(':') && !l.startsWith(' '))

    // Every file header in the output should have its signatures listed
    for (const header of fileHeaders) {
      // The file must have at least one signature line after it
      const headerIdx = result.map.indexOf(header)
      const afterHeader = result.map.slice(headerIdx + header.length)
      // Should have content (signatures), not just the filename
      expect(afterHeader.trim().length).toBeGreaterThan(0)
    }

    // Should have fewer files than total
    expect(fileHeaders.length).toBeLessThan(FIXTURE_FILES.length)
  })

  test('skips an oversized ranked file and keeps later files that fit', () => {
    const hugeSignature = `export function enormous(${Array.from(
      { length: 120 },
      (_, i) => `arg${i}: string`,
    ).join(', ')}): void {}`
    const ranked = [
      { path: 'big.ts', score: 10 },
      { path: 'small.ts', score: 1 },
    ]
    const fileTagsMap = new Map<string, FileTags>([
      [
        'big.ts',
        {
          path: 'big.ts',
          tags: [
            {
              kind: 'def',
              name: 'enormous',
              line: 1,
              signature: hugeSignature,
            },
          ],
        },
      ],
      [
        'small.ts',
        {
          path: 'small.ts',
          tags: [
            {
              kind: 'def',
              name: 'small',
              line: 1,
              signature: 'export function small(): void {}',
            },
          ],
        },
      ],
    ])

    const result = renderMap(ranked, fileTagsMap, 80)

    expect(result.map).toContain('small.ts:')
    expect(result.map).not.toContain('big.ts:')
    expect(result.fileCount).toBe(1)
    expect(result.tokenCount).toBeLessThanOrEqual(80)
  })
})

describe('cache', () => {
  test('saveCache does not throw when persistence is unavailable', () => {
    expect(() => {
      saveCache('\0invalid-root', {
        version: CACHE_VERSION,
        entries: {
          bad: {
            tags: [{ value: BigInt(1) }],
            mtimeMs: 0,
            size: 0,
          },
        },
        renderedEntries: {},
      } as never)
    }).not.toThrow()
  })

  test('a cache from before call references is discarded and re-extracted', async () => withWritableConfigHome(async () => {
    // Extraction semantics changed (plain calls are now references), so a cache
    // written by the previous version must not be served for unchanged files.
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-cache-upgrade-'))
    try {
      writeFileSync(
        join(tempDir, 'helpers.ts'),
        'export function computeTotal(items: number[]) {\n  return items.length\n}\n',
      )
      writeFileSync(
        join(tempDir, 'main.ts'),
        'export function run() {\n  return computeTotal([1])\n}\n',
      )

      const staleEntry = (file: string, name: string, signature: string) => {
        const stat = statFile(tempDir, file)!
        return {
          tags: [
            { kind: 'def' as const, name, line: 1, signature, subKind: 'function' },
          ],
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        }
      }

      // Old version, fingerprints matching the unchanged files, and tags that
      // carry no call reference from main.ts to helpers.ts. Pinned to the real
      // historical version, not CACHE_VERSION - 1: if the bump were removed,
      // the fixture would otherwise become version 1 and this test could pass
      // while version-2 caches still serve stale tags.
      const stale: CacheData = {
        version: 2,
        entries: {
          'helpers.ts': staleEntry(
            'helpers.ts',
            'computeTotal',
            'export function computeTotal(items: number[]) {',
          ),
          'main.ts': staleEntry('main.ts', 'run', 'export function run() {'),
        },
        renderedEntries: {
          stale: { map: 'stale map', fileCount: 1, tokenCount: 2, createdAt: 0 },
        },
      }
      saveCache(tempDir, stale)

      const result = await buildRepoMap({
        root: tempDir,
        files: ['main.ts', 'helpers.ts'],
        maxTokens: 1024,
      })

      // Re-extracted rather than served from the stale cache, so the call from
      // main.ts ranks helpers.ts first.
      expect(result.cacheHit).toBe(false)
      expect(result.map.split('\n')[0]).toBe('helpers.ts:')

      // The refreshed cache is persisted at the current version. Checking the
      // version alone would also pass on the empty fallback, so assert the
      // upgraded contents: the re-extracted call reference and a rendered map.
      const refreshed = loadCache(tempDir)
      expect(refreshed.version).toBe(CACHE_VERSION)
      expect(refreshed.entries['main.ts']?.tags).toContainEqual(
        expect.objectContaining({ kind: 'ref', name: 'computeTotal' }),
      )
      expect(Object.keys(refreshed.renderedEntries).length).toBeGreaterThan(0)
      // The version-2 rendered map was discarded rather than carried over.
      expect(refreshed.renderedEntries.stale).toBeUndefined()
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  }))

  test('stores repo map cache under OPENCLAUDE_CONFIG_DIR when configured', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'repomap-config-home-'))
    const expectedCacheDir = join(configDir, 'repomap-cache')
    const {
      CLAUDE_CONFIG_DIR: _legacyConfigDir,
      OPENCLAUDE_CONFIG_DIR: _openClaudeConfigDir,
      ...env
    } = process.env

    try {
      const result = spawnSync(
        process.execPath,
        [
          '--eval',
          [
            "import { getCacheStats } from './src/context/repoMap/index.ts'",
            'const stats = getCacheStats(process.argv[1])',
            'if (stats.cacheDir !== process.argv[2]) {',
            '  console.error(`Expected ${process.argv[2]}, got ${stats.cacheDir}`)',
            '  process.exit(1)',
            '}',
          ].join('\n'),
          FIXTURE_ROOT,
          expectedCacheDir,
        ],
        {
          cwd: REPO_ROOT,
          encoding: 'utf8',
          env: {
            ...env,
            FORCE_COLOR: '0',
            OPENCLAUDE_CONFIG_DIR: configDir,
          },
        },
      )

      if (result.error) {
        throw result.error
      }

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
    } finally {
      rmSync(configDir, { recursive: true, force: true })
    }
  })

  test('second build of unchanged fixture uses the cache', async () => withWritableConfigHome(async () => {
    // First build (cold)
    const result1 = await buildRepoMap({
      root: FIXTURE_ROOT,
      maxTokens: 2048,
      files: FIXTURE_FILES,
    })
    expect(result1.cacheHit).toBe(false)

    // Second build (warm)
    const result2 = await buildRepoMap({
      root: FIXTURE_ROOT,
      maxTokens: 2048,
      files: FIXTURE_FILES,
    })
    expect(result2.cacheHit).toBe(true)

    // Output should be identical
    expect(result2.map).toBe(result1.map)
  }))

  test('modifying a file invalidates the rendered cache without clearing cache data', async () => withWritableConfigHome(async () => {
    // Create a temp copy of the fixture
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-test-'))
    try {
      for (const f of FIXTURE_FILES) {
        cpSync(join(FIXTURE_ROOT, f), join(tempDir, f))
      }

      // First build
      const result1 = await buildRepoMap({
        root: tempDir,
        maxTokens: 2048,
        files: FIXTURE_FILES,
      })
      expect(result1.cacheHit).toBe(false)

      // Touch one file to change its mtime
      const targetFile = join(tempDir, 'fileE.ts')
      const now = new Date()
      utimesSync(targetFile, now, now)

      const cacheBeforeSecondBuild = loadCache(tempDir)
      expect(getCachedTags(
        cacheBeforeSecondBuild,
        'fileA.ts',
        tempDir,
        statFile(tempDir, 'fileA.ts') ?? undefined,
      )).not.toBeNull()
      expect(getCachedTags(
        cacheBeforeSecondBuild,
        'fileE.ts',
        tempDir,
        statFile(tempDir, 'fileE.ts') ?? undefined,
      )).toBeNull()

      // Second build — rendered cache should be invalidated because the map
      // hash includes file stats, but unchanged files can still reuse tag cache.
      const result2 = await buildRepoMap({
        root: tempDir,
        maxTokens: 2048,
        files: FIXTURE_FILES,
      })
      // The per-file cache for fileE should miss (mtime changed),
      // but other files should still hit the per-file cache
      expect(result2.cacheHit).toBe(false)

      // Output should still be valid
      expect(result2.map.length).toBeGreaterThan(0)
      expect(result2.fileCount).toBe(result1.fileCount)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  }))
})

describe('gitFiles', () => {
  test('ignores inherited git environment overrides', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-git-env-'))
    const previousGitDir = process.env.GIT_DIR
    const previousGitWorkTree = process.env.GIT_WORK_TREE
    try {
      writeFileSync(
        join(tempDir, 'hello.ts'),
        'export function hello(): string { return "world" }\n',
      )

      process.env.GIT_DIR = join(process.cwd(), '.git')
      process.env.GIT_WORK_TREE = process.cwd()

      expect(await getRepoFiles(tempDir)).toEqual(['hello.ts'])
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR
      else process.env.GIT_DIR = previousGitDir
      if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE
      else process.env.GIT_WORK_TREE = previousGitWorkTree
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('preserves leading whitespace in git-tracked file paths', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-git-paths-'))
    const env = { ...process.env }
    delete env.GIT_DIR
    delete env.GIT_WORK_TREE
    delete env.GIT_INDEX_FILE

    try {
      writeFileSync(
        join(tempDir, ' leading.ts'),
        'export function LeadingSpaceFile(): string { return "ok" }\n',
      )
      writeFileSync(
        join(tempDir, 'normal.ts'),
        'export function NormalFile(): string { return "ok" }\n',
      )

      execFileSync('git', ['init'], { cwd: tempDir, env, stdio: 'ignore' })
      execFileSync('git', ['add', '.'], { cwd: tempDir, env, stdio: 'ignore' })

      const files = await getRepoFiles(tempDir)
      expect(files).toContain(' leading.ts')

      const result = await buildRepoMap({
        root: tempDir,
        maxTokens: 1024,
      })

      expect(result.map).toContain(' leading.ts:')
      expect(result.map).toContain('LeadingSpaceFile')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })

  test('falls back gracefully when not in a git repo', async () => {
    // Create a temp directory with source files but NO .git
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-nogit-'))
    try {
      writeFileSync(
        join(tempDir, 'hello.ts'),
        'export function hello(): string { return "world" }\n',
      )
      writeFileSync(
        join(tempDir, 'utils.ts'),
        'export function add(a: number, b: number): number { return a + b }\n',
      )

      const result = await buildRepoMap({
        root: tempDir,
        maxTokens: 1024,
      })

      // Should succeed without throwing
      expect(result.map.length).toBeGreaterThan(0)
      expect(result.totalFileCount).toBeGreaterThan(0)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })
})

describe('error handling', () => {
  test('no crash on malformed source file', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-malformed-'))
    try {
      // Valid file
      writeFileSync(
        join(tempDir, 'good.ts'),
        'export function good(): number { return 1 }\n',
      )
      // Malformed file — severe syntax errors
      writeFileSync(
        join(tempDir, 'bad.ts'),
        '}{}{}{export classclass [[[ function ,,, @@@ ###\n',
      )

      const result = await buildRepoMap({
        root: tempDir,
        maxTokens: 1024,
        files: ['good.ts', 'bad.ts'],
      })

      // Should complete successfully
      expect(result.map.length).toBeGreaterThan(0)
      // The good file should be in the output
      expect(result.map).toContain('good.ts')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
      invalidateCache(tempDir)
    }
  })
})

describe('rendered cache invalidation', () => {
  test('reflects file edits without manual invalidation', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'repomap-stale-'))
    try {
      writeFileSync(
        join(tempDir, 'main.ts'),
        'export function oldName(): void {}\n',
      )

      const first = await buildRepoMap({ root: tempDir, maxTokens: 1024 })
      expect(first.cacheHit).toBe(false)
      expect(first.map).toContain('oldName')

      // Bump mtime forward so the change is visible on filesystems with
      // coarse timestamp resolution.
      const future = new Date(Date.now() + 2000)
      writeFileSync(
        join(tempDir, 'main.ts'),
        'export function newName(): void {}\n',
      )
      utimesSync(join(tempDir, 'main.ts'), future, future)

      const second = await buildRepoMap({ root: tempDir, maxTokens: 1024 })
      expect(second.map).toContain('newName')
      expect(second.map).not.toContain('oldName')
    } finally {
      invalidateCache(tempDir)
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})

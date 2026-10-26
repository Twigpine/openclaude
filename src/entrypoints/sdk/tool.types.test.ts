import { z } from 'zod/v4'
import { tool, createSdkMcpServer } from './index.js'
declare const declaredTool: typeof import('../sdk.js').tool
declare const declaredServer: typeof import('../sdk.js').createSdkMcpServer

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T

interface NamedShape { path: z.ZodString }
interface NamedInputShape { _input: z.ZodString; value: z.ZodString }
interface JsonArgs { path: string }

function assertToolTypes(): void {
  const namedShape: NamedShape = { path: z.string() }
  const namedInputShape: NamedInputShape = { _input: z.string(), value: z.string() }
  const jsonArgs: JsonArgs = { path: 'file.txt' }
  const modeShape = { mode: z.enum(['read', 'write']) }
  const modeObject = z.object(modeShape)
  const readOnlyHandler = async (args: { mode: 'read' }) => ({
    content: [{ type: 'text' as const, text: args.mode }],
  })
  const readonlyShape = {
    name: z.string(),
    count: z.number().optional(),
    defaulted: z.string().default('default'),
    transformed: z.string().transform(Number),
    _input: z.string(),
  } as const
  const sourceRaw = tool('raw', '', {
    name: z.string(),
    count: z.number().optional(),
    transformed: z.string().transform(Number),
    defaulted: z.string().default('default'),
  }, async (args, extra) => {
    type _Name = Assert<Equal<typeof args.name, string>>
    type _Count = Assert<Equal<typeof args.count, number | undefined>>
    // The adapter forwards raw arguments; it does not run Zod transforms/defaults.
    type _Transformed = Assert<Equal<typeof args.transformed, string>>
    type _Defaulted = Assert<Equal<typeof args.defaulted, string | undefined>>
    type _Extra = Assert<Equal<typeof extra, unknown>>
    return { content: [{ type: 'text', text: args.name }] }
  })
  const sourceObject = tool('object', '', z.object({ enabled: z.boolean() }), async args => {
    type _Enabled = Assert<Equal<typeof args.enabled, boolean>>
    return { content: [{ type: 'text', text: String(args.enabled) }] }
  })
  // Raw-shape field names must not be mistaken for whole-schema metadata.
  const sourceInputField = tool('input-field', '', {
    _input: z.string(), value: z.string(),
  }, async args => {
    type _Input = Assert<Equal<typeof args._input, string>>
    type _Value = Assert<Equal<typeof args.value, string>>
    return { content: [{ type: 'text', text: args.value }] }
  })
  void sourceInputField.handler({ _input: 'input', value: 'value' }, undefined)
  const sourceJson = tool('json', '', {
    type: 'object', properties: { path: { type: 'string' } },
  }, async (args: JsonArgs) => ({
    content: [{ type: 'text', text: args.path }],
  }))
  void sourceJson.handler(jsonArgs, undefined)
  const sourceNamed = tool('named', '', namedShape, async args => ({
    content: [{ type: 'text', text: args.path.toUpperCase() }],
  }))
  const sourceNamedInput = tool('named-input', '', namedInputShape, async args => {
    type _Input = Assert<Equal<typeof args._input, string>>
    return { content: [{ type: 'text', text: args.value.toUpperCase() }] }
  })
  void sourceNamedInput.handler({ _input: 'input', value: 'value' }, undefined)
  const sourceReadonly = tool('readonly', '', readonlyShape, async args => {
    // Const validators do not make the separate raw argument object readonly.
    args.name = args.name.trim()
    args.count = 1
    args.defaulted = 'default'
    args.transformed = '42'
    args._input = 'input'
    return { content: [{ type: 'text', text: args.name }] }
  })
  tool('json-fallback', '', { type: 'object' }, async args => {
    type _Fallback = Assert<Equal<typeof args, Record<string, unknown>>>
    return { content: [] }
  })
  // @ts-expect-error An annotation cannot override a raw schema's input type.
  tool('wrong-raw', '', { path: z.string() }, async (args: { path: number }) => ({ content: [] }))
  // @ts-expect-error An annotation cannot override a whole schema's input type.
  tool('wrong-object', '', z.object({ path: z.string() }), async (args: { path: number }) => ({ content: [] }))
  // @ts-expect-error A callback must accept every mode allowed by the raw schema.
  tool('narrow-raw', '', modeShape, readOnlyHandler)
  // @ts-expect-error A callback must accept every mode allowed by the whole schema.
  tool('narrow-object', '', modeObject, readOnlyHandler)
  const sourceModes = tool('modes', '', modeShape, async args => {
    type _Mode = Assert<Equal<typeof args.mode, 'read' | 'write'>>
    return { content: [{ type: 'text', text: args.mode }] }
  })
  const sourceWide = tool('wide', '', modeObject, async (args: { mode: string }) => ({
    content: [{ type: 'text', text: args.mode }],
  }))
  void sourceModes.handler({ mode: 'write' }, undefined)
  void sourceWide.handler({ mode: 'write' }, undefined)
  createSdkMcpServer({
    type: 'sdk', name: 'mixed',
    tools: [sourceRaw, sourceObject, sourceJson, sourceNamed, sourceNamedInput, sourceReadonly, sourceModes, sourceWide],
  })
  const publishedRaw = declaredTool('raw', '', {
    name: z.string(),
    count: z.number().optional(),
    transformed: z.string().transform(Number),
    defaulted: z.string().default('default'),
  }, async (args, extra) => {
    type _Name = Assert<Equal<typeof args.name, string>>
    type _Count = Assert<Equal<typeof args.count, number | undefined>>
    // The adapter forwards raw arguments; it does not run Zod transforms/defaults.
    type _Transformed = Assert<Equal<typeof args.transformed, string>>
    type _Defaulted = Assert<Equal<typeof args.defaulted, string | undefined>>
    type _Extra = Assert<Equal<typeof extra, unknown>>
    return { content: [{ type: 'text', text: args.name }] }
  })
  const publishedObject = declaredTool('object', '', z.object({ enabled: z.boolean() }), async args => {
    type _Enabled = Assert<Equal<typeof args.enabled, boolean>>
    return { content: [{ type: 'text', text: String(args.enabled) }] }
  })
  const publishedInputField = declaredTool('input-field', '', {
    _input: z.string(), value: z.string(),
  }, async args => {
    type _Input = Assert<Equal<typeof args._input, string>>
    type _Value = Assert<Equal<typeof args.value, string>>
    return { content: [{ type: 'text', text: args.value }] }
  })
  void publishedInputField.handler({ _input: 'input', value: 'value' }, undefined)
  const publishedJson = declaredTool('json', '', {
    type: 'object', properties: { path: { type: 'string' } },
  }, async (args: JsonArgs) => ({
    content: [{ type: 'text', text: args.path }],
  }))
  void publishedJson.handler(jsonArgs, undefined)
  const publishedNamed = declaredTool('named', '', namedShape, async args => ({
    content: [{ type: 'text', text: args.path.toUpperCase() }],
  }))
  const publishedNamedInput = declaredTool('named-input', '', namedInputShape, async args => {
    type _Input = Assert<Equal<typeof args._input, string>>
    return { content: [{ type: 'text', text: args.value.toUpperCase() }] }
  })
  void publishedNamedInput.handler({ _input: 'input', value: 'value' }, undefined)
  const publishedReadonly = declaredTool('readonly', '', readonlyShape, async args => {
    args.name = args.name.trim()
    args.count = 1
    args.defaulted = 'default'
    args.transformed = '42'
    args._input = 'input'
    return { content: [{ type: 'text', text: args.name }] }
  })
  declaredTool('json-fallback', '', { type: 'object' }, async args => {
    type _Fallback = Assert<Equal<typeof args, Record<string, unknown>>>
    return { content: [] }
  })
  // @ts-expect-error An annotation cannot override a raw schema's input type.
  declaredTool('wrong-raw', '', { path: z.string() }, async (args: { path: number }) => ({ content: [] }))
  // @ts-expect-error An annotation cannot override a whole schema's input type.
  declaredTool('wrong-object', '', z.object({ path: z.string() }), async (args: { path: number }) => ({ content: [] }))
  // @ts-expect-error A callback must accept every mode allowed by the raw schema.
  declaredTool('narrow-raw', '', modeShape, readOnlyHandler)
  // @ts-expect-error A callback must accept every mode allowed by the whole schema.
  declaredTool('narrow-object', '', modeObject, readOnlyHandler)
  const publishedModes = declaredTool('modes', '', modeShape, async args => {
    type _Mode = Assert<Equal<typeof args.mode, 'read' | 'write'>>
    return { content: [{ type: 'text', text: args.mode }] }
  })
  const publishedWide = declaredTool('wide', '', modeObject, async (args: { mode: string }) => ({
    content: [{ type: 'text', text: args.mode }],
  }))
  void publishedModes.handler({ mode: 'write' }, undefined)
  void publishedWide.handler({ mode: 'write' }, undefined)
  declaredServer({
    type: 'sdk', name: 'mixed',
    tools: [publishedRaw, publishedObject, publishedJson, publishedNamed, publishedNamedInput, publishedReadonly, publishedModes, publishedWide],
  })
}

void assertToolTypes

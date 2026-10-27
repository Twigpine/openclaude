import { z } from 'zod/v4'
import * as z3 from 'zod/v3'
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

function assertInputCompatibility(): void {
  const requiredShape = {
    payload: z.unknown(),
    anyValue: z.any(),
    custom: z.custom(),
    preprocessed: z.preprocess(value => value, z.string()),
    union: z.union([z.string(), z.undefined()]),
    undefinedValue: z.undefined(),
    voidValue: z.void(),
    _input: z.unknown(),
    optional: z.unknown().optional(),
    defaulted: z.string().default('value'),
    prefaulted: z.string().prefault('value'),
  } as const
  const requiredObject = z.object(requiredShape)
  type NativeInput = z.input<typeof requiredObject>
  const nativeHandler = async (_args: NativeInput) => ({ content: [] })
  const legacyShape = { payload: z3.unknown(), name: z3.string().optional() }
  const legacyObject = z3.object(legacyShape)
  const legacyHandler = async (_args: z3.input<typeof legacyObject>) => ({ content: [] })
  const jsonSchema = {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'],
  } as const
  const jsonHandler = async (args: JsonArgs) => ({
    content: [{ type: 'text' as const, text: args.path }],
  })

  // Check each entry point separately: their result types are independent.
  function sourceCompatibility(): void {
    const raw = tool('required-raw', '', requiredShape, nativeHandler)
    const whole = tool('required-object', '', requiredObject, nativeHandler)
    tool('inferred-required', '', requiredShape, async args => {
      type _NativeInput = Assert<Equal<{ [K in keyof typeof args]: typeof args[K] }, NativeInput>>
      args.payload = 'mutable input'
      return { content: [] }
    })
    const input: NativeInput = {
      payload: undefined, anyValue: undefined, custom: undefined,
      preprocessed: 'value', union: undefined, undefinedValue: undefined,
      voidValue: undefined, _input: undefined,
    }
    void raw.handler(input, undefined)
    void whole.handler(input, undefined)
    // @ts-expect-error Required unknown-valued fields cannot be omitted.
    void raw.handler({}, undefined)
    const optional = tool('optional', '', { payload: z.unknown().optional() }, async () => ({ content: [] }))
    void optional.handler({}, undefined)
    const legacy = tool('legacy', '', legacyShape, legacyHandler)
    void legacy.handler({}, undefined)

    const explicit = tool<typeof jsonSchema>('explicit', '', jsonSchema, jsonHandler)
    const specialized = tool<typeof jsonSchema>
    const instantiated = specialized('specialized', '', jsonSchema, jsonHandler)
    const fullyTyped = tool<typeof jsonSchema, JsonArgs>('fully-typed', '', jsonSchema, jsonHandler)
    void explicit.handler({ path: 'file.txt' }, undefined)
    void instantiated.handler({ path: 'file.txt' }, undefined)
    void fullyTyped.handler({ path: 'file.txt' }, undefined)
    // @ts-expect-error Explicit JSON input types still constrain direct calls.
    void fullyTyped.handler({ path: 1 }, undefined)
    // @ts-expect-error The compatibility signature must not admit narrow Zod callbacks.
    tool<typeof requiredShape>('narrow-unknown', '', requiredShape, async (_args: { payload: string }) => ({ content: [] }))
    createSdkMcpServer({ type: 'sdk', name: 'compatibility', tools: [raw, whole, legacy, explicit, instantiated, fullyTyped] })
  }
  function publishedCompatibility(): void {
    const raw = declaredTool('required-raw', '', requiredShape, nativeHandler)
    const whole = declaredTool('required-object', '', requiredObject, nativeHandler)
    declaredTool('inferred-required', '', requiredShape, async args => {
      type _NativeInput = Assert<Equal<{ [K in keyof typeof args]: typeof args[K] }, NativeInput>>
      args.payload = 'mutable input'
      return { content: [] }
    })
    const input: NativeInput = {
      payload: undefined, anyValue: undefined, custom: undefined,
      preprocessed: 'value', union: undefined, undefinedValue: undefined,
      voidValue: undefined, _input: undefined,
    }
    void raw.handler(input, undefined)
    void whole.handler(input, undefined)
    // @ts-expect-error Required unknown-valued fields cannot be omitted.
    void raw.handler({}, undefined)
    const optional = declaredTool('optional', '', { payload: z.unknown().optional() }, async () => ({ content: [] }))
    void optional.handler({}, undefined)
    const legacy = declaredTool('legacy', '', legacyShape, legacyHandler)
    void legacy.handler({}, undefined)

    const explicit = declaredTool<typeof jsonSchema>('explicit', '', jsonSchema, jsonHandler)
    const specialized = declaredTool<typeof jsonSchema>
    const instantiated = specialized('specialized', '', jsonSchema, jsonHandler)
    const fullyTyped = declaredTool<typeof jsonSchema, JsonArgs>('fully-typed', '', jsonSchema, jsonHandler)
    void explicit.handler({ path: 'file.txt' }, undefined)
    void instantiated.handler({ path: 'file.txt' }, undefined)
    void fullyTyped.handler({ path: 'file.txt' }, undefined)
    // @ts-expect-error Explicit JSON input types still constrain direct calls.
    void fullyTyped.handler({ path: 1 }, undefined)
    // @ts-expect-error The compatibility signature must not admit narrow Zod callbacks.
    declaredTool<typeof requiredShape>('narrow-unknown', '', requiredShape, async (_args: { payload: string }) => ({ content: [] }))
    declaredServer({ type: 'sdk', name: 'compatibility', tools: [raw, whole, legacy, explicit, instantiated, fullyTyped] })
  }

  void sourceCompatibility
  void publishedCompatibility
  const definition = { name: 'json', description: '', inputSchema: jsonSchema, handler: jsonHandler }
  const sourceDefault: import('./v2.js').SdkMcpToolDefinition = definition
  const sourceSchema: import('./v2.js').SdkMcpToolDefinition<typeof jsonSchema> = definition
  const publishedDefault: import('../sdk.js').SdkMcpToolDefinition = definition
  const publishedSchema: import('../sdk.js').SdkMcpToolDefinition<typeof jsonSchema> = definition
  const sourceInline: import('./v2.js').SdkMcpToolDefinition = {
    ...definition, handler: async args => ({ content: [{ type: 'text', text: String(args.path) }] }),
  }
  const sourceSchemaInline: import('./v2.js').SdkMcpToolDefinition<typeof jsonSchema> = {
    ...definition, handler: async args => ({ content: [{ type: 'text', text: String(args.path) }] }),
  }
  const publishedInline: import('../sdk.js').SdkMcpToolDefinition = {
    ...definition, handler: async args => ({ content: [{ type: 'text', text: String(args.path) }] }),
  }
  const publishedSchemaInline: import('../sdk.js').SdkMcpToolDefinition<typeof jsonSchema> = {
    ...definition, handler: async args => ({ content: [{ type: 'text', text: String(args.path) }] }),
  }
  createSdkMcpServer({ type: 'sdk', name: 'definitions', tools: [sourceDefault, sourceSchema, sourceInline, sourceSchemaInline] })
  declaredServer({ type: 'sdk', name: 'definitions', tools: [publishedDefault, publishedSchema, publishedInline, publishedSchemaInline] })
}

void assertInputCompatibility

// Empty JSON schemas and widened object types provide no evidence of Zod fields.
function assertKeylessSchemaCompatibility(): void {
  const jsonHandler = async (args: JsonArgs) => ({
    content: [{ type: 'text' as const, text: args.path }],
  })
  const widenedSchema: object = { type: 'object' }
  const disjointShape = {} as { path: z.ZodString } | { count: z.ZodNumber }

  function sourceCompatibility(): void {
    const inferred = tool('empty-json', '', {}, jsonHandler)
    const explicit = tool<{}>('explicit-empty-json', '', {}, jsonHandler)
    const specialized = tool<{}>
    const instantiated = specialized('specialized-empty-json', '', {}, jsonHandler)
    const fullyTyped = tool<{}, JsonArgs>('typed-empty-json', '', {}, jsonHandler)
    const widened = tool('widened-json', '', widenedSchema, jsonHandler)
    tool('contextual-empty-json', '', {}, async args => {
      type _Fallback = Assert<Equal<typeof args, Record<string, unknown>>>
      return { content: [{ type: 'text', text: String(args.path) }] }
    })
    tool('contextual-widened-json', '', widenedSchema, async args => {
      type _Fallback = Assert<Equal<typeof args, Record<string, unknown>>>
      return { content: [{ type: 'text', text: String(args.path) }] }
    })
    void inferred.handler({ path: 'file.txt' }, undefined)
    void explicit.handler({ path: 'file.txt' }, undefined)
    void instantiated.handler({ path: 'file.txt' }, undefined)
    void fullyTyped.handler({ path: 'file.txt' }, undefined)
    void widened.handler({ path: 'file.txt' }, undefined)
    // @ts-expect-error An empty schema must retain the inferred JSON handler input.
    void inferred.handler({ path: 1 }, undefined)
    // @ts-expect-error Explicit JSON input types still constrain direct calls.
    void fullyTyped.handler({ path: 1 }, undefined)
    // No common keys does not make a union of actual raw shapes a JSON schema.
    // @ts-expect-error The callback must accept both alternatives of the raw shape.
    tool<typeof disjointShape>('disjoint-raw', '', disjointShape, jsonHandler)
    tool('empty-zod-object', '', z.object({}), async args => {
      type _EmptyInput = Assert<Equal<typeof args, z.input<z.ZodObject<{}>>>>
      return { content: [] }
    })
    const namedDefinition: import('./v2.js').SdkMcpToolDefinition<{}> = {
      name: 'named', description: '', inputSchema: {}, handler: jsonHandler,
    }
    const contextualDefinition: import('./v2.js').SdkMcpToolDefinition<object> = {
      name: 'contextual', description: '', inputSchema: widenedSchema,
      handler: async args => ({ content: [{ type: 'text', text: String(args.path) }] }),
    }
    createSdkMcpServer({ type: 'sdk', name: 'keyless', tools: [inferred, explicit, instantiated, fullyTyped, widened, namedDefinition, contextualDefinition] })
  }
  void sourceCompatibility

  function publishedCompatibility(): void {
    const inferred = declaredTool('empty-json', '', {}, jsonHandler)
    const explicit = declaredTool<{}>('explicit-empty-json', '', {}, jsonHandler)
    const specialized = declaredTool<{}>
    const instantiated = specialized('specialized-empty-json', '', {}, jsonHandler)
    const fullyTyped = declaredTool<{}, JsonArgs>('typed-empty-json', '', {}, jsonHandler)
    const widened = declaredTool('widened-json', '', widenedSchema, jsonHandler)
    declaredTool('contextual-empty-json', '', {}, async args => {
      type _Fallback = Assert<Equal<typeof args, Record<string, unknown>>>
      return { content: [{ type: 'text', text: String(args.path) }] }
    })
    declaredTool('contextual-widened-json', '', widenedSchema, async args => {
      type _Fallback = Assert<Equal<typeof args, Record<string, unknown>>>
      return { content: [{ type: 'text', text: String(args.path) }] }
    })
    void inferred.handler({ path: 'file.txt' }, undefined)
    void explicit.handler({ path: 'file.txt' }, undefined)
    void instantiated.handler({ path: 'file.txt' }, undefined)
    void fullyTyped.handler({ path: 'file.txt' }, undefined)
    void widened.handler({ path: 'file.txt' }, undefined)
    // @ts-expect-error An empty schema must retain the inferred JSON handler input.
    void inferred.handler({ path: 1 }, undefined)
    // @ts-expect-error Explicit JSON input types still constrain direct calls.
    void fullyTyped.handler({ path: 1 }, undefined)
    // No common keys does not make a union of actual raw shapes a JSON schema.
    // @ts-expect-error The callback must accept both alternatives of the raw shape.
    declaredTool<typeof disjointShape>('disjoint-raw', '', disjointShape, jsonHandler)
    declaredTool('empty-zod-object', '', z.object({}), async args => {
      type _EmptyInput = Assert<Equal<typeof args, z.input<z.ZodObject<{}>>>>
      return { content: [] }
    })
    const namedDefinition: import('../sdk.js').SdkMcpToolDefinition<{}> = {
      name: 'named', description: '', inputSchema: {}, handler: jsonHandler,
    }
    const contextualDefinition: import('../sdk.js').SdkMcpToolDefinition<object> = {
      name: 'contextual', description: '', inputSchema: widenedSchema,
      handler: async args => ({ content: [{ type: 'text', text: String(args.path) }] }),
    }
    declaredServer({ type: 'sdk', name: 'keyless', tools: [inferred, explicit, instantiated, fullyTyped, widened, namedDefinition, contextualDefinition] })
  }
  void publishedCompatibility
}

void assertKeylessSchemaCompatibility

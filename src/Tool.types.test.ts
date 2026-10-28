import { z } from 'zod/v4'
import type { AnyObject, Tool } from './Tool.js'
import { createToolFixture } from './test/toolFixtures.js'
import { parseClassifierResponse } from './utils/permissions/classifierShared.js'
import { semanticBoolean } from './utils/semanticBoolean.js'
import { semanticNumber } from './utils/semanticNumber.js'
import { zodToJsonSchema } from './utils/zodToJsonSchema.js'

type Assert<T extends true> = T
type IsEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends <
  T,
>() => T extends B ? 1 : 2
  ? true
  : false

const schema = z.strictObject({
  count: z.string().transform(Number),
  label: z.string().optional(),
})
const tool = createToolFixture(schema, { name: 'schema-contract' })

type _OutputInference = Assert<
  IsEqual<z.infer<typeof tool.inputSchema>, { count: number; label?: string }>
>
type _InputInference = Assert<
  IsEqual<z.input<typeof tool.inputSchema>, { count: string; label?: string }>
>
type _CallInference = Assert<
  IsEqual<Parameters<typeof tool.call>[0], z.infer<typeof schema>>
>
type _ScalarRejected = Assert<
  IsEqual<z.ZodString extends AnyObject ? true : false, false>
>
type _UnknownOutput = Assert<
  IsEqual<ReturnType<NonNullable<Tool['outputSchema']>['parse']>, unknown>
>

function assertSchemaConsumers(genericTool: Tool): void {
  const numeric = semanticNumber(z.number().default(0))
  const boolean = semanticBoolean(z.boolean().optional())
  type _NumericOutput = Assert<IsEqual<z.output<typeof numeric>, number>>
  type _BooleanOutput = Assert<
    IsEqual<z.output<typeof boolean>, boolean | undefined>
  >
  const classified = parseClassifierResponse(
    { type: 'tool_use', id: 'schema', name: 'schema', input: {} },
    schema,
  )
  type _ClassifierOutput = Assert<
    IsEqual<typeof classified, z.output<typeof schema> | null>
  >

  // Concrete tools still expose the schema's construction API and exact output.
  tool.inputSchema.extend({ enabled: z.boolean() })
  const parsed: { count: number; label?: string } = tool.inputSchema.parse({})
  void parsed

  // Heterogeneous registries only need parsing and JSON conversion.
  const input: Record<string, unknown> = genericTool.inputSchema.parse({})
  void input
  genericTool.inputSchema.safeParse({})
  zodToJsonSchema(genericTool.inputSchema)
  if (genericTool.outputSchema) {
    genericTool.outputSchema.safeParse({})
    zodToJsonSchema(genericTool.outputSchema)
  }
}

void assertSchemaConsumers

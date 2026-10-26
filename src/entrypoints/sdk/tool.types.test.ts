import { z } from 'zod/v4'
import { tool, createSdkMcpServer } from './index.js'
declare const declaredTool: typeof import('../sdk.js').tool
declare const declaredServer: typeof import('../sdk.js').createSdkMcpServer

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T

function assertToolTypes(): void {
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
  const sourceJson = tool('json', '', {
    type: 'object', properties: { path: { type: 'string' } },
  }, async (args: { path: string }) => ({
    content: [{ type: 'text', text: args.path }],
  }))
  createSdkMcpServer({
    type: 'sdk', name: 'mixed', tools: [sourceRaw, sourceObject, sourceJson],
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
  const publishedJson = declaredTool('json', '', {
    type: 'object', properties: { path: { type: 'string' } },
  }, async (args: { path: string }) => ({
    content: [{ type: 'text', text: args.path }],
  }))
  declaredServer({
    type: 'sdk', name: 'mixed', tools: [publishedRaw, publishedObject, publishedJson],
  })
}

void assertToolTypes

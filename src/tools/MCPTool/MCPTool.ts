import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { Ajv } from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ValidationResult } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionResult } from '../../types/permissions.js'
import { isOutputLineTruncated } from '../../utils/terminal.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'

// Allow any input object since MCP tools define their own schemas
export const inputSchema = lazySchema(() => z.looseObject({}))
type InputSchema = ReturnType<typeof inputSchema>

// MCP tools can return either a plain string or an array of content blocks
// (text, images, etc.). The outputSchema must reflect both shapes so the model
// knows rich content is possible.
export const outputSchema = lazySchema(() =>
  z.union([
    z.string().describe('MCP tool execution result as text'),
    z
      .array(
        z.object({
          type: z.string(),
          text: z.string().optional(),
        }),
      )
      .describe('MCP tool execution result as content blocks'),
  ]),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

// Re-export MCPProgress from centralized types to break import cycles
export type { MCPProgress } from '../../types/tools.js'

const draft7Ajv = new Ajv({ strict: false })
const draft202012Ajv = new Ajv2020({ strict: false })

type CompiledValidator = {
  validate: ValidateFunction
  errorsText: (errors?: ValidateFunction['errors']) => string
}

// Cache compiled validators to avoid recompiling on every validateInput call.
// AJV compilation is expensive — schemas don't change between calls.
// Uses WeakMap to allow garbage collection of schemas from disconnected/refreshed
// MCP tools, preventing memory leaks from accumulating strong references.
const compiledValidatorCache = new WeakMap<object, CompiledValidator>()

function selectAjv(schema: object) {
  const schemaUri = (schema as Record<string, unknown>)['$schema']
  if (
    typeof schemaUri === 'string' &&
    schemaUri.includes('json-schema.org/draft-07')
  ) {
    return draft7Ajv
  }
  return draft202012Ajv
}

function getCompiledValidator(schema: object) {
  let compiled = compiledValidatorCache.get(schema)
  if (!compiled) {
    const ajv = selectAjv(schema)
    compiled = {
      validate: ajv.compile(schema),
      errorsText: errors => ajv.errorsText(errors),
    }
    compiledValidatorCache.set(schema, compiled)
  }
  return compiled
}

export const MCPTool = buildTool({
  isMcp: true,
  // Overridden in mcpClient.ts with the real MCP tool name + args
  isOpenWorld() {
    return false
  },
  // Overridden in mcpClient.ts
  name: 'mcp',
  maxResultSizeChars: 100_000,
  // Overridden in mcpClient.ts
  async description() {
    return DESCRIPTION
  },
  // Overridden in mcpClient.ts
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  // Overridden in mcpClient.ts
  async call() {
    return {
      data: '',
    }
  },
  async checkPermissions(): Promise<PermissionResult> {
    return {
      behavior: 'passthrough',
      message: 'MCPTool requires permission.',
    }
  },
  async validateInput(input, context): Promise<ValidationResult> {
    if (this.inputJSONSchema) {
      try {
        const { validate, errorsText } = getCompiledValidator(
          this.inputJSONSchema,
        )
        if (!validate(input)) {
          return {
            result: false,
            message: errorsText(validate.errors),
            errorCode: 400,
          }
        }
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error)
        return {
          result: false,
          message: `Failed to compile JSON schema for validation: ${errMsg}`,
          errorCode: 500,
        }
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  // Overridden in mcpClient.ts
  userFacingName: () => 'mcp',
  renderToolUseProgressMessage,
  renderToolResultMessage,
  isResultTruncated(output: Output): boolean {
    if (typeof output === 'string') {
      return isOutputLineTruncated(output)
    }
    // Array of content blocks — check if any text block exceeds the display limit
    if (Array.isArray(output)) {
      return output.some(
        block =>
          block != null &&
          block.type === 'text' &&
          typeof block.text === 'string' &&
          isOutputLineTruncated(block.text),
      )
    }
    return false
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    // Defensive guard: if content is undefined/null (shouldn't happen after
    // the abort path fix in client.ts), return a clear indicator rather than
    // sending undefined to the API which would cause an error.
    if (content === undefined || content === null) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: '[No content returned from MCP tool]',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      // MCP content blocks are loosely typed ({ type: string }); the actual
      // values come off the MCP wire as SDK-shaped blocks, so cast at the
      // API boundary.
      content: content as ToolResultBlockParam['content'],
    }
  },
} satisfies ToolDef<InputSchema, Output>)


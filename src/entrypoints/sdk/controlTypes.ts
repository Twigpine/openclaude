import type { z } from 'zod/v4'
import type {
  SDKControlInitializeRequestSchema,
  SDKControlInitializeResponseSchema,
  SDKControlMcpSetServersResponseSchema,
  SDKControlPermissionRequestSchema,
  SDKControlReloadPluginsResponseSchema,
} from './controlSchemas.js'
import type { SDKPartialAssistantMessageSchema } from './coreSchemas.js'

/*
 * The control schema source does not yet cover every request subtype handled by
 * print.ts. Keep aggregate transport messages permissive while exporting the
 * named payload contracts that do have canonical schemas.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

type InferSchema<T extends () => z.core.$ZodType> = z.infer<ReturnType<T>>

export type SDKControlInitializeRequest = InferSchema<
  typeof SDKControlInitializeRequestSchema
>
export type SDKControlInitializeResponse = InferSchema<
  typeof SDKControlInitializeResponseSchema
>
export type SDKControlPermissionRequest = InferSchema<
  typeof SDKControlPermissionRequestSchema
>
export type SDKControlMcpSetServersResponse = InferSchema<
  typeof SDKControlMcpSetServersResponseSchema
>
export type SDKControlReloadPluginsResponse = InferSchema<
  typeof SDKControlReloadPluginsResponseSchema
>
export type SDKControlRequestInner = any
export type SDKControlRequest = any
export type SDKControlResponse = any
export type SDKControlCancelRequest = any
export type StdinMessage = any
export type StdoutMessage = any
export type SDKPartialAssistantMessage = InferSchema<
  typeof SDKPartialAssistantMessageSchema
>

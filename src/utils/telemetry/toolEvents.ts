/**
 * Tool-level OTLP event helpers: `claude_code.safety_event` for permission
 * decisions that stop or prompt on a tool call, and `claude_code.tool_result`
 * for completed executions. Attribute builders are pure so tests can assert
 * the exact event surface without driving the tool pipeline.
 */

import type { PermissionDecision, PermissionDecisionReason } from '../../types/permissions.js'
import type { ToolUseContext } from '../../Tool.js'
import { getParentSessionId } from '../../bootstrap/state.js'
import { isToolDetailsLoggingEnabled } from '../../services/analytics/metadata.js'
import { logOTelEvent, type OTelEventMetadata } from './events.js'

/** Map a permission decision's reason to the mechanism that produced it. */
export function safetyMechanism(
	decisionReason: PermissionDecisionReason | undefined,
): string {
	switch (decisionReason?.type) {
		case 'rule':
			return 'permission_rule'
		case 'mode':
			return 'permission_mode'
		case 'subcommandResults':
			return 'subcommand_results'
		case 'permissionPromptTool':
			return 'permission_prompt_tool'
		case 'hook':
			return 'hook'
		case 'asyncAgent':
			return 'async_agent'
		case 'sandboxOverride':
			return 'sandbox'
		case 'classifier':
			return 'classifier'
		case 'workingDir':
			return 'working_dir'
		case 'safetyCheck':
			return 'safety_check'
		case 'other':
			return 'other'
		default:
			return 'unknown'
	}
}

function safetyReasonDetail(
	decisionReason: PermissionDecisionReason | undefined,
): string | undefined {
	switch (decisionReason?.type) {
		case 'rule':
			return `${decisionReason.rule.source}:${decisionReason.rule.ruleValue.toolName}`
		case 'mode':
			return decisionReason.mode
		case 'hook':
			return decisionReason.hookName
		case 'sandboxOverride':
		case 'workingDir':
		case 'safetyCheck':
		case 'other':
		case 'asyncAgent':
		case 'classifier':
			return decisionReason.reason
		default:
			return undefined
	}
}

function agentAttributes(
	toolUseContext: ToolUseContext,
): OTelEventMetadata {
	if (!toolUseContext.agentId) return {}
	return {
		agent_id: toolUseContext.agentId,
		parent_agent_id: getParentSessionId(),
	}
}

function telemetryToolName(toolName: string): string {
	// MCP tool names encode user-configured server names, so they stay
	// sanitized unless detailed tool logging is explicitly enabled.
	if (!isToolDetailsLoggingEnabled() && toolName.startsWith('mcp__')) {
		return 'mcp_tool'
	}
	return toolName
}

export function buildSafetyEventAttributes(args: {
	toolName: string
	decision: PermissionDecision
	toolUseContext: ToolUseContext
	durationMs: number
}): OTelEventMetadata {
	const decisionReason = args.decision.decisionReason
	return {
		tool_name: telemetryToolName(args.toolName),
		decision: args.decision.behavior,
		source: safetyMechanism(decisionReason),
		reason: safetyReasonDetail(decisionReason),
		...(decisionReason?.type === 'classifier' && {
			classifier: decisionReason.classifier,
		}),
		duration_ms: args.durationMs,
		...agentAttributes(args.toolUseContext),
	}
}

export function buildToolResultAttributes(args: {
	toolName: string
	toolUseContext: ToolUseContext
	toolUseID: string
	success: boolean
	durationMs: number
	error?: string
	isInterrupt?: boolean
	toolParameters?: Record<string, unknown>
	mcpServerType?: string
	mcpServerBaseUrl?: string
	mcpServerScope?: string
}): OTelEventMetadata {
	const decisionInfo = args.toolUseContext.toolDecisions?.get(args.toolUseID)
	const attributes: OTelEventMetadata = {
		tool_name: telemetryToolName(args.toolName),
		success: args.success,
		duration_ms: args.durationMs,
		...(decisionInfo && {
			decision: decisionInfo.decision,
			decision_source: decisionInfo.source,
		}),
		...(args.error !== undefined && { error: args.error }),
		...(args.isInterrupt !== undefined && {
			is_interrupt: args.isInterrupt,
		}),
		...(args.mcpServerType && { mcp_server_type: args.mcpServerType }),
		...(args.mcpServerBaseUrl && {
			mcp_server_base_url: args.mcpServerBaseUrl,
		}),
		...(args.mcpServerScope && { mcp_server_scope: args.mcpServerScope }),
		...agentAttributes(args.toolUseContext),
	}
	if (isToolDetailsLoggingEnabled() && args.toolParameters) {
		for (const [key, value] of Object.entries(args.toolParameters)) {
			if (
				typeof value === 'string' ||
				typeof value === 'number' ||
				typeof value === 'boolean'
			) {
				attributes[`tool_parameters.${key}`] = value
			}
		}
	}
	return attributes
}

/** Emit `claude_code.safety_event` for a non-allow permission decision. */
export async function logToolSafetyEvent(args: {
	toolName: string
	decision: PermissionDecision
	toolUseContext: ToolUseContext
	durationMs: number
}): Promise<void> {
	await logOTelEvent('safety_event', buildSafetyEventAttributes(args))
}

/** Emit `claude_code.tool_result` for a completed tool execution. */
export async function logToolResultEvent(
	args: Parameters<typeof buildToolResultAttributes>[0],
): Promise<void> {
	await logOTelEvent('tool_result', buildToolResultAttributes(args))
}

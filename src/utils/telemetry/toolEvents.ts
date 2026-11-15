/**
 * Tool-level OTLP event helpers: `claude_code.safety_event` for permission
 * decisions that stop or prompt on a tool call, and `claude_code.tool_result`
 * for completed executions. Attribute builders are pure so tests can assert
 * the exact event surface without driving the tool pipeline.
 */

import type { PermissionDecision, PermissionDecisionReason } from '../../types/permissions.js'
import type { ToolUseContext } from '../../Tool.js'
import { getAgentContext } from '../agentContext.js'
import {
	isToolDetailsLoggingEnabled,
	sanitizeToolNameForAnalytics,
} from '../../services/analytics/metadata.js'
import { isTelemetryEnabled, logOTelEvent, type OTelEventMetadata } from './events.js'

function detailsOnly(value: string | undefined): string | undefined {
	return isToolDetailsLoggingEnabled() ? value : undefined
}

function safetyDecisionFields(
	decisionReason: PermissionDecisionReason | undefined,
): { source: string; reason?: string } {
	switch (decisionReason?.type) {
		case 'rule':
			return {
				source: 'permission_rule',
				reason: `${decisionReason.rule.source}:${decisionReason.rule.ruleValue.toolName}`,
			}
		case 'mode':
			return { source: 'permission_mode', reason: decisionReason.mode }
		case 'subcommandResults':
			return { source: 'subcommand_results' }
		case 'permissionPromptTool':
			return { source: 'permission_prompt_tool' }
		case 'hook':
			return { source: 'hook', reason: decisionReason.hookName }
		case 'asyncAgent':
			return { source: 'async_agent', reason: detailsOnly(decisionReason.reason) }
		case 'sandboxOverride':
			return { source: 'sandbox', reason: detailsOnly(decisionReason.reason) }
		case 'classifier':
			return { source: 'classifier', reason: detailsOnly(decisionReason.reason) }
		case 'workingDir':
			return { source: 'working_dir', reason: detailsOnly(decisionReason.reason) }
		case 'safetyCheck':
			return { source: 'safety_check', reason: detailsOnly(decisionReason.reason) }
		case 'other':
			return { source: 'other', reason: detailsOnly(decisionReason.reason) }
		default:
			return { source: 'unknown' }
	}
}

function agentAttributes(
	toolUseContext: ToolUseContext,
): OTelEventMetadata {
	if (!toolUseContext.agentId) return {}
	return {
		agent_id: toolUseContext.agentId,
		parent_agent_id:
			toolUseContext.parentAgentId ?? getAgentContext()?.parentSessionId,
	}
}

function telemetryToolName(toolName: string): string {
	// MCP tool names encode user-configured server names, so they stay
	// sanitized unless detailed tool logging is explicitly enabled.
	return isToolDetailsLoggingEnabled()
		? toolName
		: sanitizeToolNameForAnalytics(toolName)
}

export function buildSafetyEventAttributes(args: {
	toolName: string
	decision: PermissionDecision
	toolUseContext: ToolUseContext
	durationMs: number
}): OTelEventMetadata {
	const decisionReason = args.decision.decisionReason
	const { source, reason } = safetyDecisionFields(decisionReason)
	return {
		tool_name: telemetryToolName(args.toolName),
		decision: args.decision.behavior,
		source,
		reason,
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
	const details = isToolDetailsLoggingEnabled()
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
		// MCP server identity stays hidden when the tool name is sanitized:
		// the base URL reveals internal hostnames, which is more identifying
		// than the collapsed 'mcp_tool' name.
		...(details &&
			args.mcpServerType && { mcp_server_type: args.mcpServerType }),
		...(details &&
			args.mcpServerBaseUrl && {
				mcp_server_base_url: args.mcpServerBaseUrl,
			}),
		...(details &&
			args.mcpServerScope && { mcp_server_scope: args.mcpServerScope }),
		...agentAttributes(args.toolUseContext),
	}
	if (details && args.toolParameters) {
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

export async function logToolSafetyEvent(args: {
	toolName: string
	decision: PermissionDecision
	toolUseContext: ToolUseContext
	durationMs: number
}): Promise<void> {
	if (!isTelemetryEnabled()) return
	await logOTelEvent('safety_event', buildSafetyEventAttributes(args))
}

export async function logToolResultEvent(
	args: Parameters<typeof buildToolResultAttributes>[0],
): Promise<void> {
	if (!isTelemetryEnabled()) return
	await logOTelEvent('tool_result', buildToolResultAttributes(args))
}

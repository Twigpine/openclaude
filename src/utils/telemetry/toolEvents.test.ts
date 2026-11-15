import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { snapshotEnv } from '../../test/envSnapshot.js'
import {
	acquireSharedMutationLock,
	releaseSharedMutationLock,
} from '../../test/sharedMutationLock.js'
import type { PermissionDecisionReason } from '../../types/permissions.js'
import type { ToolUseContext } from '../../Tool.js'
import {
	buildSafetyEventAttributes,
	buildToolResultAttributes,
} from './toolEvents.js'

let restoreEnv: () => void

beforeEach(async () => {
	await acquireSharedMutationLock('utils/telemetry/toolEvents.test.ts')
	restoreEnv = snapshotEnv(['OTEL_LOG_TOOL_DETAILS'], { clear: true })
})

afterEach(() => {
	try {
		restoreEnv()
	} finally {
		releaseSharedMutationLock()
	}
})

function ctx(overrides: Partial<ToolUseContext> = {}): ToolUseContext {
	return overrides as ToolUseContext
}

function safetySource(reason: PermissionDecisionReason | undefined): unknown {
	return buildSafetyEventAttributes({
		toolName: 'Bash',
		decision: {
			behavior: 'ask',
			message: 'x',
			...(reason !== undefined && { decisionReason: reason }),
		},
		toolUseContext: ctx(),
		durationMs: 1,
	}).source
}

describe('safety decision mapping', () => {
	test.each([
		[{ type: 'rule', rule: { source: 'userSettings', ruleBehavior: 'deny', ruleValue: { toolName: 'Bash' } } }, 'permission_rule'],
		[{ type: 'mode', mode: 'default' }, 'permission_mode'],
		[{ type: 'subcommandResults', reasons: new Map() }, 'subcommand_results'],
		[{ type: 'permissionPromptTool', permissionPromptToolName: 't', toolResult: {} }, 'permission_prompt_tool'],
		[{ type: 'hook', hookName: 'PreToolUse' }, 'hook'],
		[{ type: 'asyncAgent', reason: 'r' }, 'async_agent'],
		[{ type: 'sandboxOverride', reason: 'excludedCommand' }, 'sandbox'],
		[{ type: 'classifier', classifier: 'auto-mode', reason: 'r' }, 'classifier'],
		[{ type: 'workingDir', reason: 'r' }, 'working_dir'],
		[{ type: 'safetyCheck', reason: 'r', classifierApprovable: true }, 'safety_check'],
		[{ type: 'other', reason: 'r' }, 'other'],
		[undefined, 'unknown'],
	])('maps %j to %s', (reason, expected) => {
		expect(safetySource(reason as PermissionDecisionReason | undefined)).toBe(
			expected,
		)
	})
})

describe('buildSafetyEventAttributes', () => {
	test('denied-by-rule event names the rule source and tool', () => {
		const attrs = buildSafetyEventAttributes({
			toolName: 'Bash',
			decision: {
				behavior: 'deny',
				message: 'nope',
				decisionReason: {
					type: 'rule',
					rule: {
						source: 'userSettings',
						ruleBehavior: 'deny',
						ruleValue: { toolName: 'Bash', ruleContent: 'rm *' },
					},
				},
			},
			toolUseContext: ctx(),
			durationMs: 12,
		})
		expect(attrs).toMatchObject({
			tool_name: 'Bash',
			decision: 'deny',
			source: 'permission_rule',
			reason: 'userSettings:Bash',
			duration_ms: 12,
		})
		expect(JSON.stringify(attrs)).not.toContain('rm *')
	})

	test('hook-prompted event carries the hook name', () => {
		const attrs = buildSafetyEventAttributes({
			toolName: 'Write',
			decision: {
				behavior: 'ask',
				message: 'confirm?',
				decisionReason: { type: 'hook', hookName: 'PreToolUse' },
			},
			toolUseContext: ctx(),
			durationMs: 3,
		})
		expect(attrs).toMatchObject({
			decision: 'ask',
			source: 'hook',
			reason: 'PreToolUse',
		})
	})

	test('free-text reasons stay hidden unless details logging is on', () => {
		const decisionReason = {
			type: 'safetyCheck',
			reason: 'sensitive file /home/u/.ssh/config',
			classifierApprovable: true,
		} as const
		const base = {
			toolName: 'Read',
			decision: {
				behavior: 'ask',
				message: 'x',
				decisionReason,
			} as const,
			toolUseContext: ctx(),
			durationMs: 1,
		}
		const off = buildSafetyEventAttributes(base)
		expect(off.source).toBe('safety_check')
		expect(off.reason).toBeUndefined()
		process.env.OTEL_LOG_TOOL_DETAILS = '1'
		expect(buildSafetyEventAttributes(base).reason).toBe(
			'sensitive file /home/u/.ssh/config',
		)
	})

	test('sanitizes MCP names inside rule reasons unless details logging is on', () => {
		const decision = {
			behavior: 'deny',
			message: 'x',
			decisionReason: {
				type: 'rule',
				rule: {
					source: 'userSettings',
					ruleBehavior: 'deny',
					ruleValue: { toolName: 'mcp__private_server__search' },
				},
			},
		} as const
		const base = { decision, toolUseContext: ctx(), durationMs: 1 }
		expect(
			buildSafetyEventAttributes({ toolName: 'mcp__private_server__search', ...base })
				.reason,
		).toBe('userSettings:mcp_tool')
		process.env.OTEL_LOG_TOOL_DETAILS = '1'
		expect(
			buildSafetyEventAttributes({ toolName: 'mcp__private_server__search', ...base })
				.reason,
		).toBe('userSettings:mcp__private_server__search')
	})

	test('sanitizes MCP tool names unless details logging is on', () => {
		const decision = {
			behavior: 'deny',
			message: 'x',
			decisionReason: { type: 'other', reason: 'x' },
		} as const
		const base = {
			decision,
			toolUseContext: ctx(),
			durationMs: 1,
		}
		expect(
			buildSafetyEventAttributes({ toolName: 'mcp__srv__tool', ...base })
				.tool_name,
		).toBe('mcp_tool')
		process.env.OTEL_LOG_TOOL_DETAILS = '1'
		expect(
			buildSafetyEventAttributes({ toolName: 'mcp__srv__tool', ...base })
				.tool_name,
		).toBe('mcp__srv__tool')
	})
})

describe('buildToolResultAttributes', () => {
	test('subagent tool results carry agent_id and the spawning parent id', () => {
		const subagent = buildToolResultAttributes({
			toolName: 'Read',
			toolUseContext: ctx({
				agentId: 'agent-7' as ToolUseContext['agentId'],
				parentAgentId: 'agent-3',
			}),
			toolUseID: 'tu_1',
			success: true,
			durationMs: 5,
		})
		expect(subagent.agent_id).toBe('agent-7')
		expect(subagent.parent_agent_id).toBe('agent-3')

		const main = buildToolResultAttributes({
			toolName: 'Read',
			toolUseContext: ctx(),
			toolUseID: 'tu_2',
			success: true,
			durationMs: 5,
		})
		expect(main.agent_id).toBeUndefined()
		expect(main.parent_agent_id).toBeUndefined()
	})

	test('decision info joins from toolDecisions map', () => {
		const toolDecisions = new Map<
			string,
			{ source: string; decision: 'accept' | 'reject'; timestamp: number }
		>([['tu_9', { source: 'user_prompt', decision: 'accept', timestamp: 1 }]])
		const attrs = buildToolResultAttributes({
			toolName: 'Bash',
			toolUseContext: ctx({ toolDecisions }),
			toolUseID: 'tu_9',
			success: true,
			durationMs: 9,
		})
		expect(attrs.decision).toBe('accept')
		expect(attrs.decision_source).toBe('user_prompt')
	})

	test('error results carry error text and interrupt flag', () => {
		const attrs = buildToolResultAttributes({
			toolName: 'Bash',
			toolUseContext: ctx(),
			toolUseID: 'tu_3',
			success: false,
			durationMs: 40,
			error: 'command failed',
			isInterrupt: false,
		})
		expect(attrs).toMatchObject({
			success: false,
			error: 'command failed',
			is_interrupt: false,
			duration_ms: 40,
		})
	})

	test('unprefixed MCP names still sanitize when isMcp is set', () => {
		const base = {
			toolUseContext: ctx(),
			toolUseID: 'tu_mcp',
			success: true,
			durationMs: 1,
			isMcp: true,
		}
		expect(
			buildToolResultAttributes({ toolName: 'Write', ...base }).tool_name,
		).toBe('mcp_tool')
		process.env.OTEL_LOG_TOOL_DETAILS = '1'
		expect(
			buildToolResultAttributes({ toolName: 'Write', ...base }).tool_name,
		).toBe('Write')
	})

	test('MCP server attributes only attach when details logging is on', () => {
		const base = {
			toolName: 'mcp__srv__tool',
			toolUseContext: ctx(),
			toolUseID: 'tu_8',
			success: true,
			durationMs: 1,
			mcpServerType: 'stdio',
			mcpServerBaseUrl: 'https://internal.host:8443/mcp',
			mcpServerScope: 'project',
		}
		const off = buildToolResultAttributes(base)
		expect(off.mcp_server_type).toBeUndefined()
		expect(off.mcp_server_base_url).toBeUndefined()
		expect(off.mcp_server_scope).toBeUndefined()
		process.env.OTEL_LOG_TOOL_DETAILS = '1'
		const on = buildToolResultAttributes(base)
		expect(on.mcp_server_type).toBe('stdio')
		expect(on.mcp_server_base_url).toBe('https://internal.host:8443/mcp')
		expect(on.mcp_server_scope).toBe('project')
	})

	test('tool parameters only attach when details logging is on', () => {
		const base = {
			toolName: 'Bash',
			toolUseContext: ctx(),
			toolUseID: 'tu_4',
			success: true,
			durationMs: 1,
			toolParameters: { bash_command: 'ls', timeout: 5000 },
		}
		const off = buildToolResultAttributes(base)
		expect(off['tool_parameters.bash_command']).toBeUndefined()
		process.env.OTEL_LOG_TOOL_DETAILS = '1'
		const on = buildToolResultAttributes(base)
		expect(on['tool_parameters.bash_command']).toBe('ls')
		expect(on['tool_parameters.timeout']).toBe(5000)
	})
})

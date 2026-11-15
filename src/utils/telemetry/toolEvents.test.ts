import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { PermissionDecisionReason } from '../../types/permissions.js'
import type { ToolUseContext } from '../../Tool.js'
import {
	buildSafetyEventAttributes,
	buildToolResultAttributes,
	safetyMechanism,
} from './toolEvents.js'

let savedToolDetails: string | undefined

beforeEach(() => {
	savedToolDetails = process.env.OTEL_LOG_TOOL_DETAILS
	delete process.env.OTEL_LOG_TOOL_DETAILS
})

afterEach(() => {
	if (savedToolDetails === undefined) delete process.env.OTEL_LOG_TOOL_DETAILS
	else process.env.OTEL_LOG_TOOL_DETAILS = savedToolDetails
})

function ctx(overrides: Partial<ToolUseContext> = {}): ToolUseContext {
	return overrides as ToolUseContext
}

describe('safetyMechanism', () => {
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
		expect(
			safetyMechanism(reason as PermissionDecisionReason | undefined),
		).toBe(expected)
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
		// ruleContent can contain paths/commands; it must not leak
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
	test('subagent tool results carry agent_id; main-session results carry neither id', () => {
		const subagent = buildToolResultAttributes({
			toolName: 'Read',
			toolUseContext: ctx({ agentId: 'agent-7' as ToolUseContext['agentId'] }),
			toolUseID: 'tu_1',
			success: true,
			durationMs: 5,
		})
		expect(subagent.agent_id).toBe('agent-7')
		// No parent session is registered in this test context
		expect(subagent.parent_agent_id).toBeUndefined()

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

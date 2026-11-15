import { Command } from '@commander-js/extra-typings'
import { describe, expect, test } from 'bun:test'

import {
	agentsDispatchOptions,
	buildAgentsDispatchArgs,
	wantsAgentsDispatch,
	type AgentsDispatchOptionValues,
} from './agentsDispatch.js'

function parseAgentsArgs(
	argv: string[],
): { prompt: string | undefined; options: AgentsDispatchOptionValues } {
	const program = new Command()
	let captured: { prompt: string | undefined; options: AgentsDispatchOptionValues } =
		{ prompt: undefined, options: {} }
	const cmd = program
		.command('agents')
		.argument('[prompt]')
		.action((prompt, options) => {
			captured = { prompt, options }
		})
		.exitOverride()
	for (const option of agentsDispatchOptions()) cmd.addOption(option)
	program.parse(['node', 'openclaude', ...argv])
	return captured
}

describe('agents dispatch option parsing', () => {
	test('a prompt survives dispatch flags declared after it', () => {
		const { prompt, options } = parseAgentsArgs([
			'agents',
			'--add-dir',
			'/a',
			'--add-dir',
			'/b',
			'--model',
			'm1',
		])
		// The positional prompt must precede flags; values still accumulate.
		expect(options.addDir).toEqual(['/a', '/b'])
		expect(options.model).toBe('m1')
		expect(prompt).toBeUndefined()
	})

	test('prompt followed by flags parses cleanly', () => {
		const { prompt, options } = parseAgentsArgs([
			'agents',
			'fix the tests',
			'--add-dir',
			'../lib',
			'--permission-mode',
			'acceptEdits',
		])
		expect(prompt).toBe('fix the tests')
		expect(options.addDir).toEqual(['../lib'])
		expect(options.permissionMode).toBe('acceptEdits')
	})

	test('--permission-mode rejects invalid values up front', () => {
		expect(() =>
			parseAgentsArgs(['agents', 'p', '--permission-mode', 'bogus']),
		).toThrow()
	})

	test('--effort rejects invalid values up front', () => {
		expect(() =>
			parseAgentsArgs(['agents', 'p', '--effort', 'bogus']),
		).toThrow()
	})

	test('--plugin-dir is repeatable', () => {
		const { options } = parseAgentsArgs([
			'agents',
			'p',
			'--plugin-dir',
			'a',
			'--plugin-dir',
			'b',
		])
		expect(options.pluginDir).toEqual(['a', 'b'])
	})
})

describe('wantsAgentsDispatch', () => {
	test('false for no options and for --setting-sources alone', () => {
		expect(wantsAgentsDispatch({})).toBe(false)
		expect(wantsAgentsDispatch({ settingSources: 'user' })).toBe(false)
	})

	test('true for any dispatch flag', () => {
		expect(wantsAgentsDispatch({ model: 'm' })).toBe(true)
		expect(wantsAgentsDispatch({ addDir: ['/a'] })).toBe(true)
		expect(wantsAgentsDispatch({ dangerouslySkipPermissions: true })).toBe(
			true,
		)
		expect(wantsAgentsDispatch({ name: 'n' })).toBe(true)
	})
})

describe('buildAgentsDispatchArgs', () => {
	test('serializes every set flag, repeatable flags per value', () => {
		expect(
			buildAgentsDispatchArgs({
				addDir: ['/a', '/b'],
				settings: 's.json',
				mcpConfig: ['c.json'],
				pluginDir: ['p1', 'p2'],
				permissionMode: 'acceptEdits',
				model: 'm1',
				effort: 'high',
				dangerouslySkipPermissions: true,
				name: 'n1',
				settingSources: 'user',
			}),
		).toEqual([
			'--add-dir', '/a',
			'--add-dir', '/b',
			'--settings', 's.json',
			'--mcp-config', 'c.json',
			'--plugin-dir', 'p1',
			'--plugin-dir', 'p2',
			'--permission-mode', 'acceptEdits',
			'--model', 'm1',
			'--effort', 'high',
			'--dangerously-skip-permissions',
			'--name', 'n1',
			'--setting-sources', 'user',
		])
	})

	test('empty options produce no args', () => {
		expect(buildAgentsDispatchArgs({})).toEqual([])
	})
})

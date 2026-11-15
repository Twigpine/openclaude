/**
 * Flag handling for `openclaude agents "<prompt>"` background dispatch.
 * The dispatch flags mirror the root session options and are forwarded to
 * the spawned session. Kept as one descriptor table so the option
 * declarations, the dispatch trigger, and the childArgs re-serialization
 * cannot drift apart.
 */

import { InvalidArgumentError, Option } from '@commander-js/extra-typings'

import { PERMISSION_MODES } from '../utils/permissions/PermissionMode.js'

const collect = (val: string, prev: string[]) => [...prev, val]

function effortParser(rawValue: string): string {
	const value = rawValue.toLowerCase()
	const allowed = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
	if (!allowed.includes(value)) {
		throw new InvalidArgumentError(`It must be one of: ${allowed.join(', ')}`)
	}
	return value
}

// Single-value + collect accumulator for repeatable flags: a variadic
// <values...> option would swallow the positional prompt into the flag
// (the gh-33508 class of bug). Each flag takes exactly one arg; repeat it
// for multiple values.
export function agentsDispatchOptions(): Option[] {
	return [
		new Option('--setting-sources <sources>', 'Comma-separated list of setting sources to load (user, project, local).'),
		new Option('--add-dir <dir>', 'Additional directory to allow tool access to (repeatable)').argParser(collect).default([] as string[]),
		new Option('--settings <file-or-json>', 'Path to a settings JSON file or a JSON string to load additional settings from'),
		new Option('--mcp-config <config>', 'Load MCP servers from a JSON file or string (repeatable)').argParser(collect).default([] as string[]),
		new Option('--plugin-dir <path>', 'Load plugins from a directory for this session only (repeatable)').argParser(collect).default([] as string[]),
		new Option('--permission-mode <mode>', 'Permission mode to use for the session').argParser(String).choices(PERMISSION_MODES),
		new Option('--model <model>', 'Model to use for the session'),
		new Option('--effort <level>', 'Effort level for the session (low, medium, high, xhigh, max, ultracode)').argParser(effortParser),
		new Option('--dangerously-skip-permissions', 'Bypass all permission checks'),
		new Option('-n, --name <name>', 'Set a display name for the session'),
	]
}

export type AgentsDispatchOptionValues = {
	settingSources?: string
	addDir?: string[]
	settings?: string
	mcpConfig?: string[]
	pluginDir?: string[]
	permissionMode?: string
	model?: string
	effort?: string
	dangerouslySkipPermissions?: boolean
	name?: string
}

type DispatchFlag = {
	key: keyof AgentsDispatchOptionValues
	flag: string
}

const DISPATCH_FLAGS: DispatchFlag[] = [
	{ key: 'addDir', flag: '--add-dir' },
	{ key: 'settings', flag: '--settings' },
	{ key: 'mcpConfig', flag: '--mcp-config' },
	{ key: 'pluginDir', flag: '--plugin-dir' },
	{ key: 'permissionMode', flag: '--permission-mode' },
	{ key: 'model', flag: '--model' },
	{ key: 'effort', flag: '--effort' },
	{ key: 'dangerouslySkipPermissions', flag: '--dangerously-skip-permissions' },
	{ key: 'name', flag: '--name' },
	{ key: 'settingSources', flag: '--setting-sources' },
]

function hasValue(value: unknown): boolean {
	return Array.isArray(value) ? value.length > 0 : Boolean(value)
}

// --setting-sources scopes the agent list too, so it alone must not turn a
// bare `openclaude agents` into a dispatch. Every other flag implies one.
export function wantsAgentsDispatch(options: AgentsDispatchOptionValues): boolean {
	return DISPATCH_FLAGS.some(
		({ key }) => key !== 'settingSources' && hasValue(options[key]),
	)
}

export function buildAgentsDispatchArgs(
	options: AgentsDispatchOptionValues,
): string[] {
	const args: string[] = []
	for (const { key, flag } of DISPATCH_FLAGS) {
		const value = options[key]
		if (!hasValue(value)) continue
		if (value === true) {
			args.push(flag)
			continue
		}
		for (const item of Array.isArray(value) ? value : [value]) {
			args.push(flag, String(item))
		}
	}
	return args
}

import { getSystemContext, getUserContext } from '../../context.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'

export async function getCacheSafeParams(
  context: ToolUseContext,
  forkContextMessages: Message[],
): Promise<CacheSafeParams> {
  const appState = context.getAppState()
  const [defaultSysPrompt, userContext, systemContext] = await Promise.all([
    getSystemPrompt(
      context.options.tools,
      context.options.mainLoopModel,
      Array.from(
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      ),
      context.options.mcpClients,
    ),
    getUserContext(),
    getSystemContext(),
  ])
  const systemPrompt = buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: context,
    customSystemPrompt: context.options.customSystemPrompt,
    defaultSystemPrompt: defaultSysPrompt,
    appendSystemPrompt: context.options.appendSystemPrompt,
  })
  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext: context,
    forkContextMessages,
  }
}

import '../../integrations/index.js'
import {
  ensureIntegrationsLoaded,
  getGateway,
  getVendor,
} from '../../integrations/index.js'
import { resolveActiveRouteIdFromEnv } from '../../integrations/routeMetadata.js'
import type {
  GatewayDescriptor,
  UsageMetadata,
  VendorDescriptor,
} from '../../integrations/descriptors.js'
import type { Command } from '../../commands.js'
import type { APIProvider } from '../../utils/model/providers.js'

type UsageDescriptorTarget =
  | { kind: 'vendor'; descriptor: VendorDescriptor }
  | { kind: 'gateway'; descriptor: GatewayDescriptor }

type UsageDescriptorRegistry = {
  getGateway: typeof getGateway
  getVendor: typeof getVendor
}

export type ResolvedUsageDescriptor = {
  activeId: APIProvider | string
  activeKind?: UsageDescriptorTarget['kind']
  activeLabel: string
  resolvedId?: string
  resolvedKind?: UsageDescriptorTarget['kind']
  resolvedLabel: string
  usage: UsageMetadata
  supported: boolean
}

const DEFAULT_UNSUPPORTED_USAGE: UsageMetadata = {
  supported: false,
}

const RUNTIME_USAGE_LABELS: Record<string, string> = {
  firstParty: 'Anthropic',
  foundry: 'Microsoft Foundry',
  codex: 'Codex',
}

export function resolveActiveUsageId(
  processEnv: NodeJS.ProcessEnv = process.env,
  options?: {
    activeProfileProvider?: string
    activeProfileBaseUrl?: string
    providerCategory?: APIProvider | string
  },
): APIProvider | string {
  const providerCategory = options?.providerCategory

  if (
    providerCategory === 'firstParty' ||
    providerCategory === 'foundry' ||
    providerCategory === 'codex'
  ) {
    return providerCategory
  }

  const routeId = resolveActiveRouteIdFromEnv(processEnv, {
    activeProfileProvider: options?.activeProfileProvider,
    activeProfileBaseUrl: options?.activeProfileBaseUrl,
  })

  return routeId ?? providerCategory ?? 'firstParty'
}

function getUsageTarget(
  activeId: string,
  registry: UsageDescriptorRegistry,
): UsageDescriptorTarget | undefined {
  if (activeId === 'firstParty') {
    const vendor = registry.getVendor('anthropic')
    if (vendor) {
      return { kind: 'vendor', descriptor: vendor }
    }
  }

  const gateway = registry.getGateway(activeId)
  if (gateway) {
    return { kind: 'gateway', descriptor: gateway }
  }

  const vendor = registry.getVendor(activeId)
  if (vendor) {
    return { kind: 'vendor', descriptor: vendor }
  }

  return undefined
}

function getTargetLabel(
  activeId: string,
  target: UsageDescriptorTarget | undefined,
): string {
  return target?.descriptor.label ?? RUNTIME_USAGE_LABELS[activeId] ?? 'this provider'
}

export function getUsageDescriptor(
  activeId: APIProvider | string,
  registry: UsageDescriptorRegistry = {
    getGateway,
    getVendor,
  },
): ResolvedUsageDescriptor {
  if (registry.getGateway === getGateway && registry.getVendor === getVendor) {
    ensureIntegrationsLoaded()
  }

  const initialTarget = getUsageTarget(activeId, registry)
  const activeLabel = getTargetLabel(activeId, initialTarget)

  let resolvedTarget = initialTarget
  let usage = initialTarget?.descriptor.usage ?? DEFAULT_UNSUPPORTED_USAGE
  const seen = new Set<string>()

  while (resolvedTarget) {
    const currentUsage = resolvedTarget.descriptor.usage ?? DEFAULT_UNSUPPORTED_USAGE
    const visitKey = `${resolvedTarget.kind}:${resolvedTarget.descriptor.id}`
    if (seen.has(visitKey)) {
      usage = DEFAULT_UNSUPPORTED_USAGE
      break
    }
    seen.add(visitKey)

    if (currentUsage.delegateToVendorId) {
      const delegatedVendor = registry.getVendor(currentUsage.delegateToVendorId)
      if (!delegatedVendor) {
        usage = DEFAULT_UNSUPPORTED_USAGE
        break
      }
      resolvedTarget = {
        kind: 'vendor',
        descriptor: delegatedVendor,
      }
      usage = delegatedVendor.usage ?? DEFAULT_UNSUPPORTED_USAGE
      continue
    }

    if (currentUsage.delegateToGatewayId) {
      const delegatedGateway = registry.getGateway(currentUsage.delegateToGatewayId)
      if (!delegatedGateway) {
        usage = DEFAULT_UNSUPPORTED_USAGE
        break
      }
      resolvedTarget = {
        kind: 'gateway',
        descriptor: delegatedGateway,
      }
      usage = delegatedGateway.usage ?? DEFAULT_UNSUPPORTED_USAGE
      continue
    }

    usage = currentUsage
    break
  }

  return {
    activeId,
    activeKind: initialTarget?.kind,
    activeLabel,
    resolvedId: resolvedTarget?.descriptor.id,
    resolvedKind: resolvedTarget?.kind,
    resolvedLabel: getTargetLabel(activeId, resolvedTarget),
    usage,
    supported: usage.supported,
  }
}

export default {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show token usage on this machine and plan usage limits',
  argumentHint: '[local]',
  load: () => import('./usage.js'),
} satisfies Command

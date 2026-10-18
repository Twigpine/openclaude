import type { InternalPermissionMode } from '../../types/permissions.js'

export function shouldAvoidAgentPermissionPrompts({
  isAsync,
  canShowPermissionPrompts,
  permissionMode,
  isNonInteractiveSession,
}: {
  isAsync: boolean
  canShowPermissionPrompts?: boolean
  permissionMode: InternalPermissionMode | undefined
  isNonInteractiveSession: boolean
}): boolean {
  if (canShowPermissionPrompts !== undefined) {
    return !canShowPermissionPrompts
  }

  if (permissionMode === 'bubble') {
    return false
  }

  return isAsync && isNonInteractiveSession
}

export function canDescendantShowPermissionPrompts({
  canShowPermissionPrompts,
  permissionMode,
  isNonInteractiveSession,
}: {
  canShowPermissionPrompts?: boolean
  permissionMode: InternalPermissionMode | undefined
  isNonInteractiveSession: boolean
}): boolean {
  if (canShowPermissionPrompts !== undefined) {
    return canShowPermissionPrompts
  }

  if (permissionMode === 'bubble') {
    return true
  }

  return !isNonInteractiveSession
}

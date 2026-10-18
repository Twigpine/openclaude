import { execa, execaSync } from 'execa'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getSecureStorageServiceName,
  getUsername,
} from './macOsKeychainHelpers.js'
import type { SecureStorage, SecureStorageData } from './index.js'

/**
 * Linux-specific secure storage implementation using the secret-tool CLI.
 * secret-tool interacts with the Secret Service API (GNOME Keyring, KWallet, etc.).
 */
export const linuxSecretStorage: SecureStorage = {
  name: 'libsecret',
  read(): SecureStorageData | null {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      // secret-tool lookup service [service] account [account]
      const result = execaSync(
        'secret-tool',
        ['lookup', 'service', serviceName, 'account', username],
        { reject: false },
      )

      if (result.exitCode === 0 && result.stdout) {
        return jsonParse(result.stdout)
      }
    } catch {
      // fall through
    }
    return null
  },
  async readAsync(): Promise<SecureStorageData | null> {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const result = await execa(
        'secret-tool',
        ['lookup', 'service', serviceName, 'account', username],
        { reject: false },
      )

      if (result.exitCode === 0 && result.stdout) {
        return jsonParse(result.stdout)
      }
    } catch {
      // fall through
    }
    return null
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      const payload = jsonStringify(data)
      // secret-tool store --label=[label] service [service] account [account]
      // The payload is passed via stdin
      const result = execaSync(
        'secret-tool',
        [
          'store',
          '--label',
          serviceName,
          'service',
          serviceName,
          'account',
          username,
        ],
        { input: payload, reject: false },
      )

      return { success: result.exitCode === 0 }
    } catch {
      return { success: false }
    }
  },
  delete(): boolean {
    try {
      const username = getUsername()
      const serviceName = getSecureStorageServiceName(
        CREDENTIALS_SERVICE_SUFFIX,
      )
      // secret-tool clear service [service] account [account]
      const result = execaSync(
        'secret-tool',
        ['clear', 'service', serviceName, 'account', username],
        { reject: false },
      )
      return result.exitCode === 0
    } catch {
      return false
    }
  },
}

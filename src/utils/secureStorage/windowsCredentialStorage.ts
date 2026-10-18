import { execa, execaSync } from 'execa'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getSecureStorageServiceName,
  getUsername,
} from './macOsKeychainHelpers.js'
import type { SecureStorage, SecureStorageData } from './index.js'

/**
 * Windows-specific secure storage implementation using DPAPI for new writes,
 * with best-effort reads/deletes from the legacy PasswordVault path.
 */
function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''")
}

function getLegacyResourceName(): string {
  return getSecureStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
}

function getWindowsSecureStorageEntropy(): string {
  return `${getLegacyResourceName()}:${getUsername()}`
}

function getWindowsSecureStorageFilePath(): string {
  const resourceName = getLegacyResourceName().replace(/[^a-zA-Z0-9._-]/g, '_')
  return join(getClaudeConfigHomeDir(), `${resourceName}.secure.dpapi`)
}

function shouldUseLegacyPasswordVault(): boolean {
  return process.env.OPENCLAUDE_ENABLE_LEGACY_WINDOWS_PASSWORDVAULT === '1'
}

function runPowerShell(
  script: string,
  options?: { input?: string },
): PowerShellResult | null {
  try {
    return execaSync('powershell.exe', ['-Command', script], {
      input: options?.input,
      reject: false,
    })
  } catch {
    return null
  }
}

async function runPowerShellAsync(
  script: string,
  options?: { input?: string },
): Promise<PowerShellResult | null> {
  try {
    return await execa('powershell.exe', ['-Command', script], {
      input: options?.input,
      reject: false,
    })
  } catch {
    return null
  }
}

type PowerShellResult = {
  exitCode?: number
  stdout?: unknown
  stderr?: unknown
}

function commandOutputToString(output: unknown): string {
  if (typeof output === 'string') {
    return output
  }

  if (output instanceof Uint8Array) {
    return Buffer.from(output).toString('utf8')
  }

  if (Array.isArray(output) && output.every(item => typeof item === 'string')) {
    return output.join('\n')
  }

  return ''
}

function getFailureWarning(
  result: PowerShellResult | null,
  fallback: string,
): string {
  const stderr = commandOutputToString(result?.stderr).trim()
  if (stderr) {
    return stderr
  }

  if (typeof result?.exitCode === 'number' && result.exitCode !== 0) {
    return `${fallback} (exit code ${result.exitCode}).`
  }

  return fallback
}

function getLegacyPasswordVaultScript(): string {
  const resourceName = getLegacyResourceName().replace(/"/g, '`"')
  const username = getUsername().replace(/"/g, '`"')
  return `
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    try {
      $vault = New-Object Windows.Security.Credentials.PasswordVault
      $cred = $vault.Retrieve("${resourceName}", "${username}")
      $cred.FillPassword()
      [Console]::Out.Write($cred.Password)
    } catch {
      exit 1
    }
  `
}

function parseCredentialOutput(
  result: PowerShellResult | null,
): SecureStorageData | null {
  const stdout = commandOutputToString(result?.stdout)
  if (result?.exitCode === 0 && stdout) {
    try {
      return jsonParse(stdout)
    } catch {
      return null
    }
  }
  return null
}

function readLegacyPasswordVault(): SecureStorageData | null {
  if (!shouldUseLegacyPasswordVault()) {
    return null
  }

  return parseCredentialOutput(runPowerShell(getLegacyPasswordVaultScript()))
}

async function readLegacyPasswordVaultAsync(): Promise<SecureStorageData | null> {
  if (!shouldUseLegacyPasswordVault()) {
    return null
  }

  return parseCredentialOutput(
    await runPowerShellAsync(getLegacyPasswordVaultScript()),
  )
}

function getDpapiReadScript(): string {
  const filePath = escapePowerShellSingleQuoted(
    getWindowsSecureStorageFilePath(),
  )
  const entropy = escapePowerShellSingleQuoted(
    getWindowsSecureStorageEntropy(),
  )
  return `
    try {
      Add-Type -AssemblyName System.Security
      $path = '${filePath}'
      if (!(Test-Path -LiteralPath $path)) {
        exit 1
      }

      $protectedBase64 = [System.IO.File]::ReadAllText(
        $path,
        [System.Text.Encoding]::UTF8
      ).Trim()
      if (-not $protectedBase64) {
        exit 1
      }

      $protectedBytes = [Convert]::FromBase64String($protectedBase64)
      $entropyBytes = [System.Text.Encoding]::UTF8.GetBytes('${entropy}')
      $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $protectedBytes,
        $entropyBytes,
        [System.Security.Cryptography.DataProtectionScope]::CurrentUser
      )
      [Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes))
    } catch {
      exit 1
    }
  `
}

export const windowsCredentialStorage: SecureStorage = {
  name: 'credential-locker-dpapi',
  read(): SecureStorageData | null {
    return (
      parseCredentialOutput(runPowerShell(getDpapiReadScript())) ??
      readLegacyPasswordVault()
    )
  },
  async readAsync(): Promise<SecureStorageData | null> {
    return (
      parseCredentialOutput(await runPowerShellAsync(getDpapiReadScript())) ??
      (await readLegacyPasswordVaultAsync())
    )
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    const filePath = escapePowerShellSingleQuoted(
      getWindowsSecureStorageFilePath(),
    )
    const entropy = escapePowerShellSingleQuoted(
      getWindowsSecureStorageEntropy(),
    )
    const payload = jsonStringify(data)
    const script = `
      try {
        Add-Type -AssemblyName System.Security
        $path = '${filePath}'
        $directory = [System.IO.Path]::GetDirectoryName($path)
        if ($directory) {
          [System.IO.Directory]::CreateDirectory($directory) | Out-Null
        }

        $payload = [Console]::In.ReadToEnd()
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
        $entropyBytes = [System.Text.Encoding]::UTF8.GetBytes('${entropy}')
        $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
          $bytes,
          $entropyBytes,
          [System.Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $protectedBase64 = [Convert]::ToBase64String($protectedBytes)
        [System.IO.File]::WriteAllText(
          $path,
          $protectedBase64,
          [System.Text.Encoding]::UTF8
        )
      } catch {
        Write-Error $_.Exception.Message
        exit 1
      }
    `
    const result = runPowerShell(script, { input: payload })
    if (result?.exitCode === 0) {
      return { success: true }
    }

    return {
      success: false,
      warning: getFailureWarning(
        result,
        'Windows secure storage could not encrypt credentials with DPAPI',
      ),
    }
  },
  delete(): boolean {
    const filePath = escapePowerShellSingleQuoted(
      getWindowsSecureStorageFilePath(),
    )
    const removeDpapiScript = `
      try {
        $path = '${filePath}'
        if (Test-Path -LiteralPath $path) {
          Remove-Item -LiteralPath $path -Force
        }
      } catch {
        exit 1
      }
    `
    const removeDpapiResult = runPowerShell(removeDpapiScript)

    if (shouldUseLegacyPasswordVault()) {
      const resourceName = getLegacyResourceName().replace(/"/g, '`"')
      const username = getUsername().replace(/"/g, '`"')
      const removeLegacyScript = `
        Add-Type -AssemblyName System.Runtime.WindowsRuntime
        try {
          $vault = New-Object Windows.Security.Credentials.PasswordVault
          $cred = $vault.Retrieve("${resourceName}", "${username}")
          $vault.Remove($cred)
        } catch {
          exit 0
        }
      `
      const removeLegacyResult = runPowerShell(removeLegacyScript)

      void removeLegacyResult
    }

    return (removeDpapiResult?.exitCode ?? 1) === 0
  },
}

import { logForDebugging } from './debug.js'
import { z } from 'zod/v4'

// ─── Original bounded int validation ───

export type EnvVarValidationResult = {
  effective: number
  status: 'valid' | 'capped' | 'invalid'
  message?: string
}

export function validateBoundedIntEnvVar(
  name: string,
  value: string | undefined,
  defaultValue: number,
  upperLimit: number,
): EnvVarValidationResult {
  if (!value) {
    return { effective: defaultValue, status: 'valid' }
  }
  const parsed = parseInt(value, 10)
  if (isNaN(parsed) || parsed <= 0) {
    const result: EnvVarValidationResult = {
      effective: defaultValue,
      status: 'invalid',
      message: `Invalid value "${value}" (using default: ${defaultValue})`,
    }
    logForDebugging(`${name} ${result.message}`)
    return result
  }
  if (parsed > upperLimit) {
    const result: EnvVarValidationResult = {
      effective: upperLimit,
      status: 'capped',
      message: `Capped from ${parsed} to ${upperLimit}`,
    }
    logForDebugging(`${name} ${result.message}`)
    return result
  }
  return { effective: parsed, status: 'valid' }
}

// ─── Zod startup validation ───

const optionalNonEmptyString = z.preprocess(
  value => (value === '' ? undefined : value),
  z.string().min(1).optional(),
)

const EnvSchema = z.object({
  ANTHROPIC_API_KEY: optionalNonEmptyString,
  ANTHROPIC_AUTH_TOKEN: optionalNonEmptyString,
  OPENCLAUDE_CONFIG_DIR: optionalNonEmptyString,
  CLAUDE_CONFIG_DIR: optionalNonEmptyString,
  HTTP_PROXY: z.url().optional().or(z.literal('')),
  HTTPS_PROXY: z.url().optional().or(z.literal('')),
  NODE_EXTRA_CA_CERTS: optionalNonEmptyString,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: z.string().optional(),
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: z.string().optional(),
  CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: z.string().optional(),
})

export type ValidatedEnv = z.infer<typeof EnvSchema>

export function validateEnvVars(): ValidatedEnv {
  const result = EnvSchema.safeParse(process.env)

  if (!result.success) {
    const errors = result.error.issues.map(issue => {
      const path = issue.path.join('.')
      return `  ${path}: ${issue.message}`
    }).join('\n')

    console.error('❌ Environment variable validation failed:')
    console.error(errors)
    console.error('\nPlease fix the above environment variables and try again.')
    process.exit(1)
  }

  return result.data
}

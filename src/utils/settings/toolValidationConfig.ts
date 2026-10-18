/**
 * Tool validation configuration
 *
 * Most tools need NO configuration - basic validation works automatically.
 * Only add your tool here if it has special pattern requirements.
 */

export type ToolValidationConfig = {
  /** Tools that accept file glob patterns (e.g., *.ts, src/**) */
  filePatternTools: string[]

  /** Tools that accept bash wildcard patterns (* anywhere) and legacy :* prefix syntax */
  bashPrefixTools: string[]

  /** Custom validation rules for specific tools */
  customValidation: {
    [toolName: string]: (content: string) => {
      valid: boolean
      error?: string
      suggestion?: string
      examples?: string[]
    }
  }
}

export const TOOL_VALIDATION_CONFIG: ToolValidationConfig = {
  // File pattern tools (accept *.ts, src/**, etc.)
  filePatternTools: [
    'Read',
    'Write',
    'Edit',
    'Glob',
    'NotebookRead',
    'NotebookEdit',
  ],

  // Bash wildcard tools (accept * anywhere, and legacy command:* syntax)
  bashPrefixTools: ['Bash'],

  // Custom validation (only if needed)
  customValidation: {
    // WebSearch doesn't support wildcards or complex patterns
    WebSearch: content => {
      if (content.includes('*') || content.includes('?')) {
        return {
          valid: false,
          error: 'WebSearch does not support wildcards',
          suggestion: 'Use exact search terms without * or ?',
          examples: ['WebSearch(claude ai)', 'WebSearch(typescript tutorial)'],
        }
      }
      return { valid: true }
    },

    // WebFetch uses domain: prefix for hostname-based permissions
    WebFetch: content => {
      // Check if it's trying to use a URL format
      if (content.includes('://') || content.startsWith('http')) {
        return {
          valid: false,
          error: 'WebFetch permissions use domain format, not URLs',
          suggestion: 'Use "domain:hostname" format',
          examples: [
            'WebFetch(domain:example.com)',
            'WebFetch(domain:github.com)',
          ],
        }
      }

      // Must start with domain: prefix
      if (!content.startsWith('domain:')) {
        return {
          valid: false,
          error: 'WebFetch permissions must use "domain:" prefix',
          suggestion: 'Use "domain:hostname" format',
          examples: [
            'WebFetch(domain:example.com)',
            'WebFetch(domain:*.google.com)',
          ],
        }
      }

      // Allow wildcards in domain patterns
      // Valid: domain:*.example.com, domain:example.*, etc.
      return { valid: true }
    },
  },
}

// Helper to check if a tool uses file patterns
export function isFilePatternTool(toolName: string): boolean {
  return TOOL_VALIDATION_CONFIG.filePatternTools.includes(toolName)
}

// Helper to check if a tool uses bash prefix patterns
export function isBashPrefixTool(toolName: string): boolean {
  return TOOL_VALIDATION_CONFIG.bashPrefixTools.includes(toolName)
}

// Helper to get custom validation for a tool
export function getCustomValidation(toolName: string) {
  // customValidation is a plain object, so a bracket lookup keyed by a
  // caller-supplied tool name resolves inherited Object.prototype members. A
  // permission-rule name like `__proto__` (or `__defineGetter__`, which slips
  // past the uppercase-first gate because `'_'.toUpperCase() === '_'`) would
  // otherwise return a truthy inherited value that the caller then invokes as a
  // function, throwing and aborting settings validation. Only treat own tools
  // as configured — mirrors normalizeLegacyToolName in permissionRuleParser.
  return Object.hasOwn(TOOL_VALIDATION_CONFIG.customValidation, toolName)
    ? TOOL_VALIDATION_CONFIG.customValidation[toolName]
    : undefined
}

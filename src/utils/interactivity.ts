import { hasPrintFlag } from './printFlag.js'

/**
 * Determines if the current session should be treated as interactive.
 * Robustly handles SSH sessions which might not report TTY status accurately.
 */
export function isInteractiveSession(options: {
  stdoutIsTTY: boolean;
  args: string[];
  env: NodeJS.ProcessEnv;
}): boolean {
  const { stdoutIsTTY, args, env } = options;

  // Explicit non-interactive flags
  const isPrint = hasPrintFlag(args);
  const hasInitOnlyFlag = args.includes('--init-only');
  const hasSdkUrl = args.some(arg => arg.startsWith('--sdk-url'));

  if (isPrint || hasInitOnlyFlag || hasSdkUrl) {
    return false;
  }

  // Robust interactivity check: consider SSH sessions as interactive even if isTTY is unreliable.
  // Standard SSH environment variable SSH_TTY (path to tty) is only set when a pty is allocated.
  const isSSH = Boolean(env.SSH_TTY);

  return stdoutIsTTY || isSSH;
}

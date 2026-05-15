// Local imports - CLI runtime
import {
  CLI_APPROVAL_POLICIES,
  type CliApprovalPolicy,
} from './approvalPolicy';
import type { CliGlobalArgs } from './cliContext';

/**
 * Global flag identifiers used by every subcommand. Inlined per-command (not
 * spread) so citty's `defineCommand<const T>` generic preserves the enum
 * literal types for `ctx.args['output-format']` and `ctx.args['approval-policy']`.
 *
 * Keep these descriptions in sync between commands.
 */
export const GLOBAL_DESCRIPTION = {
  print: 'Run in headless mode (no interactive prompts; final result + exit).',
  cwd: 'Working directory (defaults to the current shell cwd).',
  outputFormat: 'Output format: text, json, or ndjson (default text).',
  approvalPolicy: `Approval policy: ${CLI_APPROVAL_POLICIES.join(', ')} (default never).`,
} as const;

/**
 * Shape produced by citty's parser for the four global flags after each
 * subcommand inlines them with `type: 'enum'` + literal `options`. Used as the
 * input to `pickGlobalArgs` so handlers don't repeat runtime narrowing.
 */
export interface ParsedGlobalArgs {
  readonly print?: boolean;
  readonly cwd?: string;
  readonly 'output-format': 'text' | 'json' | 'ndjson';
  readonly 'approval-policy': CliApprovalPolicy;
}

export function pickGlobalArgs(args: ParsedGlobalArgs): CliGlobalArgs {
  const cwd =
    typeof args.cwd === 'string' && args.cwd.trim().length > 0
      ? args.cwd.trim()
      : undefined;
  return {
    print: args.print === true,
    cwd,
    outputFormat: args['output-format'],
    approvalPolicy: args['approval-policy'],
  };
}

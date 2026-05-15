// Local imports - CLI runtime
import { type CliApprovalPolicy } from './approvalPolicy';
import type { CliGlobalArgs } from './cliContext';

/**
 * Shape produced by citty's parser for the four global flags after each
 * subcommand inlines them with `type: 'enum'` + literal `options`. Subcommand
 * definitions in `commands/root.ts` re-declare these args inline (not via a
 * spread) so citty's `defineCommand<const T>` generic preserves the enum
 * literal types — this is the input contract for `pickGlobalArgs`.
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

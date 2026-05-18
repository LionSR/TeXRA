import { isNonEmptyString } from '@utils/core/stringCore';

import type { CliApprovalPolicy } from './approvalPolicy';
import type { CliOutputFormat } from './cliConfig';
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
  readonly quiet?: boolean;
  readonly cwd?: string;
  readonly 'output-format'?: CliOutputFormat;
  readonly 'approval-policy'?: CliApprovalPolicy;
}

export function pickGlobalArgs(args: ParsedGlobalArgs): CliGlobalArgs {
  return {
    print: args.print === true,
    quiet: args.quiet === true,
    cwd: isNonEmptyString(args.cwd) ? args.cwd.trim() : undefined,
    outputFormat: args['output-format'],
    approvalPolicy: args['approval-policy'],
  };
}

import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import type { ApiAccessMode } from '@shared/schemas/settingsViewMessages';
import { isNonEmptyString } from '@utils/text/stringUtils';

import type { CliOutputFormat } from '../schemas/cliSettings';
import type { CliGlobalArgs } from './cliContext';

/**
 * Shape produced by citty's parser for the shared global flags after each
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
  readonly 'approval-policy'?: TexraApprovalPolicy;
  readonly 'api-mode'?: ApiAccessMode | string;
  // Positively-named boolean (default `true`); citty sets this to `false`
  // when the user passes `--no-color`.
  readonly color?: boolean;
  readonly 'no-input'?: boolean;
  readonly 'include-interop'?: boolean;
  readonly source?: string | string[];
  // citty treats every `--no-*` token as a negated positive flag before it
  // applies aliases, so `--no-input` can arrive as `input: false`.
  readonly input?: unknown;
}

interface PickGlobalArgsOptions {
  readonly skillSourcePaths?: readonly string[];
}

function stringValues(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) {
    return value.filter(isNonEmptyString).map((entry) => entry.trim());
  }
  return isNonEmptyString(value) ? [value.trim()] : [];
}

export function pickGlobalArgs(
  args: ParsedGlobalArgs,
  options: PickGlobalArgsOptions = {},
): CliGlobalArgs {
  return {
    print: args.print === true,
    quiet: args.quiet === true,
    cwd: isNonEmptyString(args.cwd) ? args.cwd : undefined,
    outputFormat: args['output-format'],
    approvalPolicy: args['approval-policy'],
    apiMode: isNonEmptyString(args['api-mode'])
      ? args['api-mode'].trim()
      : undefined,
    // `--no-input` is intentionally not registered as `input` so it does not
    // become a leading global `--input <file>` flag. citty still parses the
    // negative spelling as `input: false`, which is safe to recognize here
    // because command-specific `--input <file>` arrives as a string/array.
    noColor: args.color === false,
    noInput: args['no-input'] === true || args.input === false,
    includeInteropSkills: args['include-interop'] === true,
    skillSourcePaths: options.skillSourcePaths ?? stringValues(args.source),
  };
}

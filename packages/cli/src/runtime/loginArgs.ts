// Local imports - auth
import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';

// Local imports - CLI runtime
import {
  cliFlagName,
  CLI_BOOLEAN_FLAGS,
  GLOBAL_FLAGS_WITH_VALUE,
} from './cliFlags';

export type LoginArgParseError =
  | { kind: 'missing-value'; flag: string }
  | { kind: 'unknown-flag'; flag: string }
  | { kind: 'unexpected-argument'; value: string };

export interface ParsedLoginArgs {
  readonly globalArgs: readonly string[];
  readonly provider: string;
  readonly noBrowser: boolean;
  readonly error?: LoginArgParseError;
}

export interface ParseLoginArgsOptions {
  readonly allowGlobalArgs?: boolean;
  readonly allowLoginOptions?: boolean;
}

export function parseLoginArgs(
  args: readonly string[],
  options: ParseLoginArgsOptions = {},
): ParsedLoginArgs {
  const globalArgs: string[] = [];
  let provider: string | undefined;
  let noBrowser = false;
  let index = 0;
  const allowLoginOptions = options.allowLoginOptions ?? true;

  const result = (error?: LoginArgParseError): ParsedLoginArgs => ({
    globalArgs,
    provider: provider ?? DEFAULT_OAUTH_PROVIDER,
    noBrowser,
    error,
  });

  while (index < args.length) {
    const arg = args[index];
    if (arg == null) break;

    if (allowLoginOptions) {
      const inlineProvider = arg.startsWith('--provider=')
        ? arg.slice('--provider='.length)
        : undefined;
      if (inlineProvider !== undefined) {
        if (inlineProvider === '') {
          return result({ kind: 'missing-value', flag: '--provider' });
        }
        provider = inlineProvider;
        index += 1;
        continue;
      }

      if (arg === '--provider') {
        const value = args[index + 1];
        if (value == null || value.startsWith('-')) {
          return result({ kind: 'missing-value', flag: '--provider' });
        }
        provider = value;
        index += 2;
        continue;
      }

      if (arg === '--no-browser') {
        noBrowser = true;
        index += 1;
        continue;
      }
    }

    const flagName = cliFlagName(arg);
    if (options.allowGlobalArgs && GLOBAL_FLAGS_WITH_VALUE.has(flagName)) {
      if (arg.includes('=')) {
        const value = arg.slice(arg.indexOf('=') + 1);
        if (value === '') {
          return result({ kind: 'missing-value', flag: flagName });
        }
        globalArgs.push(arg);
        index += 1;
        continue;
      }

      const value = args[index + 1];
      if (value == null || value.startsWith('-')) {
        return result({ kind: 'missing-value', flag: flagName });
      }
      globalArgs.push(arg);
      globalArgs.push(value);
      index += 2;
      continue;
    }

    if (options.allowGlobalArgs && CLI_BOOLEAN_FLAGS.has(flagName)) {
      globalArgs.push(arg);
      index += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      return result({ kind: 'unknown-flag', flag: arg });
    }

    if (allowLoginOptions && provider == null) {
      provider = arg;
      index += 1;
      continue;
    }

    return result({ kind: 'unexpected-argument', value: arg });
  }

  return result();
}

export function loginArgParseErrorMessage(
  error: LoginArgParseError,
  commandName = 'login',
): string {
  switch (error.kind) {
    case 'missing-value':
      return `Missing value for ${error.flag}.`;
    case 'unknown-flag':
      return `Unknown ${commandName} flag: ${error.flag}`;
    case 'unexpected-argument':
      return `Unexpected ${commandName} argument: ${error.value}`;
  }
}

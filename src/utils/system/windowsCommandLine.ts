import * as path from 'node:path';

import * as ChildProcess from 'effect/unstable/process/ChildProcess';

import { whichOnExtendedPath } from '@utils/system/platformPaths';

// cross-spawn's cmd.exe escaping: quote each argument (doubling the
// backslashes that precede a quote or the closing quote), then caret-escape
// the cmd metacharacters; a `.cmd`/`.bat` shim re-parses its line, so twice.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdArgument(arg: string): string {
  const quoted = `"${arg
    .replaceAll(/(?=(\\+?)?)\1"/g, '$1$1\\"')
    .replace(/(?=(\\+?)?)\1$/, '$1$1')}"`;
  return quoted.replaceAll(CMD_META, '^$1').replaceAll(CMD_META, '^$1');
}

/**
 * Node's spawn does no PATHEXT resolution and, since CVE-2024-27980, refuses
 * a `.cmd`/`.bat` without a shell. An `.exe`/`.com` hit is spawned by its
 * resolved path; a shim becomes one escaped `cmd.exe` line; a miss is spawned
 * as named and fails to start.
 */
export function toWindowsCommand(
  argv0: string,
  args: readonly string[],
  options: ChildProcess.CommandOptions,
): ChildProcess.StandardCommand {
  const resolved = whichOnExtendedPath(argv0);
  if (resolved === null) return ChildProcess.make(argv0, args, options);
  if (!/\.(cmd|bat)$/i.test(resolved)) {
    return ChildProcess.make(resolved, args, options);
  }
  const line = [
    path.normalize(resolved).replaceAll(CMD_META, '^$1'),
    ...args.map(escapeCmdArgument),
  ].join(' ');
  return ChildProcess.make(line, { ...options, shell: true });
}

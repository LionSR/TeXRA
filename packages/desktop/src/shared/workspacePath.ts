import { isDesktopProtocolUrl } from './desktopProtocol.js';

const WORKSPACE_PATH_FLAG = '--texra-workspace-path';

/**
 * The folder to open at launch, from `--texra-workspace-path <path>` or
 * `--texra-workspace-path=<path>`. Used by the e2e harness and by shell
 * launches; the remembered papers come from global state, not from argv.
 */
export function parseWorkspacePathFromArgv(
  argv: readonly string[],
): string | undefined {
  for (const [index, arg] of argv.entries()) {
    if (arg === WORKSPACE_PATH_FLAG) {
      return readWorkspacePathValue(argv[index + 1]);
    }
    if (arg.startsWith(`${WORKSPACE_PATH_FLAG}=`)) {
      return readWorkspacePathValue(arg.slice(arg.indexOf('=') + 1));
    }
  }
  return undefined;
}

function readWorkspacePathValue(arg: string | undefined): string | undefined {
  const trimmed = arg?.trim();
  if (!trimmed || trimmed.startsWith('--') || isDesktopProtocolUrl(trimmed)) {
    return undefined;
  }
  return trimmed;
}

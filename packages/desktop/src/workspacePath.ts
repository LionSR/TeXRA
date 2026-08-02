import { isDesktopProtocolUrl } from './desktopProtocol.js';

export interface WorkspacePathOptions {
  argv?: readonly string[];
  storedWorkspacePath?: string;
}

const WORKSPACE_PRESENT_ARG = '--texra-has-workspace=';
// Strip the retired separate-process flag from relaunch arguments. Electron's
// single-instance lifecycle cannot safely host a second process that shares
// the same profile and application state.
const LEGACY_NEW_WINDOW_ARG = '--texra-new-window';
const WORKSPACE_PATH_FLAGS = [
  '--texra-workspace-path',
  '--texra-workspace',
] as const;
const CANONICAL_WORKSPACE_PATH_FLAG = WORKSPACE_PATH_FLAGS[0];
export const DESKTOP_WORKSPACE_PATH_STATE_KEY = 'texra.desktop.workspacePath';

export function getWorkspacePathInput(
  options: WorkspacePathOptions = {},
): string | undefined {
  const argv = options.argv ?? process.argv.slice(1);
  const argvWorkspacePath = parseWorkspacePathFromArgv(argv);
  if (argvWorkspacePath) return argvWorkspacePath;

  return options.storedWorkspacePath?.trim() || undefined;
}

export function serializeWorkspacePresenceArg(hasWorkspace: boolean): string {
  return `${WORKSPACE_PRESENT_ARG}${hasWorkspace ? '1' : '0'}`;
}

export function withWorkspacePathArg(
  argv: readonly string[],
  workspacePath: string,
): string[] {
  const nextArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg == null) continue;
    if (arg === LEGACY_NEW_WINDOW_ARG) continue;
    if (isDesktopProtocolUrl(arg)) continue;
    if (isWorkspacePathFlag(arg)) {
      const value = argv[index + 1];
      if (value != null && !value.startsWith('--')) {
        index += 1;
      }
      continue;
    }
    if (isWorkspacePathAssignment(arg)) continue;
    nextArgs.push(arg);
  }
  nextArgs.push(`${CANONICAL_WORKSPACE_PATH_FLAG}=${workspacePath}`);
  return nextArgs;
}

export function hasResolvedWorkspacePath(
  options: Pick<WorkspacePathOptions, 'argv'> = {},
): boolean {
  const argv = options.argv ?? process.argv;
  const flag = argv.find((arg) => arg.startsWith(WORKSPACE_PRESENT_ARG));
  return flag?.slice(WORKSPACE_PRESENT_ARG.length) === '1';
}

/**
 * Parse workspace path from argv with flexible flag name support.
 * Handles both `--texra-workspace-path` and `--texra-workspace` formats.
 */
export function parseWorkspacePathFromArgv(
  argv: readonly string[],
): string | undefined {
  for (const [index, arg] of argv.entries()) {
    if (isWorkspacePathFlag(arg)) {
      return readWorkspacePathValue(argv[index + 1]);
    }
    if (isWorkspacePathAssignment(arg)) {
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

function isWorkspacePathFlag(arg: string): boolean {
  return (WORKSPACE_PATH_FLAGS as readonly string[]).includes(arg);
}

function isWorkspacePathAssignment(arg: string): boolean {
  return WORKSPACE_PATH_FLAGS.some((flag) => arg.startsWith(`${flag}=`));
}

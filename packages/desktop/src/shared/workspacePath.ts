import { isDesktopProtocolUrl } from './desktopProtocol.js';

export interface WorkspacePathOptions {
  argv?: readonly string[];
  storedWorkspacePath?: string;
}

const WORKSPACE_PRESENT_ARG = '--texra-has-workspace=';
const WORKSPACE_PATH_FLAG = '--texra-workspace-path';
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
  nextArgs.push(`${WORKSPACE_PATH_FLAG}=${workspacePath}`);
  return nextArgs;
}

export function hasResolvedWorkspacePath(
  options: Pick<WorkspacePathOptions, 'argv'> = {},
): boolean {
  const argv = options.argv ?? process.argv.slice(1);
  const flag = argv.find((arg) => arg.startsWith(WORKSPACE_PRESENT_ARG));
  return flag?.slice(WORKSPACE_PRESENT_ARG.length) === '1';
}

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
  return arg === WORKSPACE_PATH_FLAG;
}

function isWorkspacePathAssignment(arg: string): boolean {
  return arg.startsWith(`${WORKSPACE_PATH_FLAG}=`);
}

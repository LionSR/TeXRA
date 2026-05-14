import { isDesktopProtocolUrl } from './desktopProtocol.js';

interface WorkspacePathOptions {
  env?: Partial<Pick<NodeJS.ProcessEnv, 'TEXRA_WORKSPACE_PATH'>>;
  argv?: readonly string[];
  storedWorkspacePath?: string;
}

const WORKSPACE_PRESENT_ARG = '--texra-has-workspace=';
const NEW_WINDOW_ARG = '--texra-new-window';
const WORKSPACE_PATH_FLAGS = [
  '--texra-workspace-path',
  '--texra-workspace',
] as const;
const CANONICAL_WORKSPACE_PATH_FLAG = WORKSPACE_PATH_FLAGS[0];
export const DESKTOP_WORKSPACE_PATH_STATE_KEY = 'texra.desktop.workspacePath';

export function getWorkspacePathInput(
  options: WorkspacePathOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(1);
  const argvWorkspacePath = parseWorkspacePathFromArgv(argv);
  if (argvWorkspacePath) return argvWorkspacePath;

  const configured = env.TEXRA_WORKSPACE_PATH?.trim();
  if (configured) return configured;

  return options.storedWorkspacePath?.trim() || undefined;
}

export function hasWorkspacePath(options: WorkspacePathOptions = {}): boolean {
  return getWorkspacePathInput(options) != null;
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
    if (arg === NEW_WINDOW_ARG) continue;
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

export function withNewWindowWorkspaceArgs(
  argv: readonly string[],
  workspacePath: string,
): string[] {
  const nextArgs = withWorkspacePathArg(argv, workspacePath);
  nextArgs.push(NEW_WINDOW_ARG);
  return nextArgs;
}

export function isNewWindowLaunch(
  options: Pick<WorkspacePathOptions, 'argv'> = {},
): boolean {
  const argv = options.argv ?? process.argv.slice(1);
  return argv.includes(NEW_WINDOW_ARG);
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg == null) continue;
    if (isWorkspacePathFlag(arg)) {
      return getPositionalWorkspacePathArg(argv[index + 1]);
    }
    if (isWorkspacePathAssignment(arg)) {
      const eqIndex = arg.indexOf('=');
      return getPositionalWorkspacePathArg(arg.slice(eqIndex + 1));
    }
  }
  return undefined;
}

function getPositionalWorkspacePathArg(
  arg: string | undefined,
): string | undefined {
  const trimmed = arg?.trim();
  if (!trimmed || trimmed.startsWith('--') || isDesktopProtocolUrl(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function isWorkspacePathFlag(arg: string): boolean {
  return WORKSPACE_PATH_FLAGS.includes(
    arg as (typeof WORKSPACE_PATH_FLAGS)[number],
  );
}

function isWorkspacePathAssignment(arg: string): boolean {
  return WORKSPACE_PATH_FLAGS.some((flag) => arg.startsWith(`${flag}=`));
}

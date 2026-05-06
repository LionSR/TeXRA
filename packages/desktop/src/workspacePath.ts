import { isDesktopProtocolUrl } from './desktopProtocol.js';

interface WorkspacePathOptions {
  env?: Partial<Pick<NodeJS.ProcessEnv, 'TEXRA_WORKSPACE_PATH'>>;
  argv?: readonly string[];
  storedWorkspacePath?: string;
}

const WORKSPACE_PRESENT_ARG = '--texra-has-workspace=';
export const DESKTOP_WORKSPACE_PATH_STATE_KEY = 'texra.desktop.workspacePath';

export function getWorkspacePathInput(
  options: WorkspacePathOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(1);
  const argvWorkspacePath = getWorkspacePathArg(argv);
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
    if (isDesktopProtocolCallbackArg(arg)) continue;
    if (arg === '--texra-workspace') {
      const value = argv[index + 1];
      if (value != null && !value.startsWith('--')) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--texra-workspace=')) continue;
    nextArgs.push(arg);
  }
  nextArgs.push('--texra-workspace', workspacePath);
  return nextArgs;
}

export function hasResolvedWorkspacePath(
  options: Pick<WorkspacePathOptions, 'argv'> = {},
): boolean {
  const argv = options.argv ?? process.argv;
  const flag = argv.find((arg) => arg.startsWith(WORKSPACE_PRESENT_ARG));
  return flag?.slice(WORKSPACE_PRESENT_ARG.length) === '1';
}

function getWorkspacePathArg(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg == null) continue;
    if (arg === '--texra-workspace') {
      return getPositionalWorkspacePathArg(argv[index + 1]);
    }
    if (arg.startsWith('--texra-workspace=')) {
      return getPositionalWorkspacePathArg(
        arg.slice('--texra-workspace='.length),
      );
    }
  }
  return undefined;
}

function getPositionalWorkspacePathArg(
  arg: string | undefined,
): string | undefined {
  const trimmed = arg?.trim();
  if (
    !trimmed ||
    trimmed.startsWith('--') ||
    isDesktopProtocolCallbackArg(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function isDesktopProtocolCallbackArg(arg: string): boolean {
  return isDesktopProtocolUrl(arg);
}

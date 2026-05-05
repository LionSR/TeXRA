interface WorkspacePathOptions {
  env?: Partial<Pick<NodeJS.ProcessEnv, 'TEXRA_WORKSPACE_PATH'>>;
  argv?: readonly string[];
}

const WORKSPACE_PRESENT_ARG = '--texra-has-workspace=';

export function getWorkspacePathInput(
  options: WorkspacePathOptions = {},
): string | undefined {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv.slice(1);
  const argvWorkspacePath = getWorkspacePathArg(argv);
  if (argvWorkspacePath) return argvWorkspacePath;

  const configured = env.TEXRA_WORKSPACE_PATH?.trim();
  if (configured) return configured;

  return undefined;
}

export function hasWorkspacePath(options: WorkspacePathOptions = {}): boolean {
  return getWorkspacePathInput(options) != null;
}

export function serializeWorkspacePresenceArg(hasWorkspace: boolean): string {
  return `${WORKSPACE_PRESENT_ARG}${hasWorkspace ? '1' : '0'}`;
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
      return arg.slice('--texra-workspace='.length).trim() || undefined;
    }
  }
  return undefined;
}

function getPositionalWorkspacePathArg(
  arg: string | undefined,
): string | undefined {
  const trimmed = arg?.trim();
  if (!trimmed || trimmed.startsWith('--')) return undefined;
  return trimmed;
}

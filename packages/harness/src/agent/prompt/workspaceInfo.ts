// Standard library imports
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { DateTime, Effect } from 'effect';

// Local imports
import { escapeTextStrict } from '@shared/utils/xmlEscape';
import type { MemoryFolder } from '@agent/memory/memoryLayout';
import {
  currentBranch,
  isGitRepository,
  workTreeDirty,
} from '@utils/system/git';
import { envVar } from '@utils/system/envFlags';
import { IS_WINDOWS } from '@utils/system/platformPaths';
import { runsInWsl } from '@utils/system/wslDetect';

/** Heading introducing external directories (such as memory folders) in `<workspace_info>`. */
export const ACCESSIBLE_EXTERNAL_DIRS_HEADING =
  'Accessible external directories';

/** The tools the external directories are listed for, as the list names them. */
export const EXTERNAL_ROOT_TOOLS = Object.freeze([
  'read_file',
  'write_file',
  'grep',
  'glob',
  'edit_file',
] as const);
interface GitInfo {
  branch: string | null;
  dirty: boolean;
}

/** Detect the user's default shell basename (e.g., "bash", "zsh", "PowerShell"). */
const detectShell: Effect.Effect<string | undefined> = Effect.map(
  envVar(IS_WINDOWS ? 'ComSpec' : 'SHELL'),
  (shell) => {
    if (!shell) return undefined;
    if (!IS_WINDOWS) return path.basename(shell);
    const name = path.basename(shell).toLowerCase();
    if (name === 'powershell.exe' || name === 'pwsh.exe') return 'PowerShell';
    if (name === 'cmd.exe') return 'cmd';
    return name.replace(/\.exe$/, '');
  },
);

/** Get a human-readable platform name. */
function getPlatformLabel(): string {
  let base: string;
  switch (process.platform) {
    case 'darwin':
      base = 'macOS';
      break;
    case 'win32':
      base = 'Windows';
      break;
    case 'linux':
      base = runsInWsl() ? 'Linux/WSL' : 'Linux';
      break;
    default:
      base = process.platform;
  }
  return `${base} (${os.arch()})`;
}

/**
 * Gather git repository information for the workspace: null when it is not
 * a work tree, or when git cannot say whether it is dirty (a timeout must not
 * read as clean).
 */
const getGitInfo = Effect.fn(function* (workspaceRoot: string) {
  const [inside, branch, dirty] = yield* Effect.all(
    [
      isGitRepository(workspaceRoot),
      currentBranch(workspaceRoot),
      workTreeDirty(workspaceRoot),
    ],
    { concurrency: 'unbounded' },
  );
  if (!inside || dirty === null) return null;
  return { branch, dirty } satisfies GitInfo;
});

/**
 * Build a formatted workspace info block for system prompt injection.
 *
 * Returns a `<workspace_info>` XML block with key environment details
 * that help the LLM understand the user's workspace context.
 *
 * @param wsPath - The run's workspace root, or undefined when no folder is open.
 * @param offered - The tools the run offers, by name: the external
 *   directories are listed only for a run offered a tool that reads them,
 *   and the advice before a git command only for one offered `bash`.
 * @param memory - The run's memory folders, listed with those directories.
 */
export const buildWorkspaceInfoBlock = Effect.fn(function* (
  wsPath: string | undefined,
  offered: readonly string[],
  memory: readonly MemoryFolder[],
) {
  const platform = getPlatformLabel();
  const shell = yield* detectShell;
  const date = DateTime.formatIsoDateUtc(yield* DateTime.now);
  const git = wsPath ? yield* getGitInfo(wsPath) : null;

  const lines: string[] = [];

  if (wsPath) lines.push(`Workspace: ${escapeTextStrict(wsPath)}`);

  lines.push(`Platform: ${escapeTextStrict(platform)}`);

  if (shell) {
    lines.push(`Shell: ${escapeTextStrict(shell)}`);
  }

  lines.push(`Date: ${date}`);

  if (git) {
    const branchPart = git.branch
      ? `branch=${escapeTextStrict(git.branch)}`
      : 'detached HEAD';
    const parts = ['Git: yes', branchPart];
    if (git.dirty) parts.push('uncommitted changes');
    lines.push(parts.join(', '));
  } else if (wsPath && offered.includes('bash')) {
    // Only a run that can run git is told to check before it does.
    lines.push(
      'Git: this workspace is not a git work tree, or git could not be checked; confirm a repository exists before running git history or status checks.',
    );
  }

  const externalRoots = EXTERNAL_ROOT_TOOLS.some((name) =>
    offered.includes(name),
  )
    ? memory.map((folder) => ({
        absolutePath: folder.path,
        label: `${folder.label}: notes on ${folder.holds}`,
        writable: true,
      }))
    : [];
  if (externalRoots.length > 0) {
    lines.push('');
    lines.push(
      `${ACCESSIBLE_EXTERNAL_DIRS_HEADING} (absolute paths; use ${EXTERNAL_ROOT_TOOLS.join(', ')}):`,
    );
    for (const root of externalRoots) {
      const rw = root.writable ? 'writable' : 'read-only';
      lines.push(
        `  ${escapeTextStrict(root.absolutePath)}: ${escapeTextStrict(root.label)} (${rw})`,
      );
    }
  }
  return `\n<workspace_info>\n${lines.join('\n')}\n</workspace_info>`;
});

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { executeCommand } from '@texra-ai/harness/node';
import { COMMIT_HASH_PATTERN } from '@texra/utils/git/commitHashPattern';
import { COMMIT_LABEL_FORMAT } from '@texra/utils/git/commitLogFormat';
import type { WorkspaceRoots } from '@texra-ai/harness';

/** The label of `commitHash` in the workspace's history, the hash itself when
 *  it has no label, or `null` when it is not a commit there. */
export const findCommitInHistory = Effect.fn('findCommitInHistory')(function* (
  roots: WorkspaceRoots,
  commitHash: string,
) {
  if (typeof commitHash !== 'string') {
    return null;
  }

  const sanitizedCommit = commitHash.trim();
  if (!COMMIT_HASH_PATTERN.test(sanitizedCommit)) {
    return null;
  }

  const workspacePath = roots.workspace;
  if (!workspacePath) {
    return null;
  }

  const gitOptions = {
    cwd: workspacePath,
    settings: roots,
    quiet: true,
  };
  const verifyResult = yield* executeCommand(
    ['git', 'rev-parse', '--verify', `${sanitizedCommit}^{commit}`],
    gitOptions,
  );

  if (!verifyResult.success) {
    return null;
  }

  const labelResult = yield* executeCommand(
    ['git', 'show', '-s', `--format=${COMMIT_LABEL_FORMAT}`, sanitizedCommit],
    gitOptions,
  );

  if (!labelResult.success) {
    return sanitizedCommit;
  }

  return labelResult.stdout;
});

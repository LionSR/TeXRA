// Standard library imports
import * as path from 'node:path';

// Third-party imports
import ignore from 'ignore';

// Local imports - common
import { isFileNotFoundError } from '@common/errors';

// Local imports - utils
import { filterNotNull } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toPosixPath } from '@utils/core/pathCore';
import { safeHomedir } from '@utils/system/platformPaths';

type GitignoreSource = {
  absolutePath: string;
  content: string;
};

export type GitignoreMatcher = {
  hasRules: boolean;
  ignores: (relativePath: string) => boolean;
  ignoreFiles: string[];
};

const EMPTY_GITIGNORE_MATCHER: GitignoreMatcher = {
  hasRules: false,
  ignores: () => false,
  ignoreFiles: [],
};

let gitignoreMatcherPromise: Promise<GitignoreMatcher> | undefined;

async function readGitignoreFile(
  absolutePath: string,
  readContent: () => Promise<string>,
): Promise<GitignoreSource | null> {
  try {
    const content = await readContent();
    return { absolutePath, content };
  } catch (error) {
    if (isFileNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

async function readWorkspaceGitignore(
  relativePath: string,
): Promise<GitignoreSource | null> {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return null;
  }
  const normalized = relativePath.replace(/^\/+/, '');
  return readGitignoreFile(path.join(workspacePath, normalized), () =>
    WorkspaceFS.read(normalized),
  );
}

async function readGlobalGitignore(): Promise<GitignoreSource | null> {
  const homeDirectory = safeHomedir();
  if (!homeDirectory) {
    return null;
  }
  const absolutePath = path.join(homeDirectory, '.gitignore_global');
  return readGitignoreFile(absolutePath, () => AbsoluteFS.read(absolutePath));
}

async function loadGitignoreMatcher(): Promise<GitignoreMatcher> {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return EMPTY_GITIGNORE_MATCHER;
  }

  const sources = (
    await Promise.all([
      readGlobalGitignore(),
      readWorkspaceGitignore('.gitignore_global'),
      readWorkspaceGitignore('.gitignore'),
    ])
  ).filter(filterNotNull);

  if (sources.length === 0) {
    return EMPTY_GITIGNORE_MATCHER;
  }

  const ig = ignore();
  for (const source of sources) {
    ig.add(source.content);
  }

  return {
    hasRules: true,
    ignores: (relativePath: string): boolean => {
      if (!relativePath || relativePath === '.') {
        return false;
      }
      const normalized = toPosixPath(relativePath);
      // Try plain path first; also try with trailing slash so that
      // directory-only rules (e.g. "dist/") match bare directory names
      // ("dist") the same way the old minimatch-based parser did.
      // Known deviation from strict git spec: a *file* named "dist" would
      // also be ignored by a "dist/" rule, because we cannot distinguish
      // files from directories without a stat call. The old parser had the
      // same behaviour (it expanded "dist/" → ["dist", "dist/**"]).
      return ig.ignores(normalized) || ig.ignores(normalized + '/');
    },
    ignoreFiles: sources.map((source) => source.absolutePath),
  };
}

export async function getGitignoreMatcher(): Promise<GitignoreMatcher> {
  if (!gitignoreMatcherPromise) {
    gitignoreMatcherPromise = loadGitignoreMatcher();
  }
  const matcherPromise = gitignoreMatcherPromise;
  try {
    return await matcherPromise;
  } catch (error) {
    if (gitignoreMatcherPromise === matcherPromise) {
      gitignoreMatcherPromise = undefined;
    }
    throw error;
  }
}

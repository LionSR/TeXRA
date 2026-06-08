// Standard library imports
import * as path from 'path';

// Third-party imports
import ignore from 'ignore';

// Local imports - utils
import { warn } from '@logger/logUtils';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import { filterNotNull } from '@utils/core';
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
  } catch {
    return null;
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
  const exists = await WorkspaceFS.exists(normalized);
  if (!exists) {
    return null;
  }
  return readGitignoreFile(path.join(workspacePath, normalized), () =>
    WorkspaceFS.read(normalized),
  );
}

async function readAbsoluteGitignore(
  absolutePath: string,
): Promise<GitignoreSource | null> {
  const exists = await AbsoluteFS.exists(absolutePath);
  if (!exists) {
    return null;
  }
  return readGitignoreFile(absolutePath, () => AbsoluteFS.read(absolutePath));
}

async function readGlobalGitignore(): Promise<GitignoreSource[]> {
  const homeDirectory = safeHomedir();
  if (!homeDirectory) {
    return [];
  }
  try {
    const source = await readAbsoluteGitignore(
      path.join(homeDirectory, '.gitignore_global'),
    );
    return source ? [source] : [];
  } catch {
    return [];
  }
}

async function loadGitignoreMatcher(): Promise<GitignoreMatcher> {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return EMPTY_GITIGNORE_MATCHER;
  }

  try {
    const [globalSources, workspaceGlobalSource, workspaceSource] =
      await Promise.all([
        readGlobalGitignore(),
        readWorkspaceGitignore('.gitignore_global'),
        readWorkspaceGitignore('.gitignore'),
      ]);

    const sources = [
      ...globalSources,
      workspaceGlobalSource,
      workspaceSource,
    ].filter(filterNotNull);

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
        try {
          // Try plain path first; also try with trailing slash so that
          // directory-only rules (e.g. "dist/") match bare directory names
          // ("dist") the same way the old minimatch-based parser did.
          return ig.ignores(normalized) || ig.ignores(normalized + '/');
        } catch {
          return false;
        }
      },
      ignoreFiles: sources.map((source) => source.absolutePath),
    };
  } catch (error) {
    // Falling back to the empty matcher silently disables ALL gitignore
    // filtering, so surface this rather than hiding a degraded mode.
    warn('gitignore', 'Failed to load .gitignore rules; ignoring nothing', {
      data: error,
    });
    return EMPTY_GITIGNORE_MATCHER;
  }
}

export async function getGitignoreMatcher(): Promise<GitignoreMatcher> {
  if (!gitignoreMatcherPromise) {
    gitignoreMatcherPromise = loadGitignoreMatcher();
  }
  return gitignoreMatcherPromise;
}

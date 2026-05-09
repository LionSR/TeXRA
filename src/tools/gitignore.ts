// Standard library imports
import * as path from 'path';

// Local imports - utils
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import { splitContentLines } from '@utils/text/stringUtils';
import { toPosixPath } from '@utils/core/pathCore';
import { safeHomedir } from '@utils/system/platformPaths';

// Local file imports
import { createGlobMatcher } from './utils';

type GitignoreRule = {
  matcher: (value: string) => boolean;
  negated: boolean;
};

type GitignoreSource = {
  absolutePath: string;
  rules: GitignoreRule[];
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

function expandGitignorePattern(
  pattern: string,
  options: { anchored: boolean; dirOnly: boolean },
): string[] {
  const normalized = pattern.replaceAll('\\', '/');
  let basePattern: string;
  if (options.anchored) {
    basePattern = normalized.replace(/^\/+/, '');
  } else if (normalized.startsWith('**/')) {
    basePattern = normalized;
  } else {
    basePattern = `**/${normalized}`;
  }

  if (!options.dirOnly) {
    return [basePattern];
  }

  // For directory-only patterns, match both the dir and its contents
  return basePattern.endsWith('/**')
    ? [basePattern]
    : [basePattern, `${basePattern}/**`];
}

function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  const lines = splitContentLines(content);

  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    let negated = false;
    if (line.startsWith('!') && !line.startsWith('\\!')) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1);
    }

    const anchored = line.startsWith('/');
    line = anchored ? line.slice(1) : line;

    const dirOnly = line.endsWith('/');
    line = dirOnly ? line.slice(0, -1) : line;

    if (!line) {
      continue;
    }

    line = line.replaceAll('\\ ', ' ');
    line = line.replaceAll('\\#', '#').replaceAll('\\!', '!');

    const patterns = expandGitignorePattern(line, { anchored, dirOnly });
    for (const pattern of patterns) {
      rules.push({ matcher: createGlobMatcher(pattern), negated });
    }
  }

  return rules;
}

async function readGitignoreFile(
  absolutePath: string,
  readContent: () => Promise<string>,
): Promise<GitignoreSource | null> {
  try {
    const content = await readContent();
    return { absolutePath, rules: parseGitignore(content) };
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
    ].filter((source): source is GitignoreSource => source !== null);

    const rules = sources.flatMap((source) => source.rules);
    if (rules.length === 0) {
      return EMPTY_GITIGNORE_MATCHER;
    }

    return {
      hasRules: true,
      ignores: (relativePath: string): boolean => {
        if (!relativePath || relativePath === '.') {
          return false;
        }
        const normalized = toPosixPath(relativePath);
        let ignored = false;
        for (const rule of rules) {
          if (rule.matcher(normalized)) {
            ignored = !rule.negated;
          }
        }
        return ignored;
      },
      ignoreFiles: sources.map((source) => source.absolutePath),
    };
  } catch {
    return EMPTY_GITIGNORE_MATCHER;
  }
}

export async function getGitignoreMatcher(): Promise<GitignoreMatcher> {
  if (!gitignoreMatcherPromise) {
    gitignoreMatcherPromise = loadGitignoreMatcher();
  }
  return gitignoreMatcherPromise;
}

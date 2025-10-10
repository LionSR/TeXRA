// Standard library imports
import * as os from 'os';
import * as path from 'path';

// Third-party imports
import { Minimatch } from 'minimatch';

// Local imports - utils
import { toPosixPath } from '@tools/pathUtils';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';

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

function createGlobMatcher(pattern: string): (value: string) => boolean {
  const matcher = new Minimatch(pattern, {
    dot: true,
    matchBase: true,
    nocase: false,
  });

  return (value: string) => matcher.match(value.replace(/\\/g, '/'));
}

function expandGitignorePattern(
  pattern: string,
  options: { anchored: boolean; dirOnly: boolean },
): string[] {
  const normalized = pattern.replace(/\\/g, '/');
  const basePattern = options.anchored
    ? normalized.replace(/^\/+/, '')
    : normalized.startsWith('**/')
      ? normalized
      : `**/${normalized}`;

  if (!options.dirOnly) {
    return [basePattern];
  }

  const patterns: string[] = [basePattern];
  const directoryPattern = basePattern.endsWith('/**')
    ? basePattern
    : `${basePattern}/**`;
  if (!patterns.includes(directoryPattern)) {
    patterns.push(directoryPattern);
  }
  return patterns;
}

function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    if (!rawLine) {
      continue;
    }

    let line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('#')) {
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

    line = line.replace(/\\ /g, ' ');
    line = line.replace(/\\#/g, '#').replace(/\\!/g, '!');

    const patterns = expandGitignorePattern(line, { anchored, dirOnly });
    for (const pattern of patterns) {
      rules.push({ matcher: createGlobMatcher(pattern), negated });
    }
  }

  return rules;
}

async function readWorkspaceGitignore(
  relativePath: string,
): Promise<GitignoreSource | null> {
  try {
    const workspacePath = WorkspaceFS.getPath();
    if (!workspacePath) {
      return null;
    }

    const normalized = relativePath.replace(/^\/+/, '');
    const exists = await WorkspaceFS.exists(normalized);
    if (!exists) {
      return null;
    }

    const content = await WorkspaceFS.read(normalized);
    return {
      absolutePath: path.join(workspacePath, normalized),
      rules: parseGitignore(content),
    };
  } catch {
    return null;
  }
}

async function readAbsoluteGitignore(
  absolutePath: string,
): Promise<GitignoreSource | null> {
  try {
    const exists = await AbsoluteFS.exists(absolutePath);
    if (!exists) {
      return null;
    }

    const content = await AbsoluteFS.read(absolutePath);
    return {
      absolutePath,
      rules: parseGitignore(content),
    };
  } catch {
    return null;
  }
}

async function readGlobalGitignore(): Promise<GitignoreSource[]> {
  try {
    const homeDirectory = os.homedir();
    if (!homeDirectory) {
      return [];
    }

    const candidates = [path.join(homeDirectory, '.gitignore_global')];

    const sources = await Promise.all(
      candidates.map((candidate) => readAbsoluteGitignore(candidate)),
    );
    return sources.filter(
      (source): source is GitignoreSource => source !== null,
    );
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

    const sources: GitignoreSource[] = [
      ...globalSources,
      ...(workspaceGlobalSource ? [workspaceGlobalSource] : []),
      ...(workspaceSource ? [workspaceSource] : []),
    ];

    const rules = sources.flatMap((source) => source.rules);
    if (rules.length === 0) {
      return EMPTY_GITIGNORE_MATCHER;
    }

    const ignoreFiles = sources.map((source) => source.absolutePath);

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
      ignoreFiles,
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

export function clearGitignoreCache(): void {
  gitignoreMatcherPromise = undefined;
}

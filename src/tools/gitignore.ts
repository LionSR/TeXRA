// Third-party imports
import { Minimatch } from 'minimatch';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

type GitignoreRule = {
  matcher: (value: string) => boolean;
  negated: boolean;
};

export type GitignoreMatcher = {
  hasRules: boolean;
  ignores: (relativePath: string) => boolean;
};

const EMPTY_GITIGNORE_MATCHER: GitignoreMatcher = {
  hasRules: false,
  ignores: () => false,
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

function toPosixPath(relativePath: string): string {
  if (!relativePath || relativePath === '.') {
    return '.';
  }
  return relativePath.split(/[\\/]/).join('/');
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

async function loadGitignoreMatcher(): Promise<GitignoreMatcher> {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    return EMPTY_GITIGNORE_MATCHER;
  }

  try {
    const hasGitignore = await WorkspaceFS.exists('.gitignore');
    if (!hasGitignore) {
      return EMPTY_GITIGNORE_MATCHER;
    }

    const content = await WorkspaceFS.read('.gitignore');
    const rules = parseGitignore(content);
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

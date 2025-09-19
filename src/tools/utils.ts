// Standard library imports
import * as path from 'path';

// Third-party imports
import { Minimatch } from 'minimatch';

// Local imports - tools
import { ToolError } from '@tools/result';

// Local imports - utils
import { WorkspaceFS } from '@utils/files';

/**
 * Helper function to truncate long output for logging
 *
 * @param text Text to truncate
 * @param maxLength Maximum length before truncation
 * @returns Truncated text if needed
 */
export function maybe_truncate(text: string, maxLength: number = 5000): string {
  if (text.length <= maxLength) {
    return text;
  }

  const truncatedText =
    text.substring(0, maxLength) +
    `\n...(truncated, ${text.length - maxLength} more characters)`;
  return truncatedText;
}

export interface WorkspacePathResolution {
  relative: string;
  absolute: string;
}

/**
 * Resolve a potentially absolute or relative path against the workspace root.
 *
 * The returned relative path is normalized and guaranteed to remain inside the
 * workspace. Throws if the workspace folder cannot be determined or if the
 * resolved location would escape the workspace root.
 */
export function resolveWorkspaceRelativePath(
  targetPath?: string,
): WorkspacePathResolution {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) {
    throw new ToolError('Workspace path is not available.');
  }

  if (!targetPath || targetPath.trim() === '' || targetPath === '.') {
    return {
      relative: '.',
      absolute: workspacePath,
    };
  }

  const trimmed = targetPath.trim();
  const absoluteCandidate = path.resolve(workspacePath, trimmed);
  const relativeCandidate = path.relative(workspacePath, absoluteCandidate);
  const normalizedRelative =
    relativeCandidate === '' ? '.' : path.normalize(relativeCandidate);

  const segments = normalizedRelative.split(path.sep).filter(Boolean);
  if (segments.some((segment) => segment === '..')) {
    throw new ToolError('Path must stay within the workspace.');
  }

  return {
    relative: normalizedRelative,
    absolute: absoluteCandidate,
  };
}

/**
 * Convert a workspace-relative path into a POSIX style string for display or
 * tool output. Keeps `.` as-is for the workspace root.
 */
export function toPosixPath(relativePath: string): string {
  if (!relativePath || relativePath === '.') {
    return '.';
  }
  return relativePath.split(path.sep).join('/');
}

/**
 * Join a workspace-relative base path with a child segment and ensure the
 * result stays within the workspace root.
 */
export function joinWorkspaceRelativePath(
  baseRelative: string,
  child: string,
): WorkspacePathResolution {
  const base = baseRelative && baseRelative !== '.' ? baseRelative : '.';
  const combined = base === '.' ? child : path.join(base, child);
  return resolveWorkspaceRelativePath(combined);
}

/**
 * Compile a glob pattern into a matcher that operates on POSIX-style paths.
 * Supports `*`, `?`, and `**` tokens.
 */
export function createGlobMatcher(pattern: string): (value: string) => boolean {
  const matcher = new Minimatch(pattern, {
    dot: true,
    matchBase: true,
    nocase: false,
  });

  return (value: string) => matcher.match(value.replace(/\\/g, '/'));
}

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
    if (line.startsWith('!') && !line.startsWith('\!')) {
      negated = true;
      line = line.slice(1);
    } else if (line.startsWith('\#') || line.startsWith('\!')) {
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

/**
 * Format tool output with a header and content.
 */
export function formatToolOutput(
  header: string,
  content: string | string[] | null,
  noMatchesText: string = '(no entries)',
): string {
  if (!content || (Array.isArray(content) && content.length === 0)) {
    return `${header}\n${noMatchesText}`;
  }
  const lines = Array.isArray(content) ? content.join('\n') : content;
  return `${header}\n${lines}`;
}

/**
 * Common pattern for resolving and formatting workspace paths.
 */
export function resolveAndFormat(path?: string): {
  resolved: WorkspacePathResolution;
  display: string;
} {
  const resolved = resolveWorkspaceRelativePath(path);
  const display = toPosixPath(resolved.relative);
  return { resolved, display };
}

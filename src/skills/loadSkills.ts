// Standard library imports
import * as path from 'node:path';

// Local imports - platform
import { platform } from '@platform/platform';
import { isDirectory } from '@utils/files/fsEntryType';

// Local imports - common
import {
  isFileNotFoundError,
  isNotADirectoryError,
  toErrorMessage,
} from '@common/errors';
import { byName } from '@utils/core';

// Local imports - skill parsing
import { type SkillLoadIssue, issue, loadSkillDirectory } from './skillLoader';
import type { Skill } from './SkillSchema';

export {
  type SkillIssueCode,
  type SkillIssueSeverity,
  type SkillLoadIssue,
} from './skillLoader';

export interface DiscoverSkillsResult {
  skills: Skill[];
  errors: SkillLoadIssue[];
}

export type SkillSourceScope =
  'bundled' | 'user' | 'project' | 'interop' | 'custom';

export interface SkillSource {
  scope: SkillSourceScope;
  path: string;
  label?: string;
  required?: boolean;
}

export interface SourcedSkill {
  skill: Skill;
  source: SkillSource;
}

export interface DiscoverSkillSourcesResult {
  skills: SourcedSkill[];
  errors: SkillLoadIssue[];
}

function dupNameIssue(name: string, path: string): SkillLoadIssue {
  return issue(
    'warning',
    'duplicate_name',
    `Skipping duplicate skill name "${name}"`,
    { path, name },
  );
}

function dupRealpathIssue(
  realPath: string,
  path: string,
  name?: string,
): SkillLoadIssue {
  return issue(
    'warning',
    'duplicate_realpath',
    `Skipping duplicate skill path ${realPath}`,
    name === undefined ? { path } : { path, name },
  );
}

/**
 * Discover one-level `SKILL.md` packages below `root`.
 *
 * Missing roots are treated as empty because user and project skill directories
 * are optional. Per-skill failures are reported and do not abort discovery.
 */
export async function discoverSkills(
  root: string,
): Promise<DiscoverSkillsResult> {
  const skills: Skill[] = [];
  const errors: SkillLoadIssue[] = [];
  const seenNames = new Set<string>();
  const seenRealPaths = new Set<string>();

  let entries: [string, number][];
  try {
    entries = await platform().fs.readDirectory(root);
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return { skills, errors };
    }

    errors.push(
      issue('error', 'read_error', toErrorMessage(err), {
        path: root,
      }),
    );
    return { skills, errors };
  }

  const sortedEntries = entries
    .map(([name, type]) => ({ name, type }))
    .sort(byName);

  for (const entry of sortedEntries) {
    const skillDir = path.join(root, entry.name);
    // `readDirectory`'s type bitmask doesn't reliably surface the symlink bit
    // on every FileSystemProvider backend (see `FileSystemProvider.isSymlink`
    // doc comment), so fall back to the dedicated symlink check for entries
    // the bitmask doesn't already report as a directory.
    if (
      !isDirectory(entry.type) &&
      !(await platform().fs.isSymlink(skillDir))
    ) {
      continue;
    }

    const skillPath = path.join(skillDir, 'SKILL.md');
    let realSkillPath: string;
    try {
      realSkillPath = await platform().fs.realPath(skillPath);
    } catch (err) {
      if (!isFileNotFoundError(err)) {
        errors.push(
          issue('warning', 'read_error', toErrorMessage(err), {
            path: skillPath,
          }),
        );
      }
      continue;
    }

    if (seenRealPaths.has(realSkillPath)) {
      errors.push(dupRealpathIssue(realSkillPath, skillPath));
      continue;
    }
    seenRealPaths.add(realSkillPath);

    const loaded = await loadSkillDirectory(skillDir, entry.name);
    errors.push(...loaded.errors);
    if (!loaded.skill) continue;

    if (seenNames.has(loaded.skill.name)) {
      errors.push(dupNameIssue(loaded.skill.name, loaded.skill.path));
      continue;
    }

    seenNames.add(loaded.skill.name);
    skills.push(loaded.skill);
  }

  return { skills, errors };
}

/**
 * Validate a `required` skill source, returning an issue when the path is
 * missing or not a directory. Optional sources skip this check entirely.
 */
async function validateRequiredSource(
  source: SkillSource,
): Promise<SkillLoadIssue | undefined> {
  try {
    const sourceStat = await platform().fs.stat(source.path);
    if (!isDirectory(sourceStat.type)) {
      return issue(
        'error',
        'invalid_source',
        'Skill source is not a directory',
        {
          path: source.path,
        },
      );
    }
    return undefined;
  } catch (err) {
    if (isFileNotFoundError(err)) {
      return issue('error', 'missing_source', 'Skill source does not exist', {
        path: source.path,
      });
    }
    if (isNotADirectoryError(err)) {
      return issue(
        'error',
        'invalid_source',
        'Skill source is not a directory',
        {
          path: source.path,
        },
      );
    }
    return issue('error', 'source_read_error', toErrorMessage(err), {
      path: source.path,
    });
  }
}

/**
 * Discover skills from several roots in precedence order.
 *
 * The one-root loader remains useful for tests and direct imports. This wrapper
 * adds the cross-root invariants needed by runtimes: a skill name or canonical
 * `SKILL.md` file is accepted only from the first source that provides it.
 */
export async function discoverSkillSources(
  sources: readonly SkillSource[],
): Promise<DiscoverSkillSourcesResult> {
  const skills: SourcedSkill[] = [];
  const errors: SkillLoadIssue[] = [];
  const seenNames = new Set<string>();
  const seenRealPaths = new Set<string>();

  for (const source of sources) {
    if (source.required === true) {
      const sourceError = await validateRequiredSource(source);
      if (sourceError) {
        errors.push(sourceError);
        continue;
      }
    }

    const result = await discoverSkills(source.path);
    errors.push(
      ...result.errors.map((error) =>
        source.required === true &&
        error.severity === 'error' &&
        error.code === 'read_error' &&
        error.path === source.path
          ? { ...error, code: 'source_read_error' as const }
          : error,
      ),
    );

    for (const skill of result.skills) {
      let realSkillPath = skill.path;
      try {
        realSkillPath = await platform().fs.realPath(skill.path);
      } catch {
        // The one-root loader has already read this file. If the path vanishes
        // between the read and this check, name deduplication still suffices.
      }

      if (seenRealPaths.has(realSkillPath)) {
        errors.push(dupRealpathIssue(realSkillPath, skill.path, skill.name));
        continue;
      }

      if (seenNames.has(skill.name)) {
        errors.push(dupNameIssue(skill.name, skill.path));
        continue;
      }

      seenRealPaths.add(realSkillPath);
      seenNames.add(skill.name);
      skills.push({ skill, source });
    }
  }

  return { skills, errors };
}

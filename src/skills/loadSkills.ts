// Standard library imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Local imports - common
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { byName } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - skill parsing
import { type SkillLoadIssue, issue, loadSkillDirectory } from './skillLoader';
import type { Skill } from './SkillSchema';

// Local imports - utilities
import type { Dirent } from 'node:fs';

export { type SkillLoadIssue } from './skillLoader';

export interface DiscoverSkillsResult {
  skills: Skill[];
  errors: SkillLoadIssue[];
}

type SkillSourceScope = 'bundled' | 'user' | 'project' | 'interop' | 'custom';

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

  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
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

  for (const entry of entries.sort(byName)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const skillDir = path.join(root, entry.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    let realSkillPath: string;
    try {
      realSkillPath = await fs.realpath(skillPath);
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
    const sourceStat = await fs.stat(source.path);
    if (!sourceStat.isDirectory()) {
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
        realSkillPath = await fs.realpath(skill.path);
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

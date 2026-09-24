// Standard library imports
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';

// Local imports - common
import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import type { ActiveSkillSourceScope } from '@shared/schemas';
import { byName } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - skill parsing
import { type SkillLoadIssue, issue, loadSkillDirectory } from './skillLoader';
import type { Dirent } from 'node:fs';
import type { Skill } from './SkillSchema';

export { type SkillLoadIssue } from './skillLoader';

interface DiscoveredSkill {
  skill: Skill;
  /** Canonical `SKILL.md` path, resolved while the skill was discovered. */
  realPath: string;
  /** The skill's directory name under its root, the scan's sort key. */
  entryName: string;
}

interface SkillRootScan {
  skills: DiscoveredSkill[];
  errors: SkillLoadIssue[];
}

/** Scope vocabulary comes from the shared wire-contract enum
 *  (`@shared/schemas/activeSkills`) so the loader and the persisted snapshot
 *  can't drift. */
export interface SkillSource {
  readonly scope: ActiveSkillSourceScope;
  readonly path: string;
  readonly label?: string;
  readonly required?: boolean;
}

/**
 * One precedence tier of sources. A `source` tier scans its roots one after
 * another; a `name` tier pools its roots and orders their skills by directory
 * name, the order one root holding all of them would give.
 */
export interface SkillSourceTier {
  readonly order: 'source' | 'name';
  readonly sources: readonly SkillSource[];
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
const scanSkillRoot = Effect.fn('skills.scanSkillRoot')(function* (
  root: string,
): Effect.fn.Return<SkillRootScan> {
  const skills: DiscoveredSkill[] = [];
  const errors: SkillLoadIssue[] = [];
  const seenNames = new Set<string>();
  const seenRealPaths = new Set<string>();

  const entries: Dirent[] | undefined = yield* Effect.tryPromise({
    try: () => fs.readdir(root, { withFileTypes: true }),
    catch: ensureError,
  }).pipe(
    Effect.catch((err) =>
      Effect.sync(() => {
        if (!isFileNotFoundError(err)) {
          errors.push(
            issue('error', 'read_error', toErrorMessage(err), {
              path: root,
            }),
          );
        }
        return undefined;
      }),
    ),
  );
  if (entries === undefined) return { skills, errors };

  for (const entry of entries.sort(byName)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    const skillDir = path.join(root, entry.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    const realSkillPath: string | undefined = yield* Effect.tryPromise({
      try: () => fs.realpath(skillPath),
      catch: ensureError,
    }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          if (!isFileNotFoundError(err)) {
            errors.push(
              issue('warning', 'read_error', toErrorMessage(err), {
                path: skillPath,
              }),
            );
          }
          return undefined;
        }),
      ),
    );
    if (realSkillPath === undefined) continue;

    if (seenRealPaths.has(realSkillPath)) {
      errors.push(dupRealpathIssue(realSkillPath, skillPath));
      continue;
    }
    seenRealPaths.add(realSkillPath);

    const loaded = yield* loadSkillDirectory(skillDir, entry.name);
    errors.push(...loaded.errors);
    if (!loaded.skill) continue;

    if (seenNames.has(loaded.skill.name)) {
      errors.push(dupNameIssue(loaded.skill.name, loaded.skill.path));
      continue;
    }

    seenNames.add(loaded.skill.name);
    skills.push({
      skill: loaded.skill,
      realPath: realSkillPath,
      entryName: entry.name,
    });
  }

  return { skills, errors };
});

/**
 * Validate a `required` skill source, returning an issue when the path is
 * missing or not a directory. Optional sources skip this check entirely.
 */
function validateRequiredSource(
  source: SkillSource,
): Effect.Effect<SkillLoadIssue | undefined> {
  const notADirectory = () =>
    issue('error', 'invalid_source', 'Skill source is not a directory', {
      path: source.path,
    });
  return Effect.tryPromise({
    try: () => fs.stat(source.path),
    catch: ensureError,
  }).pipe(
    Effect.map((sourceStat) =>
      sourceStat.isDirectory() ? undefined : notADirectory(),
    ),
    Effect.catch((err) => {
      if (isFileNotFoundError(err)) {
        return Effect.succeed(
          issue('error', 'missing_source', 'Skill source does not exist', {
            path: source.path,
          }),
        );
      }
      if (!isNotADirectoryError(err)) {
        return Effect.succeed(
          issue('error', 'source_read_error', toErrorMessage(err), {
            path: source.path,
          }),
        );
      }
      return Effect.succeed(notADirectory());
    }),
  );
}

/**
 * Discover skills from tiers of roots in precedence order.
 *
 * On top of the per-root scan this adds the cross-root invariants runtimes
 * need: a skill name or canonical `SKILL.md` file is accepted only from the
 * first source that provides it, in the tier's order.
 */
export const discoverSkillSources = Effect.fn('skills.discoverSkillSources')(
  function* (
    tiers: readonly SkillSourceTier[],
  ): Effect.fn.Return<DiscoverSkillSourcesResult> {
    const skills: SourcedSkill[] = [];
    const errors: SkillLoadIssue[] = [];
    const seenNames = new Set<string>();
    const seenRealPaths = new Set<string>();

    const accept = (
      found: readonly (DiscoveredSkill & { source: SkillSource })[],
    ) => {
      for (const { skill, realPath, source } of found) {
        if (seenRealPaths.has(realPath)) {
          errors.push(dupRealpathIssue(realPath, skill.path, skill.name));
          continue;
        }

        if (seenNames.has(skill.name)) {
          errors.push(dupNameIssue(skill.name, skill.path));
          continue;
        }

        seenRealPaths.add(realPath);
        seenNames.add(skill.name);
        skills.push({ skill, source });
      }
    };

    for (const tier of tiers) {
      // A name-ordered tier accepts once, after every root is scanned.
      const pooled: (DiscoveredSkill & { source: SkillSource })[] = [];
      for (const source of tier.sources) {
        if (source.required === true) {
          const sourceError = yield* validateRequiredSource(source);
          if (sourceError) {
            errors.push(sourceError);
            continue;
          }
        }

        const result = yield* scanSkillRoot(source.path);
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

        const found = result.skills.map((entry) => ({ ...entry, source }));
        if (tier.order === 'source') accept(found);
        else pooled.push(...found);
      }
      accept(pooled.toSorted((a, b) => a.entryName.localeCompare(b.entryName)));
    }

    return { skills, errors };
  },
);

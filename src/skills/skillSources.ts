import * as os from 'node:os';
import * as path from 'node:path';

import type { SkillSource } from './loadSkills';

export interface SkillSourceContext {
  readonly cwd: string;
  readonly resourcesPath: string;
}

export interface SkillSourceOptions {
  readonly includeInterop?: boolean;
  readonly additionalPaths?: readonly string[];
}

export const INTEROP_SKILL_DIRS = ['.claude', '.codex', '.gemini'] as const;

function bundledSkillSources(resourcesPath: string): SkillSource[] {
  return [
    {
      scope: 'bundled',
      path: path.join(resourcesPath, 'skills'),
      label: 'bundled',
    },
    {
      scope: 'bundled',
      path: path.resolve(resourcesPath, '../../..', 'skills'),
      label: 'bundled source',
    },
  ];
}

function resolveSkillSourcePath(base: string, candidate: string): string {
  return path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(base, candidate);
}

function uniqueSources(sources: readonly SkillSource[]): SkillSource[] {
  const unique: SkillSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    const key = path.resolve(source.path);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...source, path: key });
  }
  return unique;
}

export function defaultSkillSources(
  context: SkillSourceContext,
  options: SkillSourceOptions = {},
): SkillSource[] {
  const home = os.homedir();
  const sources: SkillSource[] = [
    ...bundledSkillSources(context.resourcesPath),
    {
      scope: 'user',
      path: path.join(home, '.texra', 'skills'),
      label: 'user',
    },
    {
      scope: 'project',
      path: path.join(context.cwd, '.texra', 'skills'),
      label: 'project',
    },
  ];

  if (options.includeInterop === true) {
    for (const dir of INTEROP_SKILL_DIRS) {
      sources.push(
        {
          scope: 'interop',
          path: path.join(home, dir, 'skills'),
          label: `${dir} user`,
        },
        {
          scope: 'interop',
          path: path.join(context.cwd, dir, 'skills'),
          label: `${dir} project`,
        },
      );
    }
  }

  for (const candidate of options.additionalPaths ?? []) {
    sources.push({
      scope: 'custom',
      path: resolveSkillSourcePath(context.cwd, candidate),
      label: 'custom',
    });
  }

  return uniqueSources(sources);
}

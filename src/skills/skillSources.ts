import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { safeHomedir } from '@utils/system/platformPaths';

import type { SkillSource } from './loadSkills';

interface SkillSourceContext {
  readonly cwd: string;
  readonly resourcesPath: string;
}

export interface SkillSourceOptions {
  readonly includeInterop?: boolean;
  readonly additionalPaths?: readonly string[];
}

export const INTEROP_SKILL_DIRS = [
  '.agents',
  '.claude',
  '.codex',
  '.gemini',
] as const;

function bundledSkillSources(resourcesPath: string): SkillSource[] {
  const packagedSource = {
    scope: 'bundled',
    path: path.join(resourcesPath, 'skills'),
    label: 'bundled',
  } satisfies SkillSource;
  if (existsSync(packagedSource.path)) return [packagedSource];

  return [
    packagedSource,
    {
      scope: 'bundled',
      path: path.resolve(resourcesPath, '../../..', 'skills'),
      label: 'bundled source',
    },
    {
      scope: 'bundled',
      path: path.resolve(resourcesPath, '../../../..', 'skills'),
      label: 'bundled source',
    },
  ];
}

function interopSkillSources(base: string, scopeLabel: string): SkillSource[] {
  return INTEROP_SKILL_DIRS.map((dir) => ({
    scope: 'interop',
    path: path.join(base, dir, 'skills'),
    label: `${dir} ${scopeLabel}`,
  }));
}

function uniqueSources(sources: readonly SkillSource[]): SkillSource[] {
  const seen = new Map<string, SkillSource>();
  for (const source of sources) {
    const key = path.resolve(source.path);
    const existing = seen.get(key);
    if (existing) {
      if (source.required === true) {
        seen.set(key, { ...existing, required: true });
      }
    } else {
      seen.set(key, { ...source, path: key });
    }
  }
  return [...seen.values()];
}

export function defaultSkillSources(
  context: SkillSourceContext,
  options: SkillSourceOptions = {},
): SkillSource[] {
  // `safeHomedir()` never throws (unlike raw `os.homedir()`, which can raise
  // UV_ENOENT in containers/CI); `/nonexistent` matches the fallback used by
  // other agnostic-zone callers (e.g. `claudeAgentConfig.ts`).
  const home = safeHomedir() ?? '/nonexistent';
  const sources: SkillSource[] = [];

  for (const candidate of options.additionalPaths ?? []) {
    sources.push({
      scope: 'custom',
      path: path.resolve(context.cwd, candidate),
      label: 'custom',
      required: true,
    });
  }

  sources.push({
    scope: 'project',
    path: path.join(context.cwd, '.texra', 'skills'),
    label: 'project',
  });

  if (options.includeInterop === true) {
    sources.push(...interopSkillSources(context.cwd, 'project'));
  }

  sources.push({
    scope: 'user',
    path: path.join(home, '.texra', 'skills'),
    label: 'user',
  });

  if (options.includeInterop === true) {
    sources.push(...interopSkillSources(home, 'user'));
  }

  sources.push(...bundledSkillSources(context.resourcesPath));

  return uniqueSources(sources);
}

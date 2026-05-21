import * as os from 'node:os';
import * as path from 'node:path';

// Local imports - skills
import {
  discoverSkillSources,
  type DiscoverSkillSourcesResult,
  type SkillLoadIssue,
  type SkillSource,
  type SourcedSkill,
} from '@skills/loadSkills';

// Local imports - CLI runtime
import type { CliContext } from './cliContext';

export interface CliSkillDiscoveryOptions {
  readonly includeInterop?: boolean;
  readonly additionalPaths?: readonly string[];
}

interface CliSkillRecord {
  readonly name: string;
  readonly description: string;
  readonly scope: SkillSource['scope'];
  readonly source: string;
  readonly path: string;
}

const INTEROP_SKILL_DIRS = ['.claude', '.codex', '.gemini'] as const;

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

export function cliSkillSources(
  context: Pick<CliContext, 'cwd' | 'resourcesPath'>,
  options: CliSkillDiscoveryOptions = {},
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

export function skillListRecord(entry: SourcedSkill): CliSkillRecord {
  return {
    name: entry.skill.name,
    description: entry.skill.description,
    scope: entry.source.scope,
    source: entry.source.path,
    path: entry.skill.path,
  };
}

export async function readCliSkills(
  context: Pick<CliContext, 'cwd' | 'resourcesPath'>,
  options: CliSkillDiscoveryOptions = {},
): Promise<DiscoverSkillSourcesResult> {
  return discoverSkillSources(cliSkillSources(context, options));
}

export function formatCliSkillIssue(issue: SkillLoadIssue): string {
  const location = issue.path ? ` (${issue.path})` : '';
  return `${issue.severity}: ${issue.message}${location}`;
}

export function formatCliSkillList(skills: readonly SourcedSkill[]): string {
  if (skills.length === 0) return 'No skills found.';
  return skills
    .map((entry) => {
      const record = skillListRecord(entry);
      return `${record.scope}\t${record.name}\t${record.description}`;
    })
    .join('\n');
}

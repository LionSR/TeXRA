import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

import {
  formatCliSkillList,
  readCliSkills as readCliSkillsEffect,
} from '@cli/runtime/skills';
import { defaultSkillSources } from '@skills/skillSources';
import {
  loadEnabledRuntimeSkills,
  readDisabledSkills,
  setRuntimeSkillSources,
  skillDisplayItem,
} from '@skills/runtimeSkills';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempRoots = useTempDirs();

/** The listing's own setting slots, carried as data by the caller. */
const settings = makeFakeSettingsStores().stores;
const commandMocks = vi.hoisted(() => ({ initCliPlatform: vi.fn() }));

vi.mock('@cli/runtime/initPlatform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/initPlatform')>()),
  initCliPlatform: commandMocks.initCliPlatform,
}));

const { runCli } = await import('@cli/commands/root');

async function writeSkill(
  root: string,
  dirName: string,
  description: string,
): Promise<void> {
  const skillDir = path.join(root, dirName);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${dirName}\ndescription: ${description}\n---\n\nUse ${dirName}.\n`,
  );
}

afterEach(() => {
  setRuntimeSkillSources([]);
  commandMocks.initCliPlatform.mockReset();
});

describe('CLI skills runtime', () => {
  it('deduplicates repeated source paths while preserving required custom roots', () => {
    const projectSkillsPath = path.resolve(
      path.sep,
      'tmp',
      'project',
      '.texra',
      'skills',
    );
    const sources = defaultSkillSources(
      {
        cwd: path.resolve(path.sep, 'tmp', 'project'),
        resourcesPath: path.resolve(path.sep, 'tmp', 'resources'),
      },
      {
        additionalPaths: ['.texra/skills'],
      },
    );

    expect(
      sources.filter((source) => source.path === projectSkillsPath),
    ).toEqual([
      expect.objectContaining({
        scope: 'custom',
        label: 'custom',
        required: true,
      }),
    ]);
  });

  it.effect('lists custom duplicate names before bundled skills', () =>
    Effect.gen(function* () {
      const resources = yield* Effect.promise(() =>
        makeTempDir('texra-cli-skills-', tempRoots),
      );
      const custom = yield* Effect.promise(() =>
        makeTempDir('texra-cli-skills-', tempRoots),
      );
      yield* Effect.promise(() => fs.mkdir(path.join(resources, 'skills')));
      yield* Effect.promise(() =>
        writeSkill(
          path.join(resources, 'skills'),
          'shared-skill',
          'The bundled skill.',
        ),
      );
      yield* Effect.promise(() =>
        writeSkill(custom, 'shared-skill', 'The custom skill.'),
      );
      yield* Effect.promise(() =>
        writeSkill(custom, 'custom-only', 'The custom-only skill.'),
      );

      const result = yield* readCliSkillsEffect(
        {
          cwd: resources,
          resourcesPath: resources,
        },
        settings,
        {
          additionalPaths: [custom],
        },
      );

      const disabled = yield* readDisabledSkills(settings);
      expect(
        result.skills.map((entry) => skillDisplayItem(entry, disabled)),
      ).toMatchObject([
        {
          name: 'custom-only',
          description: 'The custom-only skill.',
          scope: 'custom',
        },
        {
          name: 'shared-skill',
          description: 'The custom skill.',
          scope: 'custom',
        },
      ]);
      const formatted = formatCliSkillList(result.skills);
      expect(formatted).toContain('custom\tshared-skill\tThe custom skill.');
      expect(formatted).not.toContain(
        'bundled\tshared-skill\tThe bundled skill.',
      );
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          code: 'duplicate_name',
          name: 'shared-skill',
        }),
      );
    }),
  );

  it.effect('reports missing explicit custom skill sources', () =>
    Effect.gen(function* () {
      const result = yield* readCliSkillsEffect(
        {
          cwd: path.resolve(path.sep, 'tmp', 'project'),
          resourcesPath: path.resolve(path.sep, 'tmp', 'resources'),
        },
        settings,
        {
          additionalPaths: ['missing-skills'],
        },
      );

      expect(result.skills).toEqual([]);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          severity: 'error',
          code: 'missing_source',
          path: path.resolve(path.sep, 'tmp', 'project', 'missing-skills'),
        }),
      );
    }),
  );

  it.effect(
    'reports explicit custom skill sources that are not directories',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          makeTempDir('texra-cli-skills-', tempRoots),
        );
        const sourceFile = path.join(root, 'skills-file');
        yield* Effect.promise(() =>
          fs.writeFile(sourceFile, 'not a directory'),
        );

        const result = yield* readCliSkillsEffect(
          {
            cwd: root,
            resourcesPath: root,
          },
          settings,
          {
            additionalPaths: [sourceFile],
          },
        );

        expect(result.skills).toEqual([]);
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            severity: 'error',
            code: 'invalid_source',
            path: sourceFile,
          }),
        );
      }),
  );

  it.effect(
    'reads the runtime skill source registry used by prompt injection',
    () =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() =>
          makeTempDir('texra-cli-skills-', tempRoots),
        );
        yield* Effect.promise(() =>
          writeSkill(root, 'proof-audit', 'Review mathematical proof steps.'),
        );
        setRuntimeSkillSources([
          {
            scope: 'project',
            path: root,
            label: 'project',
          },
        ]);

        const result = yield* loadEnabledRuntimeSkills(root, settings);

        const disabled = yield* readDisabledSkills(settings);
        expect(
          result.skills.map((entry) => skillDisplayItem(entry, disabled)),
        ).toMatchObject([
          {
            name: 'proof-audit',
            description: 'Review mathematical proof steps.',
            scope: 'project',
            label: 'project',
          },
        ]);
        expect(result.errors).toEqual([]);
      }),
  );
});

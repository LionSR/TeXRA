import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect, vi } from 'vitest';

import { installPlugins, removePlugin } from '@cli/runtime/plugins';
import {
  formatCliSkillList,
  readCliSkills as readCliSkillsEffect,
} from '@cli/runtime/skills';
import { initializeNodeRuntimeSkills } from '@platform/defaults/nodeHost';
import { foldSkillSources, hostSkillContributions } from '@skills/skillSources';
import {
  loadEnabledRuntimeSkills,
  loadRuntimeSkillCatalog,
  readDisabledSkills,
  skillDisplayItem,
} from '@skills/runtimeSkills';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { installTestSkillRoots } from '@test/support/skillFixtures';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { TOOL_PLUGINS } from '@tools/plugins';

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
  installTestSkillRoots([]);
  commandMocks.initCliPlatform.mockReset();
});

it.layer(nodePlatformLayer)('CLI skills runtime', (it) => {
  it('deduplicates repeated source paths while preserving required custom roots, and rejects a repeated contribution id', () => {
    const projectSkillsPath = path.resolve(
      path.sep,
      'tmp',
      'project',
      '.texra',
      'skills',
    );
    const sources = foldSkillSources(hostSkillContributions([]), {
      cwd: path.resolve(path.sep, 'tmp', 'project'),
      home: path.resolve(path.sep, 'tmp', 'home'),
      resourcesPath: path.resolve(path.sep, 'tmp', 'resources'),
      options: { additionalPaths: ['.texra/skills'] },
      plugins: [],
    }).flatMap((tier) => tier.sources);

    expect(
      sources.filter((source) => source.path === projectSkillsPath),
    ).toEqual([
      expect.objectContaining({
        scope: 'custom',
        label: 'custom',
        required: true,
      }),
    ]);
    expect(() =>
      foldSkillSources(hostSkillContributions(['lean4', 'lean4']), {
        cwd: path.resolve(path.sep, 'tmp', 'project'),
        home: path.resolve(path.sep, 'tmp', 'home'),
        resourcesPath: path.resolve(path.sep, 'tmp', 'resources'),
        options: {},
        plugins: [],
      }),
    ).toThrow('Duplicate skill source contribution id: lean4');
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

      initializeNodeRuntimeSkills({ resourcesPath: resources }, []);
      const result = yield* readCliSkillsEffect(resources, settings, {
        additionalPaths: [custom],
      });

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
      initializeNodeRuntimeSkills(
        { resourcesPath: path.resolve(path.sep, 'tmp', 'resources') },
        [],
      );
      const result = yield* readCliSkillsEffect(
        path.resolve(path.sep, 'tmp', 'project'),
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

        initializeNodeRuntimeSkills({ resourcesPath: root }, []);
        const result = yield* readCliSkillsEffect(root, settings, {
          additionalPaths: [sourceFile],
        });

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
        installTestSkillRoots([{ tier: 'project', path: root }]);

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

  it.effect(
    'discovers tool plugin skills in the bundled tier, in name order with the core bundle',
    () =>
      Effect.gen(function* () {
        const resources = path.resolve(
          import.meta.dirname,
          '../../../packages/extension/resources',
        );
        const skillPluginIds = TOOL_PLUGINS.flatMap((plugin) =>
          plugin.skills === true ? [plugin.id] : [],
        );
        const pluginSkillDirs = (dir: string) =>
          Effect.promise(() =>
            fs.readdir(path.join(resources, dir), { withFileTypes: true }),
          ).pipe(
            Effect.map((entries) =>
              entries
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name),
            ),
          );
        // Both ways: a manifest `skills: true` has a skills root, and a
        // plugin skills root belongs to a manifest entry that claims it.
        const pluginRoots = yield* pluginSkillDirs('plugins');
        expect(pluginRoots.toSorted()).toEqual(skillPluginIds.toSorted());
        expect(skillPluginIds).toContain('lean4');

        const workspace = yield* Effect.promise(() =>
          makeTempDir('texra-cli-skills-', tempRoots),
        );
        initializeNodeRuntimeSkills(
          { resourcesPath: resources },
          skillPluginIds,
        );
        const result = yield* readCliSkillsEffect(workspace, settings, {});
        const bundled = result.skills.filter(
          (entry) => entry.source.scope === 'bundled',
        );
        const shipped = [
          ...(yield* pluginSkillDirs('skills')),
          ...(yield* Effect.forEach(skillPluginIds, (id) =>
            pluginSkillDirs(path.join('plugins', id, 'skills')),
          )).flat(),
        ].toSorted((a, b) => a.localeCompare(b));

        expect(bundled.map((entry) => entry.skill.name)).toEqual(shipped);
        expect(
          bundled.find((entry) => entry.skill.name === 'lean-search')?.source,
        ).toEqual({
          scope: 'bundled',
          label: 'bundled',
          path: path.join(resources, 'plugins', 'lean4', 'skills'),
        });
        expect(result.errors).toEqual([]);
      }),
  );

  it.effect(
    'installs a Claude Code plugin from a local directory into the user tier, and removes it',
    () =>
      Effect.gen(function* () {
        // Shaped like github.com/LionSR/AgenticPublicationProtocol: both
        // plugin manifests, a marketplace listing itself, skills/<name>/SKILL.md.
        const plugin = yield* Effect.promise(() =>
          makeTempDir('texra-cli-plugin-', tempRoots),
        );
        const resources = yield* Effect.promise(() =>
          makeTempDir('texra-cli-plugin-', tempRoots),
        );
        const manifest = {
          name: 'paper-protocol',
          description: 'Publish academic papers as AI agents',
          version: '1.0.0',
          author: { name: 'LionSR' },
        };
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(plugin, '.claude-plugin'));
          await fs.mkdir(path.join(plugin, '.codex-plugin'));
          await fs.writeFile(
            path.join(plugin, '.claude-plugin', 'plugin.json'),
            JSON.stringify(manifest),
          );
          await fs.writeFile(
            path.join(plugin, '.claude-plugin', 'marketplace.json'),
            JSON.stringify({
              name: 'paper-protocol',
              owner: { name: 'LionSR' },
              plugins: [{ name: 'paper-protocol', source: './' }],
            }),
          );
          await fs.writeFile(
            path.join(plugin, '.codex-plugin', 'plugin.json'),
            JSON.stringify({ ...manifest, skills: './skills/' }),
          );
          await writeSkill(
            path.join(plugin, 'skills'),
            'load-paper',
            'Load a published paper repository.',
          );
          await writeSkill(
            path.join(plugin, 'skills'),
            'publish-paper',
            'Publish a paper as an agent.',
          );
          await fs.mkdir(path.join(plugin, 'scripts'));
          // A bundled skill of the same name: the installed plugin wins.
          await writeSkill(
            path.join(resources, 'skills'),
            'load-paper',
            'The bundled copy.',
          );
        });
        const stores = makeFakeSettingsStores().stores;
        const env = { stores, pluginsDir: path.join(resources, 'plugins') };
        initializeNodeRuntimeSkills({ resourcesPath: resources }, []);

        const [installed] = yield* installPlugins(
          { kind: 'local', path: plugin },
          [],
          env,
        );
        expect(installed).toMatchObject({
          name: 'paper-protocol',
          path: yield* Effect.promise(() => fs.realpath(plugin)),
        });
        expect(installed?.commit).toBeUndefined();

        const catalog = yield* loadRuntimeSkillCatalog(resources, stores);
        const fromPlugin = catalog.skills.filter((skill) =>
          ['load-paper', 'publish-paper'].includes(skill.name),
        );
        expect(fromPlugin).toEqual([
          expect.objectContaining({ name: 'load-paper', source: 'user' }),
          expect.objectContaining({ name: 'publish-paper', source: 'user' }),
        ]);
        expect(catalog.catalog).toContain(
          '- load-paper: Load a published paper repository.\n  Source: plugin paper-protocol',
        );
        expect(catalog.catalog).not.toContain('The bundled copy.');

        yield* removePlugin('paper-protocol', env);
        const after = yield* loadRuntimeSkillCatalog(resources, stores);
        expect(after.catalog).not.toContain('plugin paper-protocol');
        expect(after.skills).toContainEqual(
          expect.objectContaining({ name: 'load-paper', source: 'bundled' }),
        );
        // A local plugin is referenced in place, so removing it keeps it.
        yield* Effect.promise(() =>
          fs.access(path.join(plugin, 'skills', 'load-paper', 'SKILL.md')),
        );
      }),
  );
});

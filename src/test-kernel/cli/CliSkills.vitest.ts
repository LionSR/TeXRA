import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import {
  formatCliSkillList,
  readCliSkills as readCliSkillsEffect,
} from '@cli/runtime/skills';
import { installPlugins, removePlugin } from '@common/plugins/installedPlugins';
import { pluginDataDir } from '@common/plugins/pluginHooks';
import {
  disablePlugin,
  enablePlugin,
  readInstalledPluginLoad,
} from '@common/plugins/pluginTrust';
import { initializeNodeRuntimeSkills } from '@platform/defaults/nodeHost';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { foldSkillSources, hostSkillContributions } from '@skills/skillSources';
import {
  loadRuntimeSkillCatalog,
  readDisabledSkills,
  skillDisplayItem,
} from '@skills/runtimeSkills';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { installTestSkillRoots } from '@test/support/skillFixtures';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { texraPlugins } from '@texra/tools/registry';

const tempRoots = useTempDirs();

/** The listing's own setting slots, carried as data by the caller. */
const settings = makeFakeSettingsStores('cli').stores;
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
    'discovers tool plugin skills in the bundled tier, in name order with the core bundle',
    () =>
      Effect.gen(function* () {
        const resources = path.resolve(
          import.meta.dirname,
          '../../../packages/extension/resources',
        );
        const pluginIds = texraPlugins().map(({ id }) => id);
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
        // Every plugin resources directory belongs to a listed plugin.
        const pluginRoots = yield* pluginSkillDirs('plugins');
        expect(pluginIds).toEqual(expect.arrayContaining(pluginRoots));
        expect(pluginRoots).toContain('lean4');

        const workspace = yield* Effect.promise(() =>
          makeTempDir('texra-cli-skills-', tempRoots),
        );
        initializeNodeRuntimeSkills({ resourcesPath: resources }, pluginIds);
        const result = yield* readCliSkillsEffect(workspace, settings, {});
        const bundled = result.skills.filter(
          (entry) => entry.source.scope === 'bundled',
        );
        const shipped = [
          ...(yield* pluginSkillDirs('skills')),
          ...(yield* Effect.forEach(pluginRoots, (id) =>
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
          plugin: 'lean4',
        });
        expect(result.errors).toEqual([]);

        // A switched-off plugin is one unit: its skills go with its tools.
        const { stores } = makeFakeSettingsStores('cli');
        yield* stores.globalState.update(GlobalStateKey.DISABLED_TOOLS, [
          'lean4',
        ]);
        const withLeanOff = yield* readCliSkillsEffect(workspace, stores, {});
        expect(
          withLeanOff.skills.some(
            (entry) => entry.skill.name === 'lean-search',
          ),
        ).toBe(false);
      }),
  );

  it.effect(
    'installs a Claude Code plugin from a local directory, loads its skills as <plugin>:<name> once trusted, and removes it',
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
          // A bundled skill of the same name: the plugin's is its own name.
          await writeSkill(
            path.join(resources, 'skills'),
            'load-paper',
            'The bundled copy.',
          );
        });
        const stores = makeFakeSettingsStores('cli').stores;
        // The run catalog over the installed plugins as they load now.
        const catalogNow = () =>
          Effect.flatMap(readInstalledPluginLoad(stores), (plugins) =>
            loadRuntimeSkillCatalog({
              workspacePath: resources,
              settings: stores,
              plugins,
            }),
          );
        const env = {
          globalState: stores.globalState,
          globalStorage: resources,
        };
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
        // Installed, it is disabled until the user trusts it.
        expect(JSON.stringify((yield* catalogNow()).catalog)).not.toContain(
          'plugin paper-protocol',
        );
        const asked: string[] = [];
        yield* enablePlugin('paper-protocol', env, (review) =>
          Effect.sync(() => {
            asked.push(`${review.name} ${review.version}`);
            return true;
          }),
        );
        expect(asked).toEqual(['paper-protocol 1.0.0']);

        const catalog = yield* catalogNow();
        const fromPlugin = catalog.catalog.filter((skill) =>
          skill.name.startsWith('paper-protocol:'),
        );
        // Tagged with the installed plugin, so a step that no longer loads
        // it lists none of them.
        expect(fromPlugin).toEqual([
          expect.objectContaining({
            name: 'paper-protocol:load-paper',
            plugin: 'plugin:paper-protocol',
          }),
          expect.objectContaining({
            name: 'paper-protocol:publish-paper',
            plugin: 'plugin:paper-protocol',
          }),
        ]);
        expect(JSON.stringify(catalog.catalog)).toContain(
          '- paper-protocol:load-paper: Load a published paper repository.\\n  Source: plugin paper-protocol',
        );
        expect(catalog.catalog).toContainEqual(
          expect.objectContaining({ name: 'load-paper', plugin: null }),
        );

        // Disabled, the plugin stays installed and contributes nothing.
        yield* disablePlugin('paper-protocol', env);
        const disabled = yield* catalogNow();
        expect(JSON.stringify(disabled.catalog)).not.toContain(
          'plugin paper-protocol',
        );
        expect(disabled.catalog).toContainEqual(
          expect.objectContaining({ name: 'load-paper', plugin: null }),
        );
        // The version it trusts is not asked about again.
        yield* enablePlugin('paper-protocol', env, () =>
          Effect.die('trust asked again'),
        );
        expect(JSON.stringify((yield* catalogNow()).catalog)).toContain(
          'plugin paper-protocol',
        );

        yield* removePlugin('paper-protocol', env);
        const after = yield* catalogNow();
        expect(JSON.stringify(after.catalog)).not.toContain(
          'plugin paper-protocol',
        );
        expect(after.catalog).toContainEqual(
          expect.objectContaining({ name: 'load-paper', plugin: null }),
        );
        // A local plugin is referenced in place, so removing it keeps it.
        yield* Effect.promise(() =>
          fs.access(path.join(plugin, 'skills', 'load-paper', 'SKILL.md')),
        );
        // A removal whose plugin-data delete failed is finished by removing
        // again, though the plugin directory is already gone.
        const orphan = pluginDataDir(env.globalStorage, 'paper-protocol');
        yield* Effect.promise(() => fs.mkdir(orphan, { recursive: true }));
        expect(yield* removePlugin('paper-protocol', env)).toMatchObject({
          leftover: true,
        });
        yield* Effect.promise(() =>
          expect(fs.access(orphan)).rejects.toThrow(),
        );
      }).pipe(Effect.provide(nodeSpawnerLayer)),
  );
});

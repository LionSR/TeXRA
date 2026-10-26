import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, expect } from 'vitest';

import { InstalledPlugins, Skills } from '@texra-ai/harness';
import { pluginDataDir } from '@common/plugins/pluginHooks';
import {
  disablePlugin,
  enablePlugin,
  readInstalledPluginLoad,
} from '@common/plugins/pluginTrust';
import { initializeNodeRuntimeSkills } from '@platform/defaults/nodeHost';
import { foldSkillSources, hostSkillContributions } from '@skills/skillSources';
import { loadRuntimeSkillCatalog } from '@skills/runtimeSkills';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { installTestSkillRoots } from '@test/support/skillFixtures';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import { nodeSpawnerLayer } from '@test/support/childProcessTestLayer';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempRoots = useTempDirs();

/** The listing's own setting slots, carried as data by the caller. */
const settings = makeFakeSettingsStores('cli').stores;
/** The roots of a listing for `workspace`, its user skills under no root. */
const rootsAt = (
  workspace: string,
  stores: typeof settings = settings,
): Parameters<typeof Skills.enabled>[0] => ({
  ...stores,
  workspace,
  storageRoot: path.join(workspace, 'no-storage-root'),
});
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
      storageRoot: path.resolve(path.sep, 'tmp', 'home', '.texra'),
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
        storageRoot: path.resolve(path.sep, 'tmp', 'home', '.texra'),
        resourcesPath: path.resolve(path.sep, 'tmp', 'resources'),
        options: {},
        plugins: [],
      }),
    ).toThrow('Duplicate skill source contribution id: lean4');
  });

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
              roots: rootsAt(resources, stores),
              plugins,
            }),
          );
        const env = {
          globalState: stores.globalState,
          globalStorage: resources,
        };
        initializeNodeRuntimeSkills({ resourcesPath: resources }, []);

        const [installed] = yield* InstalledPlugins.install(
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

        yield* InstalledPlugins.remove('paper-protocol', env);
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
        expect(
          yield* InstalledPlugins.remove('paper-protocol', env),
        ).toMatchObject({
          leftover: true,
        });
        yield* Effect.promise(() =>
          expect(fs.access(orphan)).rejects.toThrow(),
        );
      }).pipe(Effect.provide(nodeSpawnerLayer)),
  );
});

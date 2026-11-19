/**
 * The static reader of an installed plugin's programs. An installed plugin
 * is third-party code, so the failure modes below are the ways a file could
 * get a description or a tool list past the reader, or get itself run by it:
 *
 * 1. Bad syntax in the declarations: refused by file name, the others load.
 * 2. A missing field: no `description`, no `uses`, or neither.
 * 3. A wrong type: a value that is not a quoted literal (a number, a
 *    template, a concatenation, a call) would need evaluating to be read.
 * 4. An attempt to execute at import: code before the declarations refuses
 *    the file; code after them is never looked at and never run.
 * 5. A name that collides with a built-in program: an installed program is
 *    always `<plugin>:<name>`, and the plugin list refuses a module named
 *    with a colon, so the two sets cannot meet.
 * 6. A path that escapes the plugin directory: a linked file or a linked
 *    `programs` directory is refused unread.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { expect } from 'vitest';

import { readPluginPrograms } from '@common/plugins/pluginPrograms';
import { toolTable } from '@tools/toolTable';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

const tempRoots = useTempDirs();

const GOOD = `// A program.
export const description = 'Say hello.';
export const uses = ['read_file', "agent"];
export default async () => 'hello';
`;

/** A plugin directory holding `files` under `programs/`. */
const pluginWith = (files: Readonly<Record<string, string>>) =>
  Effect.promise(async () => {
    const dir = await makeTempDir('texra-plugin-programs-', tempRoots);
    await fs.mkdir(path.join(dir, 'programs'));
    for (const [name, text] of Object.entries(files))
      await fs.writeFile(path.join(dir, 'programs', name), text);
    return dir;
  });

it.layer(nodePlatformLayer)('an installed plugin’s programs', (it) => {
  it.effect('reads a description and tools from the text of the file', () =>
    Effect.gen(function* () {
      const dir = yield* pluginWith({ 'hello.js': GOOD, 'notes.md': 'x' });
      const read = yield* readPluginPrograms(dir, 'kit');
      expect(read).toEqual({
        loaded: [
          {
            name: 'kit:hello',
            file: path.join('programs', 'hello.js'),
            description: 'Say hello.',
            tools: ['read_file', 'agent'],
            source: GOOD,
          },
        ],
        refused: [],
      });
    }),
  );

  it.effect(
    'refuses a file whose declarations are malformed, missing or not literals, by name, and loads the rest',
    () =>
      Effect.gen(function* () {
        const refused = {
          // 1. Bad syntax.
          'unterminated.js': `export const description = 'no end;\nexport const uses = [];\n`,
          'no-equals.js': `export const description 'x';\nexport const uses = [];\n`,
          'open-array.js': `export const description = 'x';\nexport const uses = ['a',\n`,
          // 2. Missing fields.
          'no-tools.js': `export const description = 'x';\nexport default () => 1;\n`,
          'no-description.js': `export const uses = [];\nexport default () => 1;\n`,
          'empty.js': '',
          // `tools` would hide the sandbox's `tools` global in the module.
          'tools-not-uses.js': `export const description = 'x';\nexport const tools = [];\n`,
          'blank-description.js': `export const description = '  ';\nexport const uses = [];\n`,
          // 3. Wrong types.
          'number.js': `export const description = 42;\nexport const uses = [];\n`,
          'template.js':
            'export const description = `x`;\nexport const uses = [];\n',
          'concatenated.js': `export const description = 'a' + globalThis.secret;\nexport const uses = [];\n`,
          'tools-string.js': `export const description = 'x';\nexport const uses = 'bash';\n`,
          'tools-number.js': `export const description = 'x';\nexport const uses = [1];\n`,
          'tools-computed.js': `export const description = 'x';\nexport const uses = ['a'].concat(['bash']);\n`,
          'tools-continued.js': `export const description = 'x';\nexport const uses = ['a']\n  .concat(['bash']);\n`,
          'twice.js': `export const description = 'x';\nexport const description = 'y';\nexport const uses = [];\n`,
          // 4. Code before the declarations.
          'code-first.js': `globalThis.__pluginProgramRan = true;\n${GOOD}`,
          // The file name is the program's name.
          'Bad Name.js': GOOD,
        };
        const dir = yield* pluginWith({ ...refused, 'hello.js': GOOD });
        const read = yield* readPluginPrograms(dir, 'kit');
        expect(read.loaded.map(({ name }) => name)).toEqual(['kit:hello']);
        expect(read.refused).toHaveLength(Object.keys(refused).length);
        for (const name of Object.keys(refused))
          expect(
            read.refused.filter((line) =>
              line.startsWith(
                `Program ${path.join('programs', name)} of plugin kit is not loaded: `,
              ),
            ),
          ).toHaveLength(1);
      }),
  );

  it.effect('never runs a file: code after the declarations is not read', () =>
    Effect.gen(function* () {
      const source = `${GOOD}globalThis.__pluginProgramRan = true;\nthrow new Error('ran at import');\n`;
      const dir = yield* pluginWith({ 'hello.js': source });
      const read = yield* readPluginPrograms(dir, 'kit');
      expect(read.loaded.map(({ source: text }) => text)).toEqual([source]);
      expect('__pluginProgramRan' in globalThis).toBe(false);
    }),
  );

  it.effect(
    'names a program for its plugin, so none takes a built-in program’s name',
    () =>
      Effect.gen(function* () {
        const dir = yield* pluginWith({ 'edit.js': GOOD });
        const read = yield* readPluginPrograms(dir, 'kit');
        expect(read.loaded.map(({ name }) => name)).toEqual(['kit:edit']);
        expect(() =>
          toolTable([{ id: 'app', scriptModules: { 'kit:edit': GOOD } }]),
        ).toThrow(/script module kit:edit has a colon in its name/);
      }),
  );

  it.effect('follows no link out of the plugin directory', () =>
    Effect.gen(function* () {
      const outside = yield* pluginWith({ 'secret.js': GOOD });
      const dir = yield* pluginWith({ 'hello.js': GOOD });
      yield* Effect.promise(() =>
        fs.symlink(
          path.join(outside, 'programs', 'secret.js'),
          path.join(dir, 'programs', 'linked.js'),
        ),
      );
      const read = yield* readPluginPrograms(dir, 'kit');
      expect(read.loaded.map(({ name }) => name)).toEqual(['kit:hello']);
      expect(read.refused).toEqual([
        `Program ${path.join('programs', 'linked.js')} of plugin kit is not loaded: it is not a regular file inside the plugin (a link is not followed).`,
      ]);
      // The whole directory linked from elsewhere loads nothing.
      const linked = yield* Effect.promise(() =>
        makeTempDir('texra-plugin-programs-', tempRoots),
      );
      yield* Effect.promise(() =>
        fs.symlink(
          path.join(outside, 'programs'),
          path.join(linked, 'programs'),
        ),
      );
      expect(yield* readPluginPrograms(linked, 'kit')).toEqual({
        loaded: [],
        refused: [
          'Program programs of plugin kit is not loaded: it is not a directory inside the plugin (a link is not followed).',
        ],
      });
    }),
  );
});

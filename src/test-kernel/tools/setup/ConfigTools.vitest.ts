// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';

// Local imports
import { runWithWorkspaceRoots } from '@platform/workspaceRoots';
import { createFakeHost } from '@test/support/setupPlatform';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';

import { ReadConfigTool, UpdateConfigTool } from '@tools/setup/ConfigTools';

const readTool = new ReadConfigTool();
const updateTool = new UpdateConfigTool();

function createPlatform(initial: Record<string, unknown> = {}) {
  const project = createFakeHost({ config: initial });
  const layer = nativeToolTestLayer({
    inScope: (operation) => runWithWorkspaceRoots(project.roots, operation),
  });
  return { config: project.roots.config, layer };
}

describe('ConfigTools — read_config', () => {
  it.effect('rejects keys not starting with texra.', () =>
    Effect.gen(function* () {
      const { layer } = createPlatform();

      const result = yield* readTool
        .call({ key: 'editor.fontSize' })
        .pipe(Effect.provide(layer));

      assert.equal(result.status, 'error');
    }),
  );
});

describe('ConfigTools — update_config allowlist', () => {
  it.effect('writes an allowlisted key when the value matches its schema', () =>
    Effect.gen(function* () {
      const { config, layer } = createPlatform({
        'texra.bib.zoteroPort': 23119,
      });

      const result = yield* updateTool
        .call({
          key: 'texra.bib.zoteroPort',
          value: 23200,
          target: 'user',
        })
        .pipe(Effect.provide(layer));

      assert.equal(result.status, 'executed');
      assert.equal(config.get('texra.bib.zoteroPort'), 23200);
      assert.equal(config.inspect('texra.bib.zoteroPort')?.globalValue, 23200);
      // Output reports both before and after values for the educative summary.
      assert.match(result.output ?? '', /23119/);
      assert.match(result.output ?? '', /23200/);
    }),
  );

  it.effect.each([
    {
      case: 'a non-allowlisted key',
      key: 'texra.model.useGoogleInteractionsServerState',
      value: true,
    },
    {
      case: 'a type-mismatched value',
      key: 'texra.bib.zoteroPort',
      value: 'not a number',
    },
    // Port range is 1..65535
    { case: 'port 0', key: 'texra.bib.zoteroPort', value: 0 },
    { case: 'port -1', key: 'texra.bib.zoteroPort', value: -1 },
    { case: 'port 70000', key: 'texra.bib.zoteroPort', value: 70000 },
  ])('rejects $case without writing', ({ key, value }) =>
    Effect.gen(function* () {
      const { config, layer } = createPlatform();

      const result = yield* updateTool
        .call({ key, value, target: 'user' })
        .pipe(Effect.provide(layer));

      assert.equal(result.status, 'error');
      assert.equal(
        config.isExplicitlySet(key),
        false,
        'must not write rejected settings',
      );
    }),
  );
});

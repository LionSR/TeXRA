// Third-party imports
import * as assert from 'node:assert';
import { describe, it } from 'vitest';

// Node.js built-in imports

// Local imports - platform/test support/tools
import { createFakePlatform } from '@test/support/FakePlatform';
import { findExternalToolDef } from '@tools/externalToolDefs';

describe('external tool definitions', () => {
  it('keeps Zotero visible as a user-toggleable tool group', () => {
    const zotero = findExternalToolDef('zotero');

    assert.ok(zotero, 'Zotero tool definition should exist');
    assert.strictEqual(zotero.toggleable, true);
    assert.deepStrictEqual(zotero.tools, [
      'zotero_collections',
      'zotero_search',
      'zotero_add',
      'zotero_export',
    ]);
  });

  it('shows TeXRA CLI as a detected but inactive integration', () => {
    const texraCli = findExternalToolDef('texra-cli');

    assert.ok(texraCli, 'TeXRA CLI tool definition should exist');
    assert.strictEqual(texraCli.category, 'ai-agents');
    assert.strictEqual(texraCli.comingSoon, true);
    assert.strictEqual(texraCli.hideFromCli, true);
    assert.strictEqual(texraCli.toggleable, undefined);
    assert.deepStrictEqual(texraCli.tools, []);
    assert.ok(
      texraCli.installGuide?.includes('requires Node.js >=22.9.0'),
      'TeXRA CLI install guide should match the published Node engine range',
    );
  });

  it('detects the current TeXRA CLI process through the host checker', async () => {
    const texraCli = findExternalToolDef('texra-cli');
    assert.ok(texraCli, 'TeXRA CLI tool definition should exist');
    // Dynamic import: the no-platform-init-outside-composition-root lint rule
    // reserves static initPlatform imports for composition roots.
    const { initPlatform, tryPlatform } = await import('@platform/platform');
    const previousPlatform = tryPlatform();
    initPlatform(
      createFakePlatform(
        {},
        {
          toolAvailability: {
            isVscodeExtensionInstalled: () => false,
            isTexraCliEntrypoint: () => true,
          },
        },
      ),
    );

    try {
      const probeResult = await texraCli.probe?.();

      assert.strictEqual(probeResult, true);
      assert.strictEqual(await texraCli.check(probeResult), true);
      assert.strictEqual(
        await texraCli.statusLabel?.(probeResult),
        'Detected; integration coming soon',
      );
    } finally {
      initPlatform(previousPlatform ?? createFakePlatform());
    }
  });
});

// Node.js built-in imports
import * as assert from 'assert';

// Local imports - tools
import {
  findExternalToolDef,
  setTexraCliEntrypointChecker,
} from '@tools/externalToolDefs';

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
  });

  it('detects the current TeXRA CLI process through the host checker', async () => {
    const texraCli = findExternalToolDef('texra-cli');
    assert.ok(texraCli, 'TeXRA CLI tool definition should exist');
    setTexraCliEntrypointChecker(() => true);

    try {
      const probeResult = await texraCli.probe?.();

      assert.strictEqual(probeResult, true);
      assert.strictEqual(await texraCli.check(probeResult), true);
      assert.strictEqual(
        await texraCli.statusLabel?.(probeResult),
        'Detected; integration coming soon',
      );
    } finally {
      setTexraCliEntrypointChecker(() => false);
    }
  });
});

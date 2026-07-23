// Node.js built-in imports
import * as assert from 'node:assert';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform/test support/tools
import { installPlatform } from '@test/support/setupPlatform';
import { findExternalToolDef } from '@tools/externalToolDefs';
import { BinaryResolver } from '@utils/system/binaryResolver';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('keeps the workflow script tool as a user-toggleable, always-available group', async () => {
    const workflowScript = findExternalToolDef('workflow-script');

    assert.ok(workflowScript, 'Workflow script tool definition should exist');
    assert.strictEqual(workflowScript.toggleable, true);
    assert.deepStrictEqual(workflowScript.tools, ['delegate_workflow_script']);
    assert.strictEqual(await workflowScript.check(), true);
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
    await installPlatform(
      {},
      {
        toolAvailability: {
          isVscodeExtensionInstalled: () => false,
          isTexraCliEntrypoint: () => true,
        },
      },
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
      await installPlatform();
    }
  });

  it('detects Lean direct mode from the lake binary without running lake', async () => {
    const lean = findExternalToolDef('lean4');
    assert.ok(lean, 'Lean tool definition should exist');
    const findPath = vi
      .spyOn(BinaryResolver, 'findPath')
      .mockReturnValue('/usr/local/bin/lake');
    await installPlatform(
      {},
      {
        toolAvailability: {
          isVscodeExtensionInstalled: () => false,
          isTexraCliEntrypoint: () => false,
        },
      },
    );

    try {
      const probeResult = await lean.probe?.();

      expect(findPath).toHaveBeenCalledWith('lake');
      expect(probeResult).toEqual({
        extensionAvailable: false,
        lakeAvailable: true,
      });
      await expect(lean.check(probeResult)).resolves.toBe(true);

      findPath.mockReturnValue(null);
      const missingProbeResult = await lean.probe?.();

      expect(missingProbeResult).toEqual({
        extensionAvailable: false,
        lakeAvailable: false,
      });
      await expect(lean.check(missingProbeResult)).resolves.toBe(false);
    } finally {
      await installPlatform();
    }
  });
});

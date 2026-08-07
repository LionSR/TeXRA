// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform/test support/tools
import { installPlatform } from '@test/support/setupPlatform';
import { findExternalToolDef } from '@tools/externalToolDefs';
import { BinaryResolver } from '@utils/system/binaryResolver';

afterEach(() => {
  vi.restoreAllMocks();
});

function installToolAvailability(isTexraCliEntrypoint: boolean) {
  return installPlatform(
    {},
    {
      toolAvailability: {
        isVscodeExtensionInstalled: () => false,
        isTexraCliEntrypoint: () => isTexraCliEntrypoint,
      },
    },
  );
}

describe('external tool definitions', () => {
  it('keeps Zotero visible as a user-toggleable tool group', () => {
    const zotero = findExternalToolDef('zotero');
    if (!zotero) throw new Error('Zotero tool definition should exist');

    expect(zotero.toggleable).toBe(true);
    expect(zotero.tools).toEqual([
      'zotero_collections',
      'zotero_search',
      'zotero_add',
      'zotero_export',
    ]);
  });

  it('keeps the workflow script tool as a user-toggleable, always-available group', async () => {
    const workflowScript = findExternalToolDef('workflow-script');
    if (!workflowScript) {
      throw new Error('Workflow script tool definition should exist');
    }

    expect(workflowScript.toggleable).toBe(true);
    expect(workflowScript.tools).toEqual(['delegate_multi_agents']);
    expect(await workflowScript.check()).toBe(true);
  });

  it('shows TeXRA CLI as a detected but inactive integration', () => {
    const texraCli = findExternalToolDef('texra-cli');
    if (!texraCli) throw new Error('TeXRA CLI tool definition should exist');

    expect(texraCli.category).toBe('ai-agents');
    expect(texraCli.comingSoon).toBe(true);
    expect(texraCli.hideFromCli).toBe(true);
    expect(texraCli.toggleable).toBeUndefined();
    expect(texraCli.tools).toEqual([]);
    // The install guide must match the published Node engine range.
    expect(texraCli.installGuide).toContain('requires Node.js >=22.9.0');
  });

  it('detects the current TeXRA CLI process through the host checker', async () => {
    const texraCli = findExternalToolDef('texra-cli');
    if (!texraCli) throw new Error('TeXRA CLI tool definition should exist');
    await installToolAvailability(true);

    try {
      const probeResult = await texraCli.probe?.();

      expect(probeResult).toBe(true);
      expect(await texraCli.check(probeResult)).toBe(true);
      expect(await texraCli.statusLabel?.(probeResult)).toBe(
        'Detected; integration coming soon',
      );
    } finally {
      await installPlatform();
    }
  });

  it('detects Lean direct mode from the lake binary without running lake', async () => {
    const lean = findExternalToolDef('lean4');
    if (!lean) throw new Error('Lean tool definition should exist');
    const findPath = vi
      .spyOn(BinaryResolver, 'findPath')
      .mockReturnValue('/usr/local/bin/lake');
    await installToolAvailability(false);

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

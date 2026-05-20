// Third-party imports
import { afterEach, describe, expect, it } from 'vitest';

// Local imports - tools
import { findExternalToolDef } from '@tools/externalToolDefs';
import {
  clearLeanServerRegistry,
  registerLeanServer,
  updateLeanServer,
} from '@tools/lean/leanServerRegistry';

afterEach(() => {
  clearLeanServerRegistry();
});

describe('Lean external tool status', () => {
  it('counts only starting and running Lean servers as active', async () => {
    const lean = findExternalToolDef('lean4');
    expect(lean?.statusLabel).toBeDefined();

    registerLeanServer({
      id: 'direct:/failed',
      workspaceRoot: '/failed',
      mode: 'direct-lsp',
      status: 'error',
    });
    registerLeanServer({
      id: 'direct:/stopped',
      workspaceRoot: '/stopped',
      mode: 'direct-lsp',
      status: 'stopped',
    });

    await expect(
      lean!.statusLabel!({ extensionAvailable: false, lakeAvailable: true }),
    ).resolves.toBeUndefined();

    registerLeanServer({
      id: 'direct:/running',
      workspaceRoot: '/running',
      mode: 'direct-lsp',
      status: 'starting',
    });
    await expect(
      lean!.statusLabel!({ extensionAvailable: false, lakeAvailable: true }),
    ).resolves.toBe('1 server active');

    updateLeanServer('direct:/running', { status: 'running' });
    await expect(
      lean!.statusLabel!({ extensionAvailable: false, lakeAvailable: true }),
    ).resolves.toBe('1 server active');
  });
});

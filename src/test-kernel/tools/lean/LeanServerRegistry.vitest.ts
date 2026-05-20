/**
 * Vitests for the Lean server registry — covers register/update/list/
 * unregister plus the dashboard-facing `summarizeLeanServers` formatter.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  clearLeanServerRegistry,
  formatUptime,
  listLeanServers,
  registerLeanServer,
  subscribeLeanServers,
  summarizeLeanServers,
  unregisterLeanServer,
  updateLeanServer,
  type LeanServerInfo,
} from '@tools/lean/leanServerRegistry';

afterEach(() => {
  clearLeanServerRegistry();
});

describe('leanServerRegistry', () => {
  it('registers, updates, and unregisters servers', () => {
    registerLeanServer({
      id: 'direct:/work/proj',
      workspaceRoot: '/work/proj',
      mode: 'direct-lsp',
    });
    expect(listLeanServers().map((s) => s.id)).toEqual(['direct:/work/proj']);
    expect(listLeanServers()[0]?.status).toBe('starting');

    updateLeanServer('direct:/work/proj', { status: 'running', pid: 4242 });
    const after = listLeanServers()[0]!;
    expect(after.status).toBe('running');
    expect(after.pid).toBe(4242);

    unregisterLeanServer('direct:/work/proj');
    expect(listLeanServers()).toEqual([]);
  });

  it('clears errorMessage when transitioning out of error', () => {
    registerLeanServer({
      id: 'direct:/a',
      workspaceRoot: '/a',
      mode: 'direct-lsp',
      status: 'error',
    });
    updateLeanServer('direct:/a', {
      status: 'error',
      errorMessage: 'spawn failed',
    });
    expect(listLeanServers()[0]?.errorMessage).toBe('spawn failed');

    updateLeanServer('direct:/a', { status: 'running' });
    expect(listLeanServers()[0]?.errorMessage).toBeUndefined();
  });

  it('sorts the snapshot by workspace root', () => {
    registerLeanServer({ id: 'a', workspaceRoot: '/zeta', mode: 'direct-lsp' });
    registerLeanServer({
      id: 'b',
      workspaceRoot: '/alpha',
      mode: 'vscode-extension',
    });
    expect(listLeanServers().map((s) => s.workspaceRoot)).toEqual([
      '/alpha',
      '/zeta',
    ]);
  });

  it('notifies subscribers and stops once unsubscribed', () => {
    const seen: number[] = [];
    const unsubscribe = subscribeLeanServers((view) => seen.push(view.length));

    registerLeanServer({ id: 'a', workspaceRoot: '/a', mode: 'direct-lsp' });
    registerLeanServer({ id: 'b', workspaceRoot: '/b', mode: 'direct-lsp' });
    unsubscribe();
    registerLeanServer({ id: 'c', workspaceRoot: '/c', mode: 'direct-lsp' });

    expect(seen).toEqual([1, 2]);
  });

  it('does not call listeners when nothing matches an update id', () => {
    let calls = 0;
    subscribeLeanServers(() => {
      calls += 1;
    });
    updateLeanServer('does-not-exist', { status: 'running' });
    expect(calls).toBe(0);
  });
});

describe('formatUptime', () => {
  it.each([
    [0, '0s'],
    [1500, '1s'],
    [59_000, '59s'],
    [60_000, '1m 0s'],
    [185_000, '3m 5s'],
    [3_600_000, '1h 0m'],
    [3_660_000, '1h 1m'],
  ])('renders %i ms as %s', (ms, label) => {
    expect(formatUptime(ms)).toBe(label);
  });
});

describe('summarizeLeanServers', () => {
  const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

  function makeServer(partial: Partial<LeanServerInfo>): LeanServerInfo {
    return {
      id: 'direct:/work/proj',
      workspaceRoot: '/work/proj',
      mode: 'direct-lsp',
      status: 'running',
      startedAt: NOW - 65_000,
      ...partial,
    };
  }

  it('handles the empty case', () => {
    expect(summarizeLeanServers([], NOW)).toBe('No Lean servers active.');
  });

  it('renders a running server with uptime and toolchain', () => {
    const summary = summarizeLeanServers(
      [makeServer({ toolchain: 'leanprover/lean4:v4.12.0' })],
      NOW,
    );
    expect(summary).toBe(
      '1 Lean server active:\n' +
        '• /work/proj (direct LSP, leanprover/lean4:v4.12.0) — uptime 1m 5s',
    );
  });

  it('labels the VS Code mode as leanprover.lean4', () => {
    const summary = summarizeLeanServers(
      [makeServer({ mode: 'vscode-extension' })],
      NOW,
    );
    expect(summary).toContain('(leanprover.lean4)');
  });

  it('reports starting, error, and stopped states', () => {
    const summary = summarizeLeanServers(
      [
        makeServer({ id: 'a', workspaceRoot: '/a', status: 'starting' }),
        makeServer({
          id: 'b',
          workspaceRoot: '/b',
          status: 'error',
          errorMessage: 'spawn ENOENT',
        }),
        makeServer({ id: 'c', workspaceRoot: '/c', status: 'stopped' }),
      ],
      NOW,
    );
    expect(summary).toContain('/a (direct LSP) — starting…');
    expect(summary).toContain('/b (direct LSP) — error: spawn ENOENT');
    expect(summary).toContain('/c (direct LSP) — stopped');
    expect(summary.startsWith('3 Lean servers active:')).toBe(true);
  });
});

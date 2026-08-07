import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';
import type * as childProcess from 'node:child_process';

const spawnSyncMock =
  vi.fn<(...args: Parameters<typeof childProcess.spawnSync>) => unknown>();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: Parameters<typeof childProcess.spawnSync>) =>
    spawnSyncMock(...args),
}));

const { pageStdout, resolvePagerCommand } = await import('@cli/runtime/pager');

function lastSpawnCall(): [string, childProcess.SpawnSyncOptions] {
  return spawnSyncMock.mock.calls[0] as unknown as [
    string,
    childProcess.SpawnSyncOptions,
  ];
}

describe('resolvePagerCommand', () => {
  it('defaults to less -FIRX when $PAGER is unset', () => {
    expect(resolvePagerCommand({})).toBe('less -FIRX');
  });

  it('honors an explicit $PAGER', () => {
    expect(resolvePagerCommand({ PAGER: 'more' })).toBe('more');
    expect(resolvePagerCommand({ PAGER: '  less -R  ' })).toBe('less -R');
  });

  it('treats empty $PAGER or PAGER=cat as "no pager"', () => {
    expect(resolvePagerCommand({ PAGER: '' })).toBeUndefined();
    expect(resolvePagerCommand({ PAGER: '   ' })).toBeUndefined();
    expect(resolvePagerCommand({ PAGER: 'cat' })).toBeUndefined();
  });
});

describe('pageStdout', () => {
  let stdout = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
    stdoutSpy = spyOnStreamWrite(process.stdout, (chunk) => {
      stdout += chunk;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('is a strict no-op pager when stdout is not a TTY (headless parity)', () => {
    // The sacred rule: piped / non-TTY output must be byte-identical to a
    // direct write — never spawn a pager, never alter bytes.
    pageStdout('row1\nrow2', { stdoutIsTty: false });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(stdout).toBe('row1\nrow2\n');
  });

  it('is a strict no-op pager in headless mode even when stdout is a TTY', () => {
    pageStdout('row1\nrow2', { stdoutIsTty: true, headless: true });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(stdout).toBe('row1\nrow2\n');
  });

  it('defaults to non-TTY when stdoutIsTty is omitted', () => {
    pageStdout('row', {});
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(stdout).toBe('row\n');
  });

  it('pages through $PAGER only on an interactive TTY', () => {
    process.env.TEXRA_PAGER_TEST_ENV = 'inherited';
    try {
      pageStdout('row1\nrow2', {
        stdoutIsTty: true,
        env: { PAGER: 'less -R' },
      });
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      const [command, opts] = lastSpawnCall();
      expect(command).toBe('less -R');
      expect(opts.input).toBe('row1\nrow2\n');
      expect(opts.shell).toBe(true);
      expect(opts.env).toMatchObject({
        PAGER: 'less -R',
        TEXRA_PAGER_TEST_ENV: 'inherited',
      });
      // Paging writes through the child; nothing is written directly to stdout.
      expect(stdout).toBe('');
    } finally {
      delete process.env.TEXRA_PAGER_TEST_ENV;
    }
  });

  it('inherits the live environment when no explicit env override is passed', () => {
    const originalPager = process.env.PAGER;
    process.env.PAGER = 'less -R';
    try {
      pageStdout('row', { stdoutIsTty: true });
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      const [command, opts] = lastSpawnCall();
      expect(command).toBe('less -R');
      expect(opts.env).toBeUndefined();
      expect(stdout).toBe('');
    } finally {
      if (originalPager === undefined) delete process.env.PAGER;
      else process.env.PAGER = originalPager;
    }
  });

  it('writes directly (no pager) when $PAGER is disabled even on a TTY', () => {
    pageStdout('row', { stdoutIsTty: true, env: { PAGER: '' } });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(stdout).toBe('row\n');
  });

  it.each([
    {
      name: 'falls back to a direct write when the pager fails to launch',
      result: { error: new Error('spawn less ENOENT'), status: null },
      pager: 'less',
      expected: 'row\n',
    },
    {
      name: 'falls back to a direct write when the shell cannot exec the pager',
      result: { status: 127 },
      pager: 'missing-pager',
      expected: 'row\n',
    },
    {
      name: 'falls back to a direct write when the pager command is not executable',
      result: { status: 126 },
      pager: './not-exec',
      expected: 'row\n',
    },
    {
      name: 'does not duplicate output when a launched pager exits nonzero',
      result: { status: 1 },
      pager: 'less',
      expected: '',
    },
    {
      name: 'does not duplicate output when a launched pager is interrupted',
      result: { status: null, signal: 'SIGINT' },
      pager: 'less',
      expected: '',
    },
  ])('$name', ({ result, pager, expected }) => {
    spawnSyncMock.mockReturnValue(result);
    pageStdout('row', { stdoutIsTty: true, env: { PAGER: pager } });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(stdout).toBe(expected);
  });

  it('never pages empty text', () => {
    pageStdout('', { stdoutIsTty: true });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(stdout).toBe('');
  });
});

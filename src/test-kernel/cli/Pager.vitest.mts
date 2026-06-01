import type * as childProcess from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnSyncMock =
  vi.fn<(...args: Parameters<typeof childProcess.spawnSync>) => unknown>();

vi.mock('node:child_process', () => ({
  spawnSync: (...args: Parameters<typeof childProcess.spawnSync>) =>
    spawnSyncMock(...args),
}));

const { pageStdout, resolvePagerCommand } = await import('@cli/runtime/pager');

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
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown) => {
        stdout += String(chunk);
        return true;
      }) as unknown as ReturnType<typeof vi.spyOn>;
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

  it('defaults to non-TTY when stdoutIsTty is omitted', () => {
    pageStdout('row', {});
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(stdout).toBe('row\n');
  });

  it('pages through $PAGER only on an interactive TTY', () => {
    pageStdout('row1\nrow2', { stdoutIsTty: true, env: { PAGER: 'less -R' } });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    const [command, opts] = spawnSyncMock.mock.calls[0] as unknown as [
      string,
      childProcess.SpawnSyncOptions,
    ];
    expect(command).toBe('less -R');
    expect(opts.input).toBe('row1\nrow2\n');
    expect(opts.shell).toBe(true);
    // Paging writes through the child; nothing is written directly to stdout.
    expect(stdout).toBe('');
  });

  it('writes directly (no pager) when $PAGER is disabled even on a TTY', () => {
    pageStdout('row', { stdoutIsTty: true, env: { PAGER: '' } });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(stdout).toBe('row\n');
  });

  it('falls back to a direct write when the pager fails to launch', () => {
    spawnSyncMock.mockReturnValue({
      error: new Error('spawn less ENOENT'),
      status: null,
    });
    pageStdout('row', { stdoutIsTty: true, env: { PAGER: 'less' } });
    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(stdout).toBe('row\n');
  });

  it('never pages empty text', () => {
    pageStdout('', { stdoutIsTty: true });
    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(stdout).toBe('');
  });
});

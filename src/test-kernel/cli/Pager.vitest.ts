import { Cause, Effect, Exit, Stream } from 'effect';
import * as PlatformError from 'effect/PlatformError';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pageStdout, resolvePagerCommand } from '@cli/runtime/pager';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';

import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import type * as ChildProcess from 'effect/unstable/process/ChildProcess';

type Answer = ReturnType<Parameters<typeof scriptedSpawnerLayer>[0]>;

/** Page `text` on a scripted spawner that answers the pager with `answer`. */
async function page(
  text: string,
  options: Parameters<typeof pageStdout>[1],
  answer: Answer = { exitCode: 0 },
): Promise<ChildProcess.StandardCommand[]> {
  const spawner = scriptedSpawnerLayer(() => answer);
  await Effect.runPromise(
    pageStdout(text, options).pipe(Effect.provide(spawner.layer)),
  );
  return spawner.calls;
}

/** The text the pager was handed on its stdin. */
function stdinText(command: ChildProcess.StandardCommand): Promise<string> {
  const { stdin } = command.options;
  if (typeof stdin !== 'object' || !Stream.isStream(stdin)) {
    throw new Error('The pager was not handed its input on stdin.');
  }
  return Effect.runPromise(stdin.pipe(Stream.decodeText(), Stream.mkString));
}

const signalled = (method: string) =>
  PlatformError.systemError({
    _tag: 'Unknown',
    module: 'ChildProcess',
    method,
  });

describe('resolvePagerCommand', () => {
  it('treats empty $PAGER or PAGER=cat as "no pager"', () => {
    expect(resolvePagerCommand('')).toBeUndefined();
    expect(resolvePagerCommand('   ')).toBeUndefined();
    expect(resolvePagerCommand('cat')).toBeUndefined();
  });
});

describe('pageStdout', () => {
  let stdout = '';
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdout = '';
    stdoutSpy = spyOnStreamWrite(process.stdout, (chunk) => {
      stdout += chunk;
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
  });

  it('is a strict no-op pager when stdout is not a TTY (headless parity)', async () => {
    // The sacred rule: piped / non-TTY output must be byte-identical to a
    // direct write — never spawn a pager, never alter bytes.
    expect(await page('row1\nrow2', { stdoutIsTty: false })).toEqual([]);
    expect(stdout).toBe('row1\nrow2\n');
  });

  it('is a strict no-op pager in headless mode even when stdout is a TTY', async () => {
    expect(
      await page('row1\nrow2', { stdoutIsTty: true, headless: true }),
    ).toEqual([]);
    expect(stdout).toBe('row1\nrow2\n');
  });

  it('pages through $PAGER only on an interactive TTY', async () => {
    const calls = await page('row1\nrow2', {
      stdoutIsTty: true,
      pager: 'less -R',
    });
    expect(calls).toHaveLength(1);
    const [command] = calls;
    expect(command.command).toBe('less -R');
    expect(command.options).toMatchObject({
      shell: true,
      detached: false,
      stdout: 'inherit',
      stderr: 'inherit',
    });
    expect(await stdinText(command)).toBe('row1\nrow2\n');
    // Paging writes through the child; nothing is written directly to stdout.
    expect(stdout).toBe('');
  });

  it('reads the live $PAGER when no pager override is passed', async () => {
    const originalPager = process.env.PAGER;
    process.env.PAGER = 'less -R';
    try {
      const calls = await page('row', { stdoutIsTty: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('less -R');
      expect(calls[0].options.env).toBeUndefined();
      expect(stdout).toBe('');
    } finally {
      if (originalPager === undefined) delete process.env.PAGER;
      else process.env.PAGER = originalPager;
    }
  });

  it('writes directly (no pager) when $PAGER is disabled even on a TTY', async () => {
    expect(await page('row', { stdoutIsTty: true, pager: '' })).toEqual([]);
    expect(stdout).toBe('row\n');
  });

  it.each<{ name: string; answer: Answer; pager: string; expected: string }>([
    {
      name: 'falls back to a direct write when the pager fails to launch',
      answer: PlatformError.systemError({
        _tag: 'NotFound',
        module: 'ChildProcess',
        method: 'spawn',
      }),
      pager: 'less',
      expected: 'row\n',
    },
    {
      name: 'falls back to a direct write when the shell cannot exec the pager',
      answer: { exitCode: 127 },
      pager: 'missing-pager',
      expected: 'row\n',
    },
    {
      name: 'falls back to a direct write when the pager command is not executable',
      answer: { exitCode: 126 },
      pager: './not-exec',
      expected: 'row\n',
    },
    {
      name: 'does not duplicate output when a launched pager exits nonzero',
      answer: { exitCode: 1 },
      pager: 'less',
      expected: '',
    },
    {
      name: 'does not duplicate output when a launched pager is interrupted',
      answer: { exitCode: signalled('exitCode') },
      pager: 'less',
      expected: '',
    },
  ])('$name', async ({ answer, pager, expected }) => {
    const calls = await page('row', { stdoutIsTty: true, pager }, answer);
    expect(calls).toHaveLength(1);
    expect(stdout).toBe(expected);
  });

  it('never pages empty text', async () => {
    expect(await page('', { stdoutIsTty: true })).toEqual([]);
    expect(stdout).toBe('');
  });

  describe('Ctrl-C while the pager owns the terminal', () => {
    /** Page on a TTY, pressing Ctrl-C while the pager runs; the pager then
     *  answers `answer`. Returns how the paging program ended. */
    async function pageWithCtrlC(answer: Answer): Promise<Exit.Exit<void>> {
      const listeners: Array<() => void> = [];
      const on = vi.spyOn(process, 'on');
      on.mockImplementation(((event: string | symbol, listener: () => void) => {
        if (event === 'SIGINT') listeners.push(listener);
        return process;
      }) as typeof process.on);
      const spawner = scriptedSpawnerLayer(() => {
        for (const listener of listeners) listener();
        return answer;
      });
      const exit = await Effect.runPromiseExit(
        pageStdout('long listing', { stdoutIsTty: true, pager: 'less' }).pipe(
          Effect.provide(spawner.layer),
        ),
      );
      expect(listeners).toHaveLength(1);
      return exit;
    }

    it('keeps the CLI running when the pager handles Ctrl-C itself', async () => {
      // `less` cancels a search on Ctrl-C and exits normally when quit.
      expect(Exit.isSuccess(await pageWithCtrlC({ exitCode: 0 }))).toBe(true);
    });

    it('interrupts the command when the pager died of the Ctrl-C', async () => {
      // The command boundary maps an interruption to exit 130.
      const exit = await pageWithCtrlC({ exitCode: signalled('exitCode') });
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(
        true,
      );
    });
  });
});

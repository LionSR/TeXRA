import { Effect } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { pageStdout } from '@cli/runtime/pager';
import { spyOnStreamWrite } from '@test/cli/fixtures/streamWriteSpy';

import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import type * as ChildProcess from 'effect/process/ChildProcess';

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
});

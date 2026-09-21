// The guidance gate is a script with no importable surface, so it is pinned
// the way the other script suites pin theirs: run it against a fixture root,
// which is the argument the script takes for exactly this purpose. The run
// vocabulary is always read from the real checkout, so the fixtures cite real
// rows.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const scriptPath = resolve(repoRoot, 'scripts/check-guidance-refs.mjs');
const fixtureRoot = resolve(
  repoRoot,
  'src/test-kernel/scripts/fixtures/guidance-refs',
);

function runGate(fixture: string): { status: number; output: string } {
  const result = spawnSync(
    process.execPath,
    [scriptPath, resolve(fixtureRoot, fixture)],
    {
      encoding: 'utf8',
    },
  );
  return {
    status: result.status ?? -1,
    output: `${result.stdout}${result.stderr}`,
  };
}

describe('check-guidance-refs', () => {
  // `run.ts` parses as the `run` namespace plus a second segment, so without
  // the extension filter the gate reports a file as an unknown event type.
  it('accepts resolvable paths, real rows, and a filename whose stem is a namespace', () => {
    expect(runGate('valid')).toMatchObject({ status: 0 });
  });

  it('fails on a dead path and on a row the vocabulary does not declare', () => {
    const { status, output } = runGate('broken');

    expect(status).toBe(1);
    expect(output).toContain('run.neverWasARow');
    expect(output).toContain('missing.md');
  });
});

// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import {
  buildCodexCommandToolLog,
  buildCodexFileChangeToolLog,
} from '@texra/tools/codexShared';

describe('buildCodexFileChangeToolLog', () => {
  it('deduplicates repeated file-change entries', () => {
    const log = buildCodexFileChangeToolLog({
      changes: [
        { kind: 'update', path: '/tmp/workspace/src/App.ts' },
        { kind: 'update', path: '/tmp/workspace/src/App.ts' },
        { kind: 'add', path: '/tmp/workspace/src/New.ts' },
      ],
      status: 'completed',
    });

    assert.deepEqual(log?.input, {
      changes: [
        { kind: 'update', path: '/tmp/workspace/src/App.ts' },
        { kind: 'add', path: '/tmp/workspace/src/New.ts' },
      ],
      patchStatus: 'completed',
    });
  });
});

describe('buildCodexCommandToolLog', () => {
  it('marks failed commands as errors and falls back to exit info when empty', () => {
    const log = buildCodexCommandToolLog({
      command:
        'lake env lean MPS/ParentHamiltonian/UniqueGroundState.lean --very-long-flag value',
      aggregated_output: '',
      exit_code: 1,
      status: 'failed',
    });

    assert.deepEqual(log, {
      toolName: 'bash',
      summary: 'lake env lean MPS/ParentHamiltonian/UniqueGroundState.lean …',
      input: {
        command:
          'lake env lean MPS/ParentHamiltonian/UniqueGroundState.lean --very-long-flag value',
      },
      output: '(exit 1)',
      exitCode: 1,
      error: 'Command failed (exit 1)',
      status: 'failed',
    });
  });

  it('keeps failed SDK status as error even when exit code is zero', () => {
    const log = buildCodexCommandToolLog({
      command: 'lake build',
      aggregated_output: 'sandbox denied',
      exit_code: 0,
      status: 'failed',
    });

    assert.deepEqual(log, {
      toolName: 'bash',
      summary: 'lake build',
      input: { command: 'lake build' },
      output: 'sandbox denied',
      exitCode: 0,
      error: 'Command failed (exit 0)',
      status: 'failed',
    });
  });
});

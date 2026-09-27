// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import { CODEX_FILE_CHANGE_TOOL } from '@shared/schemas';
import { toCodexCliReasoningEffort } from '@tools/codexConfig';
import {
  buildCodexCommandToolLog,
  buildCodexFileChangeToolLog,
} from '@tools/codexShared';

describe('toCodexCliReasoningEffort', () => {
  it("caps 'xhigh' to 'high' so the Codex CLI config deserializer accepts it", () => {
    // Regression: the Codex CLI's Rust-side config deserializer rejects
    // 'xhigh' with `unknown variant 'xhigh', expected one of 'minimal',
    // 'low', 'medium', 'high' in 'model_reasoning_effort'`.
    assert.equal(toCodexCliReasoningEffort('xhigh'), 'high');
  });
});

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

  it('surfaces failed patches as native errors', () => {
    const log = buildCodexFileChangeToolLog({
      changes: [{ kind: 'update', path: '/tmp/workspace/src/App.ts' }],
      status: 'failed',
    });

    assert.deepEqual(log, {
      toolName: CODEX_FILE_CHANGE_TOOL,
      summary: 'failed update App.ts',
      input: {
        changes: [{ kind: 'update', path: '/tmp/workspace/src/App.ts' }],
        patchStatus: 'failed',
      },
      error: 'Patch apply failed',
      status: 'failed',
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

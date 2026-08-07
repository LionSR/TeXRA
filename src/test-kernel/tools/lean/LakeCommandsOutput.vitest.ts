/**
 * Mocked execa-result normalization for states that are impractical to produce
 * at small scale, especially `failed: true` + `isMaxBuffer: true` + exit 0.
 * Kept separate from LeanTools.vitest.ts because this file's hoisted module
 * mock would contaminate that suite's real Node subprocess integration tests.
 */

// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock('execa', () => ({ execa: mocks.execa }));

// Local imports
import { runLakeCommand } from '@tools/lean/direct/lakeCommands';

describe('runLakeCommand output failures', () => {
  const LAKE_BUILD = {
    workspaceRoot: '/workspace',
    lakeCommand: 'lake',
    args: ['build'],
  };

  beforeEach(() => {
    mocks.execa.mockReset();
  });

  it('keeps stderr empty for ordinary nonzero exits with stdout only', async () => {
    mocks.execa.mockResolvedValue({
      failed: true,
      isMaxBuffer: false,
      timedOut: false,
      exitCode: 7,
      stdout: 'build failed in target A',
      stderr: '',
      shortMessage: 'Command failed with exit code 7',
    });

    const result = await runLakeCommand(LAKE_BUILD);

    expect(result).toEqual({
      exitCode: 7,
      stdout: 'build failed in target A',
      stderr: '',
    });
  });

  it('does not report maxBuffer overflow with partial stdout as success', async () => {
    mocks.execa.mockResolvedValue({
      failed: true,
      isMaxBuffer: true,
      exitCode: 0,
      stdout: 'partial build output',
      stderr: '',
      shortMessage: 'Command failed: stdout maxBuffer exceeded',
    });

    const result = await runLakeCommand(LAKE_BUILD);

    expect(result).toEqual({
      exitCode: -1,
      stdout: 'partial build output',
      stderr: 'Command failed: stdout maxBuffer exceeded',
    });
  });
});

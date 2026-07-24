// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execa: vi.fn() }));

vi.mock('execa', () => ({ execa: mocks.execa }));

// Local imports
import { runLakeCommand } from '@tools/lean/direct/lakeCommands';

describe('runLakeCommand output failures', () => {
  beforeEach(() => {
    mocks.execa.mockReset();
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

    const result = await runLakeCommand({
      workspaceRoot: '/workspace',
      lakeCommand: 'lake',
      args: ['build'],
    });

    expect(result).toEqual({
      exitCode: -1,
      stdout: 'partial build output',
      stderr: 'Command failed: stdout maxBuffer exceeded',
    });
  });
});

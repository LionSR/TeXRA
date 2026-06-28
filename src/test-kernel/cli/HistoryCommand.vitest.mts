import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliOutputFormat } from '@cli/schemas/cliSettings';

const mocks = vi.hoisted(() => ({
  contextFromArgs: vi.fn(),
  deleteCliHistory: vi.fn(),
  emitCliResult: vi.fn(),
  initLocalCliPlatform: vi.fn(),
  setExitCode: vi.fn(),
  writeErrorStderr: vi.fn(),
  writeTextStderr: vi.fn(),
}));

vi.mock('@cli/commands/_helpers/context', () => ({
  contextFromArgs: mocks.contextFromArgs,
}));

vi.mock('@cli/commands/_helpers/exitCode', () => ({
  setExitCode: mocks.setExitCode,
}));

vi.mock('@cli/commands/_helpers/output', () => ({
  emitCliResult: mocks.emitCliResult,
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initLocalCliPlatform: mocks.initLocalCliPlatform,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeErrorStderr: mocks.writeErrorStderr,
  writeTextStderr: mocks.writeTextStderr,
}));

vi.mock('@cli/runtime/history', () => ({
  cliHistoryNdjsonRecords: vi.fn(() => []),
  deleteCliHistory: mocks.deleteCliHistory,
  formatCliHistoryDetailsText: vi.fn(() => ''),
  formatCliHistoryNotFoundText: vi.fn(() => 'not found'),
  formatCliHistoryText: vi.fn(() => ''),
  listCliHistoryEntries: vi.fn(async () => []),
  parseCliHistoryId: vi.fn((id: string | undefined) => id),
  preflightCliHistoryDeleteAll: vi.fn(async () => ({
    proceed: true,
    count: 0,
  })),
  readCliHistoryDetails: vi.fn(async () => null),
}));

function cliContext(outputFormat: CliOutputFormat): CliContext {
  return {
    cwd: '/tmp/project',
    mode: 'headless',
    outputFormat,
    approvalPolicy: 'never',
    quietLogs: false,
    renderRunProgress: true,
    stderrIsTty: false,
    stdoutColorEnabled: false,
    stderrColorEnabled: false,
    colorEnabled: false,
    version: '0.0.0',
    resourcesPath: '/tmp/resources',
  };
}

describe('CLI history command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(['json', 'ndjson'] as const)(
    'returns usage for a running delete in %s while emitting the structured result',
    async (outputFormat) => {
      const result = {
        deleted: 'one' as const,
        id: 'abc123',
        found: true,
        blockedReason: 'running' as const,
      };
      mocks.contextFromArgs.mockResolvedValue(cliContext(outputFormat));
      mocks.deleteCliHistory.mockResolvedValue(result);
      const { historyCommand } = await import('@cli/commands/history');
      const subCommands = historyCommand.subCommands as Record<
        string,
        { run?: (ctx: unknown) => Promise<void> }
      >;
      const deleteCommand = subCommands.delete;

      await deleteCommand?.run?.({
        args: {
          id: 'abc123',
          all: false,
          yes: false,
          outputFormat,
        },
        rawArgs: [
          'history',
          'delete',
          'abc123',
          '--output-format',
          outputFormat,
        ],
      } as never);

      expect(mocks.emitCliResult).toHaveBeenCalledWith(
        expect.objectContaining({ outputFormat }),
        {
          json: result,
          ndjson: { kind: 'history-delete', result },
          text: '',
        },
      );
      expect(mocks.setExitCode).toHaveBeenCalledWith(CliExitCode.Usage);
      expect(mocks.writeTextStderr).not.toHaveBeenCalled();
    },
  );
});

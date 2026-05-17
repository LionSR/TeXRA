import { describe, expect, it } from 'vitest';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

async function loadSetupTerminalMessages(): Promise<
  typeof import('../../../packages/desktop/src/desktopSetupTerminalMessages')
> {
  return (await import(
    moduleFileUrl(desktopSourcePath('desktopSetupTerminalMessages.ts'))
  )) as typeof import('../../../packages/desktop/src/desktopSetupTerminalMessages');
}

describe('desktop setup terminal messages', () => {
  it('round-trips show, append, complete, and cancel messages', async () => {
    const {
      DesktopSetupTerminalShowMessageSchema,
      DesktopSetupTerminalAppendMessageSchema,
      DesktopSetupTerminalCompleteMessageSchema,
      DesktopSetupTerminalCancelMessageSchema,
      buildDesktopSetupTerminalShowMessage,
      buildDesktopSetupTerminalAppendMessage,
      buildDesktopSetupTerminalCompleteMessage,
      buildDesktopSetupTerminalCancelMessage,
    } = await loadSetupTerminalMessages();

    expect(
      DesktopSetupTerminalShowMessageSchema.parse(
        buildDesktopSetupTerminalShowMessage({
          runId: 'run-1',
          title: 'TeXRA Setup',
          shellCommand: 'latexmk --version',
          cwd: '/tmp/workspace',
        }),
      ),
    ).toMatchObject({ command: 'desktop:setupTerminalShow' });

    expect(
      DesktopSetupTerminalAppendMessageSchema.parse(
        buildDesktopSetupTerminalAppendMessage({
          runId: 'run-1',
          stream: 'stderr',
          chunk: 'Installing',
        }),
      ),
    ).toMatchObject({ command: 'desktop:setupTerminalAppend' });

    expect(
      DesktopSetupTerminalCompleteMessageSchema.parse(
        buildDesktopSetupTerminalCompleteMessage({
          runId: 'run-1',
          status: 'succeeded',
          exitCode: 0,
          output: 'Done',
        }),
      ),
    ).toMatchObject({ command: 'desktop:setupTerminalComplete' });

    expect(
      DesktopSetupTerminalCancelMessageSchema.parse(
        buildDesktopSetupTerminalCancelMessage('run-1'),
      ),
    ).toMatchObject({ command: 'desktop:setupTerminalCancel' });
  });

  it('rejects running as a completion status', async () => {
    const { DesktopSetupTerminalCompleteMessageSchema } =
      await loadSetupTerminalMessages();
    const result = DesktopSetupTerminalCompleteMessageSchema.safeParse({
      command: 'desktop:setupTerminalComplete',
      runId: 'run-1',
      status: 'running',
      exitCode: 0,
      output: '',
    });

    expect(result.success).toBe(false);
  });
});

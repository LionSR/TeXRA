import '@test/support/defaultSessionTestSetup';

import { it } from '@effect/vitest';
// Test composition imports

// Third-party imports
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';
import { defaultSession } from '@agent/runtime/SessionHandle';

// Local imports
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import { formatToolResultTextWithAttachments } from '@agent/runtime/run/toolResultText';
import type { RunId } from '@shared/schemas';
import { BASH_APPROVAL_CONFIG_KEY, type ToolResult } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { BashTool } from '@tools/bash';
import { requestBashApproval } from '@tools/approval/bashApproval';
import * as execUtils from '@utils/system/execUtils';
import * as agentConfig from '@utils/config/configUtils';

vi.mock('@tools/approval/bashApproval', async (importActual) => {
  const actual =
    await importActual<typeof import('@tools/approval/bashApproval')>();
  return {
    ...actual,
    // Default to auto-accept so tests unrelated to approval behavior (which
    // stub bash approval off via config) keep working; individual tests
    // override with mockResolvedValueOnce for the approval outcome they need.
    requestBashApproval: vi.fn(actual.requestBashApproval),
  };
});

function stubBashApprovalDisabled(): void {
  vi.spyOn(agentConfig, 'getConfig').mockImplementation(
    <T>(key: string, defaultValue?: T): T =>
      key === BASH_APPROVAL_CONFIG_KEY ? (false as T) : (defaultValue as T),
  );
  vi.spyOn(agentConfig, 'readConfig').mockImplementation(
    <T>(_config: unknown, key: string, defaultValue?: T): T =>
      key === BASH_APPROVAL_CONFIG_KEY ? (false as T) : (defaultValue as T),
  );
}

/** Lower a tool result the way a settled call reaches the model, and return
 * the model-visible text. */
function toolUseOutput(result: ToolResult): string {
  const { attachments, sanitizedResult } = extractToolAttachments(result);
  return formatToolResultTextWithAttachments(
    sanitizedResult,
    attachments,
    true,
  );
}

describe('BashTool error feedback', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect(
    'returns foreground command failures in the model tool-result payload',
    () =>
      Effect.gen(function* () {
        stubBashApprovalDisabled();
        vi.spyOn(execUtils, 'executeCommand').mockResolvedValueOnce({
          success: false,
          stdout: 'stdout failure guidance',
          stderr: 'stderr failure details',
          timedOut: false,
          exitCode: 2,
        });

        const result = yield* new BashTool().call({ command: 'echo long' });
        expect(result.status).toBe('error');
        expect(result.error).toContain('Command failed');
        expect(result.error).toContain('stderr failure details');
        expect(result.error).toContain('stdout failure guidance');

        const output = toolUseOutput(result);

        expect(output).toContain('Command failed');
        expect(output).toContain('stderr failure details');
        expect(output).toContain('stdout failure guidance');
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.effect.each([
    {
      name: 'spawn failure',
      stderr: 'spawn missing-command ENOENT',
      exitCode: 127,
    },
    {
      name: 'cancellation',
      stderr: 'Command aborted by user',
      exitCode: 130,
    },
  ])(
    'preserves $name fallback diagnostics without stream chunks',
    ({ stderr, exitCode }) =>
      Effect.gen(function* () {
        stubBashApprovalDisabled();
        vi.spyOn(execUtils, 'executeCommand').mockResolvedValueOnce({
          success: false,
          stdout: '',
          stderr,
          timedOut: false,
          exitCode,
        });

        const result = yield* new BashTool().call({
          command: 'missing-command',
        });
        expect(result.status).toBe('error');
        expect(result.error).toContain(stderr);
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.effect('rejects shell-level backgrounding before command run', () =>
    Effect.gen(function* () {
      stubBashApprovalDisabled();
      const executeSpy = vi.spyOn(execUtils, 'executeCommand');

      const result = yield* new BashTool().call({
        command:
          'nohup python verify_residual_order.py > verify_residual_order_run.log 2>&1 &\necho "PID: $!"',
      });

      expect(result.status).toBe('error');
      expect(result.error).toContain('shell-level backgrounding');
      expect(result.error).toContain('run_in_background: true');
      expect(executeSpy).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.effect('does not reject ampersands in later shell command segments', () =>
    Effect.gen(function* () {
      stubBashApprovalDisabled();
      const executeSpy = vi
        .spyOn(execUtils, 'executeCommand')
        .mockResolvedValue({
          success: true,
          stdout: 'done',
          stderr: '',
          timedOut: false,
          exitCode: 0,
        });

      const result = yield* new BashTool().call({
        command: 'nohup longtask; echo done &',
      });

      expect(result.status).toBe('executed');
      expect(executeSpy).toHaveBeenCalledOnce();
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.effect('reports an explicit approval rejection to the agent', () =>
    Effect.gen(function* () {
      vi.mocked(requestBashApproval).mockReturnValueOnce(
        Effect.succeed({ action: 'reject', feedback: 'No thanks.' }),
      );
      const rejected = yield* new BashTool().call({ command: 'echo rejected' });
      expect(rejected.status).toBe('error');
      expect(rejected.error).toContain('User rejected command');
      expect(rejected.userInstruction).toBe('No thanks.');
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.effect(
    'does not present generated rejection guidance as user feedback',
    () =>
      Effect.gen(function* () {
        vi.mocked(requestBashApproval).mockReturnValueOnce(
          Effect.succeed({ action: 'reject' }),
        );
        const rejected = yield* new BashTool().call({
          command: 'echo rejected',
        });

        expect(rejected.status).toBe('error');
        expect(rejected.error).toContain('Do not retry');
        expect(rejected.userInstruction).toBeUndefined();

        const output = toolUseOutput(rejected);

        expect(output).toContain('Do not retry');
        expect(output).not.toContain('User feedback:');
      }).pipe(
        Effect.provide(
          nativeToolTestLayer({
            run: {
              session: defaultSession(),
              runId: 'bash-tool' as RunId,
              toolPolicy: {},
            },
          }),
        ),
      ),
  );

  it.effect('does not present an approval-policy denial as user feedback', () =>
    Effect.gen(function* () {
      vi.mocked(requestBashApproval).mockReturnValueOnce(
        Effect.succeed({
          action: 'deny',
          reason: 'Denied by TeXRA approval policy.',
        }),
      );
      const rejected = yield* new BashTool().call({ command: 'echo rejected' });

      expect(rejected.status).toBe('error');
      expect(rejected.error).toContain('Command denied');
      expect(rejected.error).toContain('Denied by TeXRA approval policy.');
      expect(rejected.error).not.toContain('User rejected command');
      expect(rejected.userInstruction).toBeUndefined();

      const output = toolUseOutput(rejected);

      expect(output).toContain('Denied by TeXRA approval policy.');
      expect(output).not.toContain('User feedback:');
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.effect('preserves policy-denial provenance when its reason is blank', () =>
    Effect.gen(function* () {
      vi.mocked(requestBashApproval).mockReturnValueOnce(
        Effect.succeed({ action: 'deny', reason: '   ' }),
      );
      const rejected = yield* new BashTool().call({ command: 'echo rejected' });

      expect(rejected.error).toContain('Command denied');
      expect(rejected.error).not.toContain('User rejected command');
      expect(rejected.error).not.toContain('Do not retry');
      expect(rejected.userInstruction).toBeUndefined();
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );

  it.effect('does not present an automatic cancellation as user feedback', () =>
    Effect.gen(function* () {
      vi.mocked(requestBashApproval).mockReturnValueOnce(
        Effect.succeed({ action: 'cancel', cause: 'Session disposed.' }),
      );
      const rejected = yield* new BashTool().call({ command: 'echo rejected' });

      expect(rejected.error).toContain('Command cancelled');
      expect(rejected.error).toContain('Session disposed.');
      expect(rejected.error).not.toContain('User rejected command');
      expect(rejected.userInstruction).toBeUndefined();
    }).pipe(
      Effect.provide(
        nativeToolTestLayer({
          run: {
            session: defaultSession(),
            runId: 'bash-tool' as RunId,
            toolPolicy: {},
          },
        }),
      ),
    ),
  );
});

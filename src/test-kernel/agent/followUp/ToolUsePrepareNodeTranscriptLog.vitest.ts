import { describe, expect, it, vi } from 'vitest';

import { buildInitialToolUsePrompts } from '@agent/prompt/PromptBuilder';
import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentPromptSchema } from '@agent/core/definition/AgentDataclass';
import { ToolUsePrepareNode } from '@agent/implementations/flows/tooluse/nodes/ToolUsePrepareNode';
import type { ToolUseServices } from '@agent/implementations/flows/tooluse/ToolUseServices';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { createToolUseResumeShared } from '@test/support/toolUseResumeTestUtils';
import { testModelCell } from '../modelCellTestUtils';
import { testRunScope } from '../progressTestUtils';

function buildServices(
  overrides: Partial<ToolUseServices<unknown>> = {},
): ToolUseServices<unknown> {
  return {
    config: AgentConfigSchema.parse({ agent: 'chat', model: 'deepseekT' }),
    runScope: testRunScope('test-stream'),
    fileService: {} as never,
    isSubagent: false,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    modelCell: testModelCell({
      consumeInsertedAttachmentKinds: vi.fn(() => []),
      initializeMessages: vi.fn(async () => []),
    }) as never,
    onRoundFinalized: vi.fn(),
    prompt: AgentPromptSchema.parse({
      systemPrompt: 'You are careful.',
      userRequest: 'Do the thing.',
    }),
    session: {} as never,
    setting: { agentCategory: 'toolUse', tools: [] } as never,
    resumeShared: null,
    toolRegistry: {} as never,
    userVarChannels: { input: {}, transient: {} },
    ...overrides,
  } as ToolUseServices<unknown>;
}

describe('ToolUsePrepareNode transcript logging (regression #7508)', () => {
  it('logs the initial transcript row when initializeMessages throws', async () => {
    // A failed first turn (corrupt/oversized media, provider validation
    // error, ...) must still leave a record of what the user asked for —
    // otherwise the transcript's opening row silently vanishes for exactly
    // the runs most likely to need debugging.
    const services = buildServices({
      initialUserMessageForTranscript: 'Do the thing.',
    });
    services.modelCell.handler.initializeMessages = vi
      .fn()
      .mockRejectedValue(new Error('media processing failed')) as never;
    const node = new ToolUsePrepareNode().setServices(services);

    await expect(node.exec(undefined)).rejects.toThrow(
      'media processing failed',
    );

    expect(services.logger.info).toHaveBeenCalledWith(
      'Do the thing.',
      expect.objectContaining({ messageType: expect.any(String) }),
    );
    expect(
      services.modelCell.handler.consumeInsertedAttachmentKinds,
    ).toHaveBeenCalledWith('initial');
  });

  it('still logs exactly once on the success path', async () => {
    const services = buildServices({
      initialUserMessageForTranscript: 'Do the thing.',
    });
    const node = new ToolUsePrepareNode().setServices(services);

    await node.exec(undefined);

    expect(services.logger.info).toHaveBeenCalledTimes(1);
  });

  it('does not log when there is no initial transcript row to write', async () => {
    const services = buildServices({
      initialUserMessageForTranscript: undefined,
    });
    services.modelCell.handler.initializeMessages = vi
      .fn()
      .mockRejectedValue(new Error('boom')) as never;
    const node = new ToolUsePrepareNode().setServices(services);

    await expect(node.exec(undefined)).rejects.toThrow('boom');

    expect(services.logger.info).not.toHaveBeenCalled();
  });
});

describe('ToolUsePrepareNode resume (prompt-cache preservation)', () => {
  it('keeps the persisted message prefix while rebuilding the per-call system prompt', async () => {
    // Rewriting the persisted system message on every resume to reflect
    // current workspace/tool state would change the leading bytes of the
    // request and invalidate the provider's prefix-based prompt cache. Per
    // maintainer ruling, resume must use the snapshot's messages verbatim —
    // a mid-run agent-config edit does not propagate into an
    // already-suspended run's prefix. The separate per-call system prompt,
    // however, must still be rebuilt from the current prompt configuration.
    const resumeShared = createToolUseResumeShared({
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'stale system' }] },
      ],
    });
    const services = buildServices({ resumeShared });
    const node = new ToolUsePrepareNode().setServices(services);
    const resolvedToolNames = services.setting.tools.map((tool) => tool.name);
    const rebuiltPrompts = await buildInitialToolUsePrompts(
      services.prompt,
      services.userVarChannels.transient,
      services.logger,
      {
        resolvedToolNames,
        hasDelegationTools: hasDelegationTool(resolvedToolNames),
        isSubagent: services.isSubagent,
      },
    );

    const result = await node.exec(undefined);

    expect(result.systemPrompt).toBe(
      `${rebuiltPrompts.systemPrompt}\n${rebuiltPrompts.instructionSuffix}`,
    );
    expect(result.messages).toBe(resumeShared.messages);
    expect(result.messages[0]).toEqual({
      role: 'system',
      content: [{ type: 'text', text: 'stale system' }],
    });
    expect(result.shouldSkipCycle).toBe(true);
    // initializeMessages is the fresh-session path; resume must not call it.
    expect(
      services.modelCell.handler.initializeMessages,
    ).not.toHaveBeenCalled();
  });
});

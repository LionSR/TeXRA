// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handleExternalInquiryActionMock = vi.hoisted(() => vi.fn());
let detachHostInteractions = (): void => {};

vi.mock('@tools/inquiry/ExternalInquiryTool', () => ({
  handleExternalInquiryAction: handleExternalInquiryActionMock,
}));

import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { HostRetryRequest } from '@agent/runtime/HostInteractions';
import {
  appendCliApiSwitchHint,
  approvalPromptAllowed,
  createHeadlessCliHostInteractions,
  formatAgentProposalApprovalSummary,
  formatRetryRequestMessage,
  formatToolEditApprovalSummary,
  handleCliApprovalEvent,
  hasCliApprovalDenied,
  humanInputDenialFeedback,
  immediateDecisionForApproval,
  isCliApiSwitchableRetry,
} from '@cli/runtime/approvalAdapter';
import type { CliContext } from '@cli/runtime/cliContext';
import type { CliApprovalPromptHooks } from '@cli/runtime/approval/approvalPolicy';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  type StreamTabId,
} from '@shared/schemas';
import { requestToolEditApproval } from '@tools/approval/toolEditApproval';

function context(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp',
    mode: 'interactive',
    outputFormat: 'text',
    approvalPolicy: 'ask',
    stdoutColorEnabled: false,
    stderrColorEnabled: false,
    colorEnabled: false,
    version: 'test',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
}

function useCliHostInteractions(
  cliContext: CliContext,
  hooks: CliApprovalPromptHooks = {},
): void {
  detachHostInteractions();
  detachHostInteractions = defaultSession().useHostInteractions(
    createHeadlessCliHostInteractions(cliContext, hooks),
  );
}

const credentialExhaustedRetry: RuntimeInteractionEventPayloads['showRetryRequest'] =
  {
    streamId:
      'test-stream' as RuntimeInteractionEventPayloads['showRetryRequest']['streamId'],
    operation: 'Tool-use call',
    errorMessage: 'HTTP 429 Too Many Requests',
    errorDetails: {
      exhaustionReason: 'relay-limit',
      isRelayError: true,
      statusCode: 429,
    },
  };

beforeEach(async () => {
  const { initPlatform: init } = await import('@platform/platform');
  const { createFakePlatform } = await import('@test/support/FakePlatform');
  init(createFakePlatform());
});

afterEach(() => {
  detachHostInteractions();
  detachHostInteractions = () => {};
  handleExternalInquiryActionMock.mockClear();
});

describe('immediateDecisionForApproval', () => {
  it('shows the interactive retry panel for exhausted credentials', () => {
    expect(
      immediateDecisionForApproval(
        'showRetryRequest',
        credentialExhaustedRetry,
        context(),
      ),
    ).toBeUndefined();
  });

  it('denies exhausted credential retries outside interactive ask mode', () => {
    expect(
      immediateDecisionForApproval(
        'showRetryRequest',
        credentialExhaustedRetry,
        context({ approvalPolicy: 'yolo' }),
      ),
    ).toMatchObject({ accepted: false });

    expect(
      immediateDecisionForApproval(
        'showRetryRequest',
        credentialExhaustedRetry,
        context({ mode: 'headless' }),
      ),
    ).toMatchObject({ accepted: false });
  });
});

describe('human input approval policy', () => {
  it('allows prompts only for interactive ask mode', () => {
    expect(approvalPromptAllowed(context())).toBe(true);
    expect(approvalPromptAllowed(context({ approvalPolicy: 'yolo' }))).toBe(
      false,
    );
    expect(approvalPromptAllowed(context({ approvalPolicy: 'never' }))).toBe(
      false,
    );
    expect(approvalPromptAllowed(context({ mode: 'headless' }))).toBe(false);
  });

  it('uses yolo-specific human-input feedback without marking approval denied', () => {
    const ctx = context({ approvalPolicy: 'yolo' });

    expect(
      humanInputDenialFeedback(
        ctx,
        'User question requires human input; yolo mode cannot synthesize an answer.',
      ),
    ).toBe(
      'User question requires human input; yolo mode cannot synthesize an answer.',
    );
    expect(hasCliApprovalDenied(ctx)).toBe(false);
  });

  it('uses approval denial feedback and marks denied outside yolo mode', () => {
    const ctx = context({ approvalPolicy: 'never' });

    expect(humanInputDenialFeedback(ctx, 'unused yolo message')).toBe(
      'Denied by CLI approval policy.',
    );
    expect(hasCliApprovalDenied(ctx)).toBe(true);
  });
});

describe('approval prompt hooks', () => {
  const proposal: RuntimeInteractionEventPayloads['showAgentProposal'] = {
    proposalId: 'proposal-1',
    streamId: 'root@deepseekT#abc',
    agent: 'review',
    model: 'deepseekT',
    instruction: 'Please check this proof.',
    memories: [],
    agentCategory: AgentCategory.ToolUse,
  };

  it('runs the before-prompt hook for interactive approval events', async () => {
    const events: string[] = [];
    const result = await createHeadlessCliHostInteractions(
      context({
        approvalPrompt: async () => {
          events.push('prompt');
          return 'n no review needed';
        },
      }),
      {
        beforePrompt: () => {
          events.push('before');
        },
      },
    ).requestAgentProposal?.(proposal);

    expect(result).toEqual({
      action: 'reject',
      feedback: 'no review needed',
    });
    expect(events).toEqual(['before', 'prompt']);
  });

  it('does not run the before-prompt hook for auto-approved events', async () => {
    const events: string[] = [];
    const result = await createHeadlessCliHostInteractions(
      context({ approvalPolicy: 'yolo' }),
      {
        beforePrompt: () => {
          events.push('before');
        },
      },
    ).requestAgentProposal?.(proposal);

    expect(result).toEqual({ action: 'approve' });
    expect(events).toEqual([]);
  });

  it('routes automatic proposal rejection through the headless interaction port', async () => {
    const result = await createHeadlessCliHostInteractions(
      context({ approvalPolicy: 'never' }),
    ).requestAgentProposal?.(proposal);

    expect(result).toEqual({
      action: 'reject',
      feedback: 'Denied by CLI approval policy.',
    });
  });

  it('does not prompt for external inquiry in non-TUI CLI runs', async () => {
    const events: string[] = [];
    const handled = handleCliApprovalEvent(
      'showExternalInquiry',
      {
        requestId: 'ei_aabbccdd0011',
        mode: 'followUp' as const,
        threadId: 'ei_aabbccdd0011',
        question: 'May I ask an external model to verify this proof?',
        allowBypass: false,
        streamId: 'root@deepseekT#abc',
        sessionLinks: null,
        draft: null,
        transcript: null,
      },
      context({
        approvalPrompt: async () => {
          events.push('prompt');
          return 'yes';
        },
      }),
      {
        beforePrompt: () => {
          events.push('before');
        },
      },
    );

    expect(handled).toBe(true);
    expect(events).toEqual([]);
    await Promise.resolve();
    expect(handleExternalInquiryActionMock).toHaveBeenCalledWith({
      action: 'drop',
      threadId: 'ei_aabbccdd0011',
      feedback: expect.stringContaining('non-TUI CLI runs'),
    });
  });
});

describe('requestRetry classification (#7331)', () => {
  const retryRequest: HostRetryRequest = {
    streamId: 'root@deepseekT#abc' as StreamTabId,
    operation: 'Model invocation',
    errorMessage: 'stream dropped before first token',
  };

  it('denies (not cancels) a retry when no human input is available', async () => {
    const result = await createHeadlessCliHostInteractions(
      context({ approvalPolicy: 'never', mode: 'headless' }),
    ).requestRetry?.(retryRequest);

    // A policy/headless auto-denial is a distinct failure, not a user cancel,
    // so a zero-output run reports FAILED rather than COMPLETED.
    expect(result).toEqual({
      action: 'deny',
      reason: 'Denied by CLI approval policy.',
    });
  });

  it('cancels a retry the interactive user explicitly rejects', async () => {
    const result = await createHeadlessCliHostInteractions(
      context({ approvalPrompt: async () => 'n not now' }),
    ).requestRetry?.(retryRequest);

    expect(result).toEqual({ action: 'cancel' });
  });
});

describe('formatToolEditApprovalSummary', () => {
  it('includes the proposed edit diff in interactive CLI prompts', () => {
    const summary = formatToolEditApprovalSummary({
      path: '/tmp/proof.tex',
      originalContent: 'Let G be a group.\nThis is wrong.\n',
      proposedContent: 'Let G be a group.\nThis is correct.\n',
      sourceTool: 'edit_file',
    });

    expect(summary).toContain('Tool edit requested by edit_file');
    expect(summary).toContain('Proposed diff:');
    expect(summary).toContain('-This is wrong.');
    expect(summary).toContain('+This is correct.');
  });

  it('passes the diff summary to the interactive approval prompt', async () => {
    let promptSummary = '';
    useCliHostInteractions(
      context({
        approvalPrompt: async (request) => {
          promptSummary = request.summary;
          return 'n needs revision';
        },
      }),
    );

    const result = await requestToolEditApproval({
      path: '/tmp/new-proof.tex',
      originalContent: '',
      proposedContent: '\\section{Proof}\nA concise proof.\n',
      sourceTool: 'write_file',
    });

    expect(result.accepted).toBe(false);
    expect(promptSummary).toContain('Tool edit requested by write_file');
    expect(promptSummary).toContain('+\\section{Proof}');
    expect(promptSummary).toContain('+A concise proof.');
  });

  it('runs the before-prompt hook for tool edit approvals', async () => {
    const events: string[] = [];
    useCliHostInteractions(
      context({
        approvalPrompt: async () => {
          events.push('prompt');
          return 'y';
        },
      }),
      {
        beforePrompt: () => {
          events.push('before');
        },
      },
    );

    const result = await requestToolEditApproval({
      path: '/tmp/new-proof.tex',
      originalContent: '',
      proposedContent: '\\section{Proof}\nA concise proof.\n',
      sourceTool: 'write_file',
    });

    expect(result.accepted).toBe(true);
    expect(events).toEqual(['before', 'prompt']);
  });

  it('passes one-line rejection feedback to the tool result', async () => {
    useCliHostInteractions(
      context({
        approvalPrompt: async () => 'n proof misses the p = 5 case',
      }),
    );

    const result = await requestToolEditApproval({
      path: '/tmp/new-proof.tex',
      originalContent: '',
      proposedContent: '\\section{Proof}\nA concise proof.\n',
      sourceTool: 'write_file',
    });

    expect(result).toMatchObject({
      accepted: false,
      userMessage: 'proof misses the p = 5 case',
    });
  });

  it('prompts for rejection feedback after an explicit no', async () => {
    const prompts: string[] = [];
    const summaries: string[] = [];
    const answers = ['n', 'use the workspace-local file path'];
    useCliHostInteractions(
      context({
        approvalPrompt: async (request) => {
          prompts.push(request.prompt);
          summaries.push(request.summary);
          return answers.shift() ?? '';
        },
      }),
    );

    const result = await requestToolEditApproval({
      path: '/tmp/new-proof.tex',
      originalContent: '',
      proposedContent: '\\section{Proof}\nA concise proof.\n',
      sourceTool: 'write_file',
    });

    expect(prompts).toEqual([
      'Approve? [y/N, or n <feedback>] ',
      'Rejection feedback (optional, Enter to skip): ',
    ]);
    expect(summaries[0]).toContain('Tool edit requested by write_file');
    expect(summaries[1]).toBe('');
    expect(result).toMatchObject({
      accepted: false,
      userMessage: 'use the workspace-local file path',
    });
  });

  it('bounds long diff lines before prompting', () => {
    const longLine = 'x'.repeat(1_000);
    const summary = formatToolEditApprovalSummary({
      path: '/tmp/generated.json',
      originalContent: '',
      proposedContent: `${longLine}\n`,
      sourceTool: 'write_file',
    });

    expect(summary).toContain('[line truncated]');
    expect(summary).not.toContain(longLine);
    expect(summary.length).toBeLessThan(1_000);
  });

  it('marks hidden diff lines when the line budget is exceeded', () => {
    const proposedContent = Array.from(
      { length: 100 },
      (_, index) => `generated line ${index + 1}`,
    ).join('\n');
    const summary = formatToolEditApprovalSummary({
      path: '/tmp/generated.tex',
      originalContent: '',
      proposedContent,
      sourceTool: 'write_file',
    });

    expect(summary).toContain('diff lines hidden');
  });

  it('skips prompting for auto-approved edits', async () => {
    useCliHostInteractions(
      context({
        approvalPolicy: 'yolo',
        approvalPrompt: async () => {
          throw new Error('approval prompt should not be called');
        },
      }),
    );

    const result = await requestToolEditApproval({
      path: '/tmp/auto-approved.tex',
      originalContent: '',
      proposedContent: '\\section{Auto-approved}\n',
      sourceTool: 'write_file',
    });

    expect(result).toMatchObject({
      accepted: true,
      appliedContent: '\\section{Auto-approved}\n',
    });
  });
});

describe('formatAgentProposalApprovalSummary', () => {
  it('formats subagent approvals without raw JSON internals', () => {
    const summary = formatAgentProposalApprovalSummary({
      proposalId: 'proposal-1',
      streamId: 'root@deepseekT#abc',
      agent: 'review',
      model: 'deepseekT',
      instruction:
        'Please verify the proof carefully.\nReport any gaps or hidden cases.',
      memories: [],
      agentCategory: AgentCategory.ToolUse,
    });

    expect(summary).toContain(
      'Agent proposal requested: review (tool-use agent)',
    );
    expect(summary).toContain('Model: deepseekT');
    expect(summary).toContain('Instruction:');
    expect(summary).toContain('  Please verify the proof carefully.');
    expect(summary).not.toContain('proposalId');
    expect(summary).not.toContain('streamId');
    expect(summary).not.toContain('{');
  });

  it('bounds long subagent instructions before prompting', () => {
    const longLine = 'verify '.repeat(200);
    const instruction = Array.from(
      { length: 60 },
      (_, index) => `${index + 1}. ${longLine}`,
    ).join('\n');

    const summary = formatAgentProposalApprovalSummary({
      proposalId: 'proposal-1',
      streamId: 'root@deepseekT#abc',
      agent: 'review',
      model: 'deepseekT',
      instruction,
      memories: ['/memories/proof-style.md'],
      workingDirectory: '/tmp/project',
      agentCategory: AgentCategory.ToolUse,
    });

    expect(summary).toContain('Working directory: /tmp/project');
    expect(summary).toContain('Memories: /memories/proof-style.md');
    expect(summary).toContain('[line truncated]');
    expect(summary).toContain('instruction lines hidden');
    expect(summary).not.toContain(longLine);
  });

  it('includes workflow proposal file groups', () => {
    const summary = formatAgentProposalApprovalSummary({
      proposalId: 'proposal-1',
      streamId: 'root@deepseekT#abc',
      agent: 'polish',
      model: 'deepseekT',
      instruction: 'Polish the draft and write the revised file.',
      memories: [],
      inputFiles: ['draft.tex'],
      contextFiles: ['notes.md'],
      mediaFiles: ['figure.png'],
      outputFiles: ['draft-polished.tex'],
      toolConfig: DEFAULT_TOOL_CONFIG,
      agentCategory: AgentCategory.Workflow,
    });

    expect(summary).toContain(
      'Agent proposal requested: polish (workflow agent)',
    );
    expect(summary).toContain('Input: draft.tex');
    expect(summary).toContain('Context: notes.md');
    expect(summary).toContain('Media: figure.png');
    expect(summary).toContain('Output: draft-polished.tex');
  });
});

describe('formatRetryRequestMessage', () => {
  it('shows the API-key switch for exhausted included access', () => {
    expect(formatRetryRequestMessage(credentialExhaustedRetry)).toContain(
      '/api personal',
    );
  });

  it('recognizes relay monthly-limit text when the relay body is absent', () => {
    const retry: RuntimeInteractionEventPayloads['showRetryRequest'] = {
      ...credentialExhaustedRetry,
      errorMessage:
        'HTTP 429 Too Many Requests – 429 Monthly spending limit reached ($300).',
      errorDetails: {
        exhaustionReason: 'relay-limit',
        isRelayError: false,
        statusCode: 429,
      },
    };

    expect(isCliApiSwitchableRetry(retry)).toBe(true);
    expect(appendCliApiSwitchHint(retry.errorMessage!)).toContain(
      '/api personal',
    );
  });
});

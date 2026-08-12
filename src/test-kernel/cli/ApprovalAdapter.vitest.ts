// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handleExternalInquiryActionMock = vi.hoisted(() => vi.fn());
let detachHostInteractions = (): void => {};

vi.mock('@tools/inquiry/inquiryActions', () => ({
  handleExternalInquiryAction: handleExternalInquiryActionMock,
}));

import { Node } from '@agent/node';
import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import type {
  HostInteractions,
  HostRetryRequest,
} from '@agent/runtime/HostInteractions';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { createHeadlessCliHostInteractions } from '@cli/runtime/approvalAdapter';
import type { CliContext } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { runOutcomeExitCode } from '@cli/runtime/terminalStatus';
import {
  appendCliApiSwitchHint,
  isCliApiSwitchableRetry,
  type CliApprovalPromptHooks,
} from '@cli/runtime/approval/approvalPrompts';
import { denyExternalInquiryIfNoHumanInput } from '@cli/runtime/approval/settleApprovals';
import {
  formatAgentProposalApprovalSummary,
  formatRetryRequestMessage,
  formatToolEditApprovalSummary,
} from '@cli/runtime/approval/approvalSummaries';
import {
  decideRetryApproval,
  TEXRA_APPROVAL_POLICY_DENIED_MESSAGE,
} from '@shared/approvalPolicy';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  RUN_OUTCOME,
  type AgentProposalPermission,
  type RetryPermission,
  type StreamTabId,
} from '@shared/schemas';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { requestToolEditApproval } from '@tools/approval/toolEditApproval';

function context(overrides: Partial<CliContext> = {}): CliContext {
  const ctx = createTestCliContext({
    cwd: '/tmp',
    mode: 'interactive',
    approvalPolicy: 'ask',
    version: 'test',
    ...overrides,
  });
  defaultSession().setApprovalPolicy(ctx.approvalPolicy);
  return ctx;
}

function useCliHostInteractions(
  cliContext: CliContext,
  hooks: CliApprovalPromptHooks = {},
): void {
  detachHostInteractions();
  defaultSession().setApprovalPolicy(cliContext.approvalPolicy);
  detachHostInteractions = defaultSession().useHostInteractions(
    createHeadlessCliHostInteractions(cliContext, hooks),
  );
}

function requestNewProofEdit(): ReturnType<typeof requestToolEditApproval> {
  return requestToolEditApproval({
    path: '/tmp/new-proof.tex',
    originalContent: '',
    proposedContent: '\\section{Proof}\nA concise proof.\n',
    sourceTool: 'write_file',
  });
}

function agentProposal(
  overrides: Partial<AgentProposalPermission> = {},
): AgentProposalPermission {
  const base = {
    proposalId: 'proposal-1',
    streamId: 'root@deepseekT#abc',
    agent: 'review',
    model: 'deepseekT',
    instruction: 'Please check this proof.',
    memories: [],
  };
  const { agentCategory, ...rest } = overrides;
  if (agentCategory === AgentCategory.Workflow) {
    return {
      ...base,
      agentCategory,
      inputFiles: [],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: [],
      toolConfig: DEFAULT_TOOL_CONFIG,
      ...rest,
    };
  }
  return {
    ...base,
    agentCategory: AgentCategory.ToolUse,
    ...rest,
  };
}

/** Records before-prompt/prompt ordering for approval-prompt hook tests. */
function trackPromptEvents(): {
  events: string[];
  hooks: CliApprovalPromptHooks;
  answerWith: (answer: string) => () => Promise<string>;
} {
  const events: string[] = [];
  return {
    events,
    hooks: {
      beforePrompt: () => {
        events.push('before');
      },
    },
    answerWith: (answer) => async () => {
      events.push('prompt');
      return answer;
    },
  };
}

const credentialExhaustedRetry: RetryPermission = {
  requestId: 'relay-limit-retry',
  streamId: 'test-stream' as RetryPermission['streamId'],
  operation: 'Model request',
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

describe('shared retry and human-input decisions', () => {
  it('presents credential retries only under interactive ask', () => {
    expect(
      decideRetryApproval({
        policy: 'ask',
        canPresent: true,
        isCredentialFailure: true,
      }),
    ).toBe('present');
  });

  it('denies an ordinary transient retry in yolo', async () => {
    const ctx = context({ approvalPolicy: 'yolo' });
    const result = await createHeadlessCliHostInteractions(ctx).requestRetry?.({
      requestId: 'transient-retry',
      streamId: 'test-stream' as StreamTabId,
      operation: 'Model request',
      errorMessage: 'stream dropped before first token',
    });

    expect(result).toMatchObject({ action: 'deny' });
  });
});

describe('human input approval policy', () => {
  it('denies external inquiry under never', () => {
    const ctx = context({ approvalPolicy: 'never' });
    expect(denyExternalInquiryIfNoHumanInput('ei_test', ctx)).toBe(true);
    expect(handleExternalInquiryActionMock).toHaveBeenCalledWith({
      action: 'drop',
      threadId: 'ei_test',
      feedback: TEXRA_APPROVAL_POLICY_DENIED_MESSAGE,
    });
  });

  it('reports a shared edit-policy denial through the run-context hook', async () => {
    const ctx = context({ approvalPolicy: 'never', mode: 'headless' });
    useCliHostInteractions(ctx);
    let policyDenials = 0;

    const result = await withRunContext(
      createRunContext({
        onApprovalPolicyDenial: () => {
          policyDenials += 1;
        },
      }),
      requestNewProofEdit,
    );
    expect(result).toMatchObject({ accepted: false });
    expect(policyDenials).toBe(1);
    // The model routes around the denial, so the run's exit code is untouched.
    expect(runOutcomeExitCode(RUN_OUTCOME.COMPLETED)).toBe(CliExitCode.Success);
    expect(runOutcomeExitCode(RUN_OUTCOME.CANCELLED)).toBe(
      CliExitCode.Interrupted,
    );
  });
});

describe('approval prompt hooks', () => {
  const proposal = agentProposal();

  it('forwards presentation events to the attached CLI presenter', () => {
    const emit = vi.fn();
    const interactions = createHeadlessCliHostInteractions(context(), {
      emit,
    });

    interactions.emit?.('requestShowError', { message: 'Run failed.' });

    expect(emit).toHaveBeenCalledWith('requestShowError', {
      message: 'Run failed.',
    });
  });

  it('runs the before-prompt hook for interactive approval events', async () => {
    const tracker = trackPromptEvents();
    const result = await createHeadlessCliHostInteractions(
      context({ approvalPrompt: tracker.answerWith('n no review needed') }),
      tracker.hooks,
    ).requestAgentProposal?.(proposal);

    expect(result).toEqual({
      action: 'reject',
      feedback: 'no review needed',
    });
    expect(tracker.events).toEqual(['before', 'prompt']);
  });

  it('does not run the before-prompt hook for auto-approved events', async () => {
    const tracker = trackPromptEvents();
    const result = await createHeadlessCliHostInteractions(
      context({ approvalPolicy: 'yolo' }),
      tracker.hooks,
    ).requestAgentProposal?.(proposal);

    expect(result).toEqual({ action: 'approve' });
    expect(tracker.events).toEqual([]);
  });

  it('routes automatic proposal rejection through the headless interaction port', async () => {
    const result = await createHeadlessCliHostInteractions(
      context({ approvalPolicy: 'never' }),
    ).requestAgentProposal?.(proposal);

    expect(result).toEqual({
      action: 'reject',
      feedback: 'Denied by TeXRA approval policy.',
    });
  });

  it('does not prompt for external inquiry in non-TUI CLI runs', async () => {
    const tracker = trackPromptEvents();

    await createHeadlessCliHostInteractions(
      context({ approvalPrompt: tracker.answerWith('yes') }),
      tracker.hooks,
    ).openExternalInquiry?.({
      requestId: 'ei_aabbccdd0011',
      mode: 'followUp' as const,
      threadId: 'ei_aabbccdd0011',
      question: 'May I ask an external model to verify this proof?',
      allowBypass: false,
      streamId: 'root@deepseekT#abc',
      sessionLinks: null,
      draft: null,
      transcript: null,
    });

    expect(tracker.events).toEqual([]);
    expect(handleExternalInquiryActionMock).toHaveBeenCalledWith({
      action: 'drop',
      threadId: 'ei_aabbccdd0011',
      feedback: expect.stringContaining('non-TUI CLI runs'),
    });
  });
});

describe('requestRetry classification (#7331)', () => {
  const retryRequest: HostRetryRequest = {
    requestId: 'headless-retry',
    streamId: 'root@deepseekT#abc' as StreamTabId,
    operation: 'Model invocation',
    errorMessage: 'stream dropped before first token',
  };

  function requestHeadlessRetry(
    ctx: CliContext,
    overrides: Partial<HostRetryRequest> = {},
  ) {
    return createHeadlessCliHostInteractions(ctx).requestRetry?.({
      ...retryRequest,
      ...overrides,
    });
  }

  it('denies (not cancels) a retry when no human input is available', async () => {
    const ctx = context({ approvalPolicy: 'never', mode: 'headless' });
    const result = await requestHeadlessRetry(ctx);

    // A policy/headless auto-denial is a deny, not a user cancel: the model
    // receives the reason as feedback instead of the turn being abandoned.
    expect(result).toEqual({
      action: 'deny',
      reason: 'Denied by TeXRA approval policy.',
    });
  });

  it.each([
    { approvalPolicy: 'never' as const, mode: 'interactive' as const },
    { approvalPolicy: 'ask' as const, mode: 'headless' as const },
  ])(
    'preserves the credential denial reason in $approvalPolicy/$mode mode',
    async ({ approvalPolicy, mode }) => {
      const result = await requestHeadlessRetry(
        context({ approvalPolicy, mode }),
        {
          errorDetails: credentialExhaustedRetry.errorDetails,
        },
      );

      expect(result).toEqual({
        action: 'deny',
        reason: 'Retry skipped: credential exhausted or unauthorized.',
      });
    },
  );

  it('denies a yolo retry without changing provider-failure exit classification', async () => {
    const result = await requestHeadlessRetry(
      context({ approvalPolicy: 'yolo' }),
    );

    expect(result).toEqual({
      action: 'deny',
      reason:
        'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.',
    });
    expect(runOutcomeExitCode(RUN_OUTCOME.FAILED)).toBe(CliExitCode.AgentError);
  });

  it.each([
    credentialExhaustedRetry.errorDetails,
    { message: 'Unauthorized', statusCode: 401 },
    { message: 'Forbidden', statusCode: 403 },
  ])(
    'preserves the credential denial reason for yolo credential/auth failure %#',
    async (errorDetails) => {
      const result = await requestHeadlessRetry(
        context({ approvalPolicy: 'yolo' }),
        { errorDetails },
      );

      expect(result).toEqual({
        action: 'deny',
        reason: 'Retry skipped: credential exhausted or unauthorized.',
      });
    },
  );

  it('cancels a retry the interactive user explicitly rejects', async () => {
    const result = await requestHeadlessRetry(
      context({ approvalPrompt: async () => 'n not now' }),
    );

    expect(result).toEqual({ action: 'cancel' });
  });
});

class RepresentativeFailingProviderNode extends Node {
  providerCalls = 0;
  readonly providerError = new Error('permanent provider failure');

  constructor(
    private readonly interactions: HostInteractions,
    private readonly streamId: StreamTabId,
  ) {
    super(3, 0);
  }

  override async exec(): Promise<never> {
    this.providerCalls += 1;
    throw this.providerError;
  }

  override async retryPrompt(): Promise<boolean> {
    const result = await this.interactions.requestRetry?.({
      requestId: `retry-${this.streamId}`,
      streamId: this.streamId,
      operation: 'Model invocation',
      errorMessage: 'permanent provider failure',
    });
    return result?.action === 'retry';
  }
}

describe('bounded yolo retry batches (#9532)', () => {
  it('stops two representative streams after one automatic batch', async () => {
    // Representative streams share the session's CLI policy adapter. This
    // proves stream-agnostic bounding, not delegation inheritance.
    const interactions = createHeadlessCliHostInteractions(
      context({ approvalPolicy: 'yolo' }),
    );
    const first = new RepresentativeFailingProviderNode(
      interactions,
      'representative-a' as StreamTabId,
    );
    const second = new RepresentativeFailingProviderNode(
      interactions,
      'representative-b' as StreamTabId,
    );

    await expect(first._exec(undefined)).rejects.toBe(first.providerError);
    await expect(second._exec(undefined)).rejects.toBe(second.providerError);

    expect(first.providerCalls).toBe(3);
    expect(second.providerCalls).toBe(3);
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

    const result = await requestNewProofEdit();

    expect(result.accepted).toBe(false);
    expect(promptSummary).toContain('Tool edit requested by write_file');
    expect(promptSummary).toContain('+\\section{Proof}');
    expect(promptSummary).toContain('+A concise proof.');
  });

  it('runs the before-prompt hook for tool edit approvals', async () => {
    const tracker = trackPromptEvents();
    useCliHostInteractions(
      context({ approvalPrompt: tracker.answerWith('y') }),
      tracker.hooks,
    );

    const result = await requestNewProofEdit();

    expect(result.accepted).toBe(true);
    expect(tracker.events).toEqual(['before', 'prompt']);
  });

  it('passes one-line rejection feedback to the tool result', async () => {
    useCliHostInteractions(
      context({
        approvalPrompt: async () => 'n proof misses the p = 5 case',
      }),
    );

    const result = await requestNewProofEdit();

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

    const result = await requestNewProofEdit();

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
    const summary = formatAgentProposalApprovalSummary(
      agentProposal({
        instruction:
          'Please verify the proof carefully.\nReport any gaps or hidden cases.',
      }),
    );

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

    const summary = formatAgentProposalApprovalSummary(
      agentProposal({
        instruction,
        memories: ['/memories/proof-style.md'],
        workingDirectory: '/tmp/project',
      }),
    );

    expect(summary).toContain('Working directory: /tmp/project');
    expect(summary).toContain('Memories: /memories/proof-style.md');
    expect(summary).toContain('[line truncated]');
    expect(summary).toContain('instruction lines hidden');
    expect(summary).not.toContain(longLine);
  });

  it('includes workflow proposal file groups', () => {
    const summary = formatAgentProposalApprovalSummary(
      agentProposal({
        agent: 'polish',
        instruction: 'Polish the draft and write the revised file.',
        inputFiles: ['draft.tex'],
        contextFiles: ['notes.md'],
        mediaFiles: ['figure.png'],
        outputFiles: ['draft-polished.tex'],
        toolConfig: DEFAULT_TOOL_CONFIG,
        agentCategory: AgentCategory.Workflow,
      }),
    );

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
    const retry: RetryPermission = {
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

  it('shows the Moonshot API-key switch for a Kimi Code subscription limit', () => {
    const retry: RetryPermission = {
      ...credentialExhaustedRetry,
      errorDetails: {
        exhaustionReason: 'kimi-code-subscription',
        isRelayError: false,
        statusCode: 429,
      },
    };

    expect(isCliApiSwitchableRetry(retry)).toBe(true);
    expect(formatRetryRequestMessage(retry)).toContain(
      'Kimi Code subscription',
    );
    expect(formatRetryRequestMessage(retry)).toContain('Moonshot API keys');
  });
});

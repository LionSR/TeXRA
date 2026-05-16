// Local imports - runtime
import {
  cancelRetry,
  resolvePlanApproval,
  resolveProposal,
  triggerRetry,
} from '@agent/runtime/runCoordinators';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local imports - tools
import { handleUserQuestionAction } from '@tools/userQuestion';
import { handleProgressViewBashApprovalAction } from '@tools/approval/bashApproval';
import {
  setToolEditApprovalHandler,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

// Local imports - CLI runtime
import { type CliContext, type CliPromptRequest } from './cliContext';
import { askCliQuestion, writeTextStderr } from './logSinks';
import { parseUserQuestionAnswer } from './userQuestionAnswer';

export interface ApprovalDecision {
  readonly accepted: boolean;
  readonly userMessage?: string;
}

type ApprovalEvent =
  | 'showBashPermission'
  | 'showPlanApproval'
  | 'showAgentProposal'
  | 'showRetryRequest';

function isApprovalEvent(
  event: keyof ProgressEventPayloads,
): event is ApprovalEvent {
  return (
    event === 'showBashPermission' ||
    event === 'showPlanApproval' ||
    event === 'showAgentProposal' ||
    event === 'showRetryRequest'
  );
}

const deniedApprovalContexts = new WeakSet<CliContext>();
const cliPromptQueues = new WeakMap<CliContext, Promise<unknown>>();

export function denyMessage(policy: CliContext['approvalPolicy']): string {
  return policy === 'ask'
    ? 'Interactive approval requires a TTY; this CLI run is headless.'
    : 'Denied by CLI approval policy.';
}

export function markApprovalDenied(context: CliContext): void {
  deniedApprovalContexts.add(context);
}

export function hasCliApprovalDenied(context: CliContext): boolean {
  return deniedApprovalContexts.has(context);
}

function approvalPromptAllowed(context: CliContext): boolean {
  return context.approvalPolicy === 'ask' && context.mode === 'interactive';
}

function enqueueCliPrompt<T>(
  context: CliContext,
  prompt: () => Promise<T>,
): Promise<T> {
  const previous = cliPromptQueues.get(context) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(prompt);
  cliPromptQueues.set(
    context,
    next.catch(() => undefined),
  );
  return next;
}

async function askCliApprovalQuestion(
  context: CliContext,
  request: CliPromptRequest,
): Promise<string> {
  if (context.approvalPrompt) {
    return context.approvalPrompt(request);
  }
  return askCliQuestion(`${request.summary}\n${request.prompt}`);
}

export function immediateDecision(
  context: CliContext,
): ApprovalDecision | undefined {
  if (context.approvalPolicy === 'yolo') return { accepted: true };
  if (approvalPromptAllowed(context)) return undefined;
  markApprovalDenied(context);
  return { accepted: false, userMessage: denyMessage(context.approvalPolicy) };
}

async function askApproval(
  context: CliContext,
  summary: string,
): Promise<ApprovalDecision> {
  let answer: string;
  try {
    answer = await enqueueCliPrompt(context, () =>
      askCliApprovalQuestion(context, {
        kind: 'approval',
        summary,
        prompt: 'Approve? [y/N] ',
      }),
    );
  } catch {
    markApprovalDenied(context);
    return { accepted: false, userMessage: 'CLI approval prompt failed.' };
  }

  const normalized = answer.trim().toLowerCase();
  const accepted = normalized === 'y' || normalized === 'yes';
  if (!accepted) markApprovalDenied(context);
  return {
    accepted,
    userMessage: accepted ? undefined : 'Rejected from CLI approval prompt.',
  };
}

function summarizeApprovalEvent<K extends ApprovalEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
): string {
  switch (event) {
    case 'showBashPermission': {
      const data = payload as ProgressEventPayloads['showBashPermission'];
      return `Bash command requested:\n${data.command}`;
    }
    case 'showPlanApproval': {
      const data = payload as ProgressEventPayloads['showPlanApproval'];
      return `Plan approval requested:\n${JSON.stringify(data.plan, null, 2)}`;
    }
    case 'showAgentProposal': {
      const data = payload as ProgressEventPayloads['showAgentProposal'];
      return `Agent proposal requested:\n${JSON.stringify(data, null, 2)}`;
    }
    case 'showRetryRequest': {
      const data = payload as ProgressEventPayloads['showRetryRequest'];
      return `Retry requested for ${data.operation}: ${data.errorMessage ?? 'unknown error'}`;
    }
    default: {
      const never: never = event;
      return String(never);
    }
  }
}

function dispatchApprovalDecision<K extends ApprovalEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
  decision: ApprovalDecision,
  options: { writeRejectionToStderr?: boolean } = {},
): void {
  const action = decision.accepted ? 'approve' : 'reject';
  switch (event) {
    case 'showBashPermission': {
      const data = payload as ProgressEventPayloads['showBashPermission'];
      void handleProgressViewBashApprovalAction({
        requestId: data.requestId,
        action,
        feedback: decision.userMessage,
      });
      return;
    }
    case 'showPlanApproval': {
      const data = payload as ProgressEventPayloads['showPlanApproval'];
      resolvePlanApproval(data.approvalId, {
        action,
        ...(decision.userMessage ? { feedback: decision.userMessage } : {}),
      });
      return;
    }
    case 'showAgentProposal': {
      const data = payload as ProgressEventPayloads['showAgentProposal'];
      resolveProposal(data.proposalId, {
        action,
        ...(decision.userMessage ? { feedback: decision.userMessage } : {}),
      });
      return;
    }
    case 'showRetryRequest': {
      const data = payload as ProgressEventPayloads['showRetryRequest'];
      if (decision.accepted) {
        triggerRetry(data.streamId);
        return;
      }
      if (options.writeRejectionToStderr) {
        const summary = summarizeApprovalEvent(event, payload);
        writeTextStderr(
          decision.userMessage
            ? `${summary}\n${decision.userMessage}`
            : summary,
        );
      }
      cancelRetry(data.streamId);
      return;
    }
    default: {
      const never: never = event;
      return never;
    }
  }
}

function handleExternalInquiry(
  payload: ProgressEventPayloads['showExternalInquiry'],
  context: CliContext,
): void {
  const threadId = payload.threadId;
  if (!threadId) {
    // No persistent thread to address — pre-async legacy payload. Ignore.
    return;
  }

  if (!approvalPromptAllowed(context)) {
    const feedback =
      context.approvalPolicy === 'yolo'
        ? 'External inquiry requires human input; yolo mode cannot synthesize an external answer.'
        : denyMessage(context.approvalPolicy);
    if (context.approvalPolicy !== 'yolo') markApprovalDenied(context);
    void handleExternalInquiryAction({ action: 'drop', threadId, feedback });
    return;
  }

  void (async () => {
    let answer: string;
    try {
      answer = await enqueueCliPrompt(context, () =>
        askCliApprovalQuestion(context, {
          kind: 'externalInquiry',
          summary: `External inquiry requested:\n${payload.question}`,
          prompt: 'Answer (blank to skip): ',
        }),
      );
    } catch {
      markApprovalDenied(context);
      await handleExternalInquiryAction({
        action: 'drop',
        threadId,
        feedback: 'CLI external inquiry prompt failed.',
      });
      return;
    }

    const trimmed = answer.trim();
    if (trimmed.length === 0) {
      await handleExternalInquiryAction({
        action: 'drop',
        threadId,
        feedback: 'External inquiry skipped by user.',
      });
      return;
    }
    await handleExternalInquiryAction({
      action: 'submit',
      threadId,
      answer: trimmed,
    });
  })();
}

function formatUserQuestionPrompt(
  payload: ProgressEventPayloads['showUserQuestion'],
): string {
  return payload.questions
    .map((question, index) => {
      const options = question.options
        .map((option, optionIndex) => {
          const description = option.description
            ? ` - ${option.description}`
            : '';
          return `  ${optionIndex + 1}. ${option.label}${description}`;
        })
        .join('\n');
      const multi = question.multiSelect
        ? ' Select comma-separated numbers.'
        : '';
      const free = question.allowFreeText ? ' Or type a custom answer.' : '';
      return `${index + 1}. ${question.question}\n${options}\n${multi}${free}`;
    })
    .join('\n\n');
}

function handleUserQuestion(
  payload: ProgressEventPayloads['showUserQuestion'],
  context: CliContext,
): void {
  if (!approvalPromptAllowed(context)) {
    const feedback =
      context.approvalPolicy === 'yolo'
        ? 'User question requires human input; yolo mode cannot synthesize an answer.'
        : denyMessage(context.approvalPolicy);
    if (context.approvalPolicy !== 'yolo') markApprovalDenied(context);
    void handleUserQuestionAction({
      requestId: payload.requestId,
      action: 'skip',
      feedback,
    });
    return;
  }

  void (async () => {
    const answers: Record<string, string | string[]> = {};
    try {
      for (const question of payload.questions) {
        const answer = await enqueueCliPrompt(context, () =>
          askCliApprovalQuestion(context, {
            kind: 'approval',
            summary: payload.context
              ? `${payload.context}\n\n${formatUserQuestionPrompt({
                  ...payload,
                  questions: [question],
                })}`
              : formatUserQuestionPrompt({ ...payload, questions: [question] }),
            prompt: 'Answer (blank to skip): ',
          }),
        );
        const parsed = parseUserQuestionAnswer(answer, question);
        if (parsed != null) answers[question.question] = parsed;
      }
    } catch {
      markApprovalDenied(context);
      await handleUserQuestionAction({
        requestId: payload.requestId,
        action: 'skip',
        feedback: 'CLI user question prompt failed.',
      });
      return;
    }

    const submitted = Object.keys(answers).length > 0;
    await handleUserQuestionAction({
      requestId: payload.requestId,
      action: submitted ? 'submit' : 'skip',
      answers: submitted ? answers : undefined,
      feedback: submitted ? undefined : 'User question skipped by user.',
    });
  })();
}

async function decideToolEdit(
  request: ToolEditApprovalRequest,
  context: CliContext,
): Promise<ToolEditApprovalResult> {
  const summary = `Tool edit requested by ${request.sourceTool}: ${request.path}`;
  const immediate = immediateDecision(context);
  const decision = immediate ?? (await askApproval(context, summary));
  return decision.accepted
    ? { accepted: true, appliedContent: request.proposedContent }
    : { accepted: false, userMessage: decision.userMessage };
}

export function installCliApprovalHandlers(context: CliContext): void {
  setToolEditApprovalHandler((request) => decideToolEdit(request, context));
}

export function handleCliApprovalEvent<K extends keyof ProgressEventPayloads>(
  event: K,
  payload: ProgressEventPayloads[K],
  context: CliContext,
): boolean {
  if (event === 'showExternalInquiry') {
    handleExternalInquiry(
      payload as ProgressEventPayloads['showExternalInquiry'],
      context,
    );
    return true;
  }

  if (event === 'showUserQuestion') {
    handleUserQuestion(
      payload as ProgressEventPayloads['showUserQuestion'],
      context,
    );
    return true;
  }

  if (!isApprovalEvent(event)) return false;

  const approvalPayload = payload as ProgressEventPayloads[typeof event];
  const immediate = immediateDecision(context);
  if (immediate) {
    dispatchApprovalDecision(event, approvalPayload, immediate);
    return true;
  }

  void (async () => {
    const decision = await askApproval(
      context,
      summarizeApprovalEvent(event, approvalPayload),
    );
    dispatchApprovalDecision(event, approvalPayload, decision, {
      writeRejectionToStderr: true,
    });
  })();
  return true;
}

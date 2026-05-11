// Local imports - runtime
import {
  cancelRetry,
  resolvePlanApproval,
  resolveProposal,
  triggerRetry,
} from '@agent/runtime/runCoordinators';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

// Local imports - tools
import { handleProgressViewBashApprovalAction } from '@tools/approval/bashApproval';
import {
  setToolEditApprovalHandler,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { handleExternalInquiryAction } from '@tools/inquiry/ExternalInquiryTool';

// Local imports - CLI runtime
import { askCliQuestion, type CliContext } from './cliContext';

function denyMessage(policy: CliContext['approvalPolicy']): string {
  return policy === 'ask'
    ? 'Interactive approval requires a TTY; this CLI run is headless.'
    : 'Denied by CLI approval policy.';
}

function externalInquiryMessage(policy: CliContext['approvalPolicy']): string {
  if (policy === 'yolo') {
    return 'External inquiry requires human input; yolo mode cannot synthesize an external answer.';
  }
  return denyMessage(policy);
}

const deniedApprovalContexts = new WeakSet<CliContext>();
const cliPromptQueues = new WeakMap<CliContext, Promise<unknown>>();

function markApprovalDenied(context: CliContext): void {
  deniedApprovalContexts.add(context);
}

export function hasCliApprovalDenied(context: CliContext): boolean {
  return deniedApprovalContexts.has(context);
}

function approvalPromptAllowed(context: CliContext): boolean {
  return context.approvalPolicy === 'ask' && context.mode === 'interactive';
}

function parseApprovalAnswer(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
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

async function askApproval(
  context: CliContext,
  summary: string,
): Promise<{
  accepted: boolean;
  userMessage?: string;
}> {
  if (context.approvalPolicy === 'yolo') return { accepted: true };
  if (!approvalPromptAllowed(context)) {
    markApprovalDenied(context);
    return {
      accepted: false,
      userMessage: denyMessage(context.approvalPolicy),
    };
  }

  let answer: string;
  try {
    answer = await enqueueCliPrompt(context, () =>
      askCliQuestion(`${summary}\nApprove? [y/N] `),
    );
  } catch {
    markApprovalDenied(context);
    return { accepted: false, userMessage: 'CLI approval prompt failed.' };
  }

  const accepted = parseApprovalAnswer(answer);
  if (!accepted) markApprovalDenied(context);
  return {
    accepted,
    userMessage: accepted ? undefined : 'Rejected from CLI approval prompt.',
  };
}

async function askExternalInquiry(
  context: CliContext,
  question: string,
): Promise<
  { submitted: true; answer: string } | { submitted: false; feedback: string }
> {
  if (context.approvalPolicy === 'yolo') {
    return { submitted: false, feedback: externalInquiryMessage('yolo') };
  }
  if (!approvalPromptAllowed(context)) {
    markApprovalDenied(context);
    return {
      submitted: false,
      feedback: denyMessage(context.approvalPolicy),
    };
  }

  let answer: string;
  try {
    answer = await enqueueCliPrompt(context, () =>
      askCliQuestion(
        `External inquiry requested:\n${question}\nAnswer (blank to skip): `,
      ),
    );
  } catch {
    markApprovalDenied(context);
    return {
      submitted: false,
      feedback: 'CLI external inquiry prompt failed.',
    };
  }

  if (answer.trim().length === 0) {
    return { submitted: false, feedback: 'External inquiry skipped by user.' };
  }
  return { submitted: true, answer };
}

async function decideToolEdit(
  request: ToolEditApprovalRequest,
  context: CliContext,
): Promise<ToolEditApprovalResult> {
  const decision = await askApproval(
    context,
    `Tool edit requested by ${request.sourceTool}: ${request.path}`,
  );
  return decision.accepted
    ? { accepted: true, appliedContent: request.proposedContent }
    : { accepted: false, userMessage: decision.userMessage };
}

export function installCliApprovalHandlers(context: CliContext): void {
  setToolEditApprovalHandler((request) => decideToolEdit(request, context));
}

async function handleCliApprovalEventAsync<
  K extends keyof ProgressEventPayloads,
>(
  event: K,
  payload: ProgressEventPayloads[K],
  context: CliContext,
): Promise<void> {
  switch (event) {
    case 'showBashPermission': {
      const data = payload as ProgressEventPayloads['showBashPermission'];
      const decision = await askApproval(
        context,
        `Bash command requested:\n${data.command}`,
      );
      await handleProgressViewBashApprovalAction({
        requestId: data.requestId,
        action: decision.accepted ? 'approve' : 'reject',
        feedback: decision.userMessage,
      });
      return;
    }
    case 'showPlanApproval': {
      const data = payload as ProgressEventPayloads['showPlanApproval'];
      const decision = await askApproval(
        context,
        `Plan approval requested:\n${JSON.stringify(data.plan, null, 2)}`,
      );
      resolvePlanApproval(data.approvalId, {
        action: decision.accepted ? 'approve' : 'reject',
        ...(decision.userMessage ? { feedback: decision.userMessage } : {}),
      });
      return;
    }
    case 'showAgentProposal': {
      const data = payload as ProgressEventPayloads['showAgentProposal'];
      const decision = await askApproval(
        context,
        `Agent proposal requested:\n${JSON.stringify(data, null, 2)}`,
      );
      resolveProposal(data.proposalId, {
        action: decision.accepted ? 'approve' : 'reject',
        ...(decision.userMessage ? { feedback: decision.userMessage } : {}),
      });
      return;
    }
    case 'showRetryRequest': {
      const data = payload as ProgressEventPayloads['showRetryRequest'];
      const decision = await askApproval(
        context,
        `Retry requested for ${data.operation}: ${data.errorMessage ?? 'unknown error'}`,
      );
      if (decision.accepted) {
        triggerRetry(data.streamId);
      } else {
        cancelRetry(data.streamId);
      }
      return;
    }
    case 'showExternalInquiry': {
      const data = payload as ProgressEventPayloads['showExternalInquiry'];
      const answer = await askExternalInquiry(context, data.question);
      await handleExternalInquiryAction({
        requestId: data.requestId,
        action: answer.submitted ? 'submit' : 'skip',
        answer: answer.submitted ? answer.answer : undefined,
        feedback: answer.submitted ? undefined : answer.feedback,
      });
      return;
    }
    default:
      return;
  }
}

function immediateApprovalDecision(context: CliContext):
  | {
      accepted: boolean;
      userMessage?: string;
    }
  | undefined {
  if (context.approvalPolicy === 'yolo') return { accepted: true };
  if (approvalPromptAllowed(context)) return undefined;
  markApprovalDenied(context);
  return {
    accepted: false,
    userMessage: denyMessage(context.approvalPolicy),
  };
}

function handleImmediateCliApprovalEvent<K extends keyof ProgressEventPayloads>(
  event: K,
  payload: ProgressEventPayloads[K],
  context: CliContext,
): boolean {
  if (event === 'showExternalInquiry') {
    if (approvalPromptAllowed(context)) return false;
    const data = payload as ProgressEventPayloads['showExternalInquiry'];
    const feedback = externalInquiryMessage(context.approvalPolicy);
    if (context.approvalPolicy !== 'yolo') markApprovalDenied(context);
    void handleExternalInquiryAction({
      requestId: data.requestId,
      action: 'skip',
      feedback,
    });
    return true;
  }

  const decision = immediateApprovalDecision(context);
  if (!decision) return false;

  switch (event) {
    case 'showBashPermission': {
      const data = payload as ProgressEventPayloads['showBashPermission'];
      void handleProgressViewBashApprovalAction({
        requestId: data.requestId,
        action: decision.accepted ? 'approve' : 'reject',
        feedback: decision.userMessage,
      });
      return true;
    }
    case 'showPlanApproval': {
      const data = payload as ProgressEventPayloads['showPlanApproval'];
      resolvePlanApproval(data.approvalId, {
        action: decision.accepted ? 'approve' : 'reject',
        ...(decision.userMessage ? { feedback: decision.userMessage } : {}),
      });
      return true;
    }
    case 'showAgentProposal': {
      const data = payload as ProgressEventPayloads['showAgentProposal'];
      resolveProposal(data.proposalId, {
        action: decision.accepted ? 'approve' : 'reject',
        ...(decision.userMessage ? { feedback: decision.userMessage } : {}),
      });
      return true;
    }
    case 'showRetryRequest': {
      const data = payload as ProgressEventPayloads['showRetryRequest'];
      if (decision.accepted) {
        triggerRetry(data.streamId);
      } else {
        cancelRetry(data.streamId);
      }
      return true;
    }
    default:
      return false;
  }
}

export function handleCliApprovalEvent<K extends keyof ProgressEventPayloads>(
  event: K,
  payload: ProgressEventPayloads[K],
  context: CliContext,
): boolean {
  switch (event) {
    case 'showBashPermission':
    case 'showPlanApproval':
    case 'showAgentProposal':
    case 'showRetryRequest':
    case 'showExternalInquiry':
      if (handleImmediateCliApprovalEvent(event, payload, context)) {
        return true;
      }
      void handleCliApprovalEventAsync(event, payload, context);
      return true;
    default:
      return false;
  }
}

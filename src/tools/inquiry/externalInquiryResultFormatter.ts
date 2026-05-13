// Local imports - agent storage
import { getExecutionStore } from '@agent/storage';

// Local imports - tool types
import type { ToolResult } from '@tools/result';

// Local imports - inquiry storage
import type {
  ExternalInquiryThreadManifest,
  PersistedExternalInquiryTurn,
} from './externalInquiryStorage';

const EXTERNAL_INQUIRY_REPORT_THRESHOLD = 20_000;
const EXTERNAL_INQUIRY_PREVIEW_LENGTH = 2_000;

function toCurrentExecutionPath(path: string, executionId?: string): string {
  if (!executionId) return path;
  const prefix = `/executions/${executionId}/`;
  return path.startsWith(prefix)
    ? `/executions/current/${path.slice(prefix.length)}`
    : path;
}

function currentManifestPath(
  persisted: PersistedExternalInquiryTurn,
): string | undefined {
  const mirror = persisted.executionMirrorPaths;
  if (!mirror) return undefined;
  return toCurrentExecutionPath(mirror.manifestPath, mirror.executionId);
}

function appendManifestHint(lines: string[], manifestPath?: string): void {
  if (!manifestPath) return;
  lines.push(
    '',
    `Thread manifest: ${manifestPath}`,
    `Use the executions tool with path=${manifestPath} to inspect mirrored files.`,
  );
}

function appendSessionLinks(
  lines: string[],
  sessionLinks?: string[],
  heading = 'External session links:',
): void {
  if (!sessionLinks?.length) return;
  lines.push('', heading, ...sessionLinks.map((link) => `- ${link}`));
}

function appendContinuationGuidance(
  lines: string[],
  persisted: PersistedExternalInquiryTurn,
  knownSessionLinks: string[] | undefined,
): void {
  const { threadId } = persisted;
  const hasSessionLinks = (knownSessionLinks?.length ?? 0) > 0;

  lines.push(
    '',
    `Use thread_id=${threadId} to continue this external inquiry thread.`,
  );

  if (hasSessionLinks) {
    lines.push(
      'For follow-up inquiries, pass that thread_id so the user is shown the known external session links and can continue the same external conversation.',
    );
    return;
  }

  lines.push(
    'Ask the user to paste the external chat URL when they submit an answer so later follow-ups can return to the same external conversation.',
  );
}

export function collectKnownSessionLinks(
  manifest: ExternalInquiryThreadManifest | null | undefined,
): string[] | undefined {
  if (!manifest) return undefined;

  const known: string[] = [];
  const seen = new Set<string>();

  for (const turn of [...manifest.turns].reverse()) {
    for (const link of turn.sessionLinks ?? []) {
      if (seen.has(link)) continue;
      seen.add(link);
      known.push(link);
    }
  }

  return known.length ? known : undefined;
}

function getKnownSessionLinks(
  persisted: PersistedExternalInquiryTurn,
): string[] | undefined {
  return collectKnownSessionLinks(persisted.manifest);
}

export function buildRejectedExternalInquiryResult(
  feedback?: string,
): ToolResult {
  const trimmedFeedback = feedback?.trim();
  return {
    summary: trimmedFeedback
      ? 'User rejected external inquiry with feedback'
      : 'User rejected external inquiry',
    output: trimmedFeedback
      ? `The user rejected this external inquiry and provided feedback:\n\n${trimmedFeedback}\n\nRevise the question or try a different approach.`
      : 'The user rejected this external inquiry. Revise the question or try a different approach.',
  };
}

function buildExternalInquiryOutput(
  persisted: PersistedExternalInquiryTurn,
  answer: string,
): string {
  const lines = [
    `Thread ID: ${persisted.threadId}`,
    `Turn: ${persisted.turn.turnIndex}`,
    'Answer from external model:',
    '',
    answer,
  ];

  const knownSessionLinks = getKnownSessionLinks(persisted);
  appendContinuationGuidance(lines, persisted, knownSessionLinks);
  appendSessionLinks(lines, knownSessionLinks);
  appendManifestHint(lines, currentManifestPath(persisted));

  return lines.join('\n');
}

function buildExternalInquiryReport(
  persisted: PersistedExternalInquiryTurn,
  answer: string,
): string {
  const lines = [
    'External inquiry result',
    `Thread ID: ${persisted.threadId}`,
    `Turn: ${persisted.turn.turnIndex}`,
    `Timestamp: ${persisted.turn.timestamp}`,
    ...(persisted.turn.context ? [`Context: ${persisted.turn.context}`] : []),
    '',
    'Question:',
    persisted.turn.question,
    '',
    'Answer:',
    answer,
  ];

  appendSessionLinks(lines, persisted.turn.sessionLinks ?? undefined);

  const mirror = persisted.executionMirrorPaths;
  if (mirror) {
    lines.push(
      '',
      'Mirrored execution files:',
      `- Manifest: ${mirror.manifestPath}`,
      `- Question: ${mirror.questionPath}`,
      ...(mirror.contextPath ? [`- Context: ${mirror.contextPath}`] : []),
      `- Answer: ${mirror.answerPath}`,
    );
  }

  return lines.join('\n');
}

const reportLocks = new Map<string, Promise<void>>();

export async function appendExternalInquiryReport(params: {
  executionId: string;
  persisted: PersistedExternalInquiryTurn;
  answer: string;
}): Promise<void> {
  const prev = reportLocks.get(params.executionId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  reportLocks.set(params.executionId, next);

  await prev;
  try {
    const store = getExecutionStore(params.executionId);
    const existing = await store.readReport();
    const nextSection = buildExternalInquiryReport(
      params.persisted,
      params.answer,
    );
    const separator = '\n\n' + '='.repeat(80) + '\n\n';
    await store.writeReport(
      existing?.trim() ? `${existing}${separator}${nextSection}` : nextSection,
    );
  } finally {
    release();
    if (reportLocks.get(params.executionId) === next) {
      reportLocks.delete(params.executionId);
    }
  }
}

export function buildExternalInquiryResult(params: {
  persisted: PersistedExternalInquiryTurn;
  answer: string;
  includeLongAnswerRedirect: boolean;
}): ToolResult {
  if (
    params.includeLongAnswerRedirect &&
    params.answer.length > EXTERNAL_INQUIRY_REPORT_THRESHOLD
  ) {
    const preview = params.answer.slice(0, EXTERNAL_INQUIRY_PREVIEW_LENGTH);
    const lines = [
      'The external model returned a long answer.',
      `Thread ID: ${params.persisted.threadId}`,
      'The full answer has been saved to /executions/current/report.',
      'Use the executions tool with path=/executions/current/report to inspect it.',
    ];

    const knownSessionLinks = getKnownSessionLinks(params.persisted);
    appendContinuationGuidance(lines, params.persisted, knownSessionLinks);
    appendSessionLinks(lines, knownSessionLinks);
    appendManifestHint(lines, currentManifestPath(params.persisted));

    if (preview) {
      lines.push('', `Preview:\n\n${preview}`);
    }

    return {
      summary: 'Received long answer from external model',
      output: lines.join('\n'),
    };
  }

  return {
    summary: 'Received answer from external model',
    output: buildExternalInquiryOutput(params.persisted, params.answer),
  };
}

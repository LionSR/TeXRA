/**
 * The script stage as every host shows it: the calls a `script` call issued,
 * read from their cards (the tool rows under the script's `script` stage)
 * and, for an `agent` call, from the child run its card launched
 * (`RunView.parentCard`). One model for the progress view, the terminal
 * popup and headless `texra run`; a host only decides how a row looks.
 *
 * Nothing here is a fact of its own: a status is the card's, read with its
 * settlement (`reusedFrom`, a `Skipped` error) and whether a child exists;
 * a row's agent, model, files and attempt are its input's and its card's;
 * its duration and cost are its child's rows.
 */
import {
  TOOL_CALL_STATUS,
  type PermissionPayload,
  type RunId,
  type TaskGroup,
} from '@shared/schemas';
import type { RunView, SessionView } from '@shared/session/sessionView';
import { formatWorkflowCallFiles } from '@ui/copy/workflowCall';
import { assertNever, getBasename, isObject } from '@utils/core';
import { formatCompactDuration, formatCostUsd } from '@utils/text/stringUtils';

import type { ToolRow, TranscriptRow } from './transcriptRow';

/** What a card the run's end failed while it was open says: the call never
 *  settled, so nothing records how it ended. */
export const TOOL_CUT_BY_RUN_END = 'The run ended before this tool completed.';

const AGENT_TOOL = 'agent';

export type ScriptCallStatus =
  | 'queued'
  | 'running'
  | 'interrupted'
  | 'finished'
  | 'reused'
  | 'skipped'
  | 'cancelled'
  | 'failed'
  | 'not run';

export const SCRIPT_CALL_STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  interrupted: 'Interrupted',
  finished: 'Finished',
  reused: 'Reused',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
  failed: 'Failed',
  'not run': 'Not run',
} as const satisfies Record<ScriptCallStatus, string>;

/** The sections a phase leads with, in this order; quiet rows follow. */
export type ScriptSection = 'waiting' | 'failed' | 'running';
export const SCRIPT_SECTION_LABEL = {
  waiting: 'Needs a decision',
  failed: 'Failed',
  running: 'Running',
} as const satisfies Record<ScriptSection, string>;
const SECTION_ORDER: readonly ScriptSection[] = [
  'waiting',
  'failed',
  'running',
];

const NOT_RUN_NOTE = 'The run ended before this call started.';
const INTERRUPTED_NOTE = 'Stopped with its run. Resume the run to continue.';

export interface ScriptCallView {
  /** The card's id (`logId`). */
  readonly id: string;
  readonly toolName: string;
  /** An `agent` call's label or agent; any other call's tool and preview. */
  readonly label: string;
  readonly status: ScriptCallStatus;
  readonly phase: string | null;
  /** `drafter · gpt-5 · attempt 2 · a.tex · 1m 12s · $0.31` */
  readonly facts: readonly string[];
  readonly detail?: { readonly kind: 'error' | 'note'; readonly text: string };
  /** The child run an `agent` call launched: the row opens it. */
  readonly childRunId?: RunId;
  /** The run under the call waiting on the user: Review opens it. */
  readonly askingRunId?: RunId;
  readonly section?: ScriptSection;
  /** `Running: drafter · gpt-5 — Wants bash: make` */
  readonly line: string;
}

interface ScriptPhaseView {
  /** The guest's `phase()` title; null before its first. */
  readonly title: string | null;
  /** Attention first (`SECTION_ORDER`), then the quiet rows in issue order
   *  under a null section. */
  readonly sections: readonly {
    readonly section: ScriptSection | null;
    readonly calls: readonly ScriptCallView[];
  }[];
}

export interface ScriptStageView {
  /** The stage's id; its calls' cards carry it as their group. */
  readonly id: string;
  readonly status: TaskGroup['status'];
  /** Every call, in issue order. */
  readonly calls: readonly ScriptCallView[];
  readonly phases: readonly ScriptPhaseView[];
  /** What every child its calls launched has cost so far, discarded
   *  attempts included. */
  readonly costUsd: number;
}

/** What a waiting run asks for, in one line. */
function pendingRequestLine(payload: PermissionPayload): string {
  switch (payload.kind) {
    case 'bash':
      return `Wants bash: ${payload.data.command}`;
    case 'toolEdit':
      return `Wants edit: ${payload.data.relativePath}`;
    case 'retry':
      return `Wants retry: ${payload.data.operation}`;
    case 'proposal':
      return 'Wants approval for a proposal';
    case 'planApproval':
      return 'Wants approval for a plan';
    case 'externalInquiry':
      return 'Wants an answer to an inquiry';
    case 'userQuestion':
      return 'Wants an answer to a question';
    default:
      return assertNever(payload, 'Unhandled request kind');
  }
}

type StageSession = Pick<SessionView, 'runs' | 'requests'>;

/** The run under `run` that is asking: itself, else the first descendant
 *  the fold marked, following `descendant` down. */
function askingRun(view: StageSession, run: RunView): RunView | undefined {
  if (run.approval === 'own') return run;
  if (run.approval !== 'descendant') return undefined;
  for (const childId of run.childIds) {
    const child = view.runs.get(childId);
    const asking = child === undefined ? undefined : askingRun(view, child);
    if (asking) return asking;
  }
  return undefined;
}

const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;
const namesOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry) =>
        typeof entry === 'string' ? [getBasename(entry)] : [],
      )
    : [];

function statusOf(
  row: ToolRow,
  agent: boolean,
  child: RunView | undefined,
  interrupted: boolean,
): ScriptCallStatus {
  const output = isObject(row.log.output) ? row.log.output : {};
  switch (row.toolUse.status) {
    case TOOL_CALL_STATUS.COMPLETED:
      return stringOf(output.reusedFrom) === undefined ? 'finished' : 'reused';
    case TOOL_CALL_STATUS.FAILED:
      if (output.name === 'Skipped') return 'skipped';
      if (row.toolUse.errorText === TOOL_CUT_BY_RUN_END)
        return agent && child === undefined ? 'not run' : 'cancelled';
      return 'failed';
    default:
      // Nothing works on an open call of a run whose process died: it waits
      // for Resume, which reissues it.
      if (interrupted) return 'interrupted';
      // An `agent` call waits for its turn under the child-run budget (or
      // for its script's request) until its child starts.
      return agent && child === undefined ? 'queued' : 'running';
  }
}

function callView(
  row: ToolRow,
  run: RunView,
  view: StageSession,
): ScriptCallView {
  const agent = row.toolUse.toolName === AGENT_TOOL;
  const input = isObject(row.toolUse.input) ? row.toolUse.input : {};
  // The newest child this card launched: a re-run attempt launches its own.
  const child = run.childIds
    .map((id) => view.runs.get(id))
    .findLast((candidate) => candidate?.parentCard === row.id);
  const status = statusOf(row, agent, child, run.group === 'interrupted');
  const asking = child === undefined ? undefined : askingRun(view, child);
  const request =
    asking === undefined
      ? undefined
      : view.requests.find((entry) => entry.runId === asking.id);
  // What the call took and cost, once it and its child have ended: the
  // child's own live view carries the running figures.
  const ended =
    status !== 'running' && status !== 'queued' && child?.durableOutcome != null
      ? child
      : undefined;
  const facts = [
    agent ? stringOf(input.agentName) : undefined,
    agent ? (child?.modelLabel ?? stringOf(input.model)) : undefined,
    row.attempt === undefined ? undefined : `attempt ${row.attempt}`,
    agent
      ? formatWorkflowCallFiles({
          input: namesOf(input.inputFiles),
          context: namesOf(input.contextFiles),
          media: namesOf(input.mediaFiles),
        })
      : undefined,
    ended !== undefined && ended.lastTimestamp !== null
      ? formatCompactDuration(ended.lastTimestamp - ended.launchedAt)
      : undefined,
    ended !== undefined && ended.usage.cost > 0
      ? formatCostUsd(ended.usage.cost)
      : undefined,
  ].filter((part): part is string => part !== undefined);
  const label = agent
    ? (stringOf(input.label) ?? stringOf(input.agentName) ?? AGENT_TOOL)
    : [row.model.headerLabel, row.model.headerPreview]
        .filter((part) => part.length > 0)
        .join(' ');
  let detail: ScriptCallView['detail'];
  if (request !== undefined)
    detail = { kind: 'note', text: pendingRequestLine(request.payload) };
  else if (status === 'failed')
    detail = { kind: 'error', text: row.toolUse.errorText };
  else if (status === 'not run') detail = { kind: 'note', text: NOT_RUN_NOTE };
  else if (status === 'interrupted')
    detail = { kind: 'note', text: INTERRUPTED_NOTE };
  let section: ScriptSection | undefined;
  if (request !== undefined) section = 'waiting';
  else if (status === 'failed' || status === 'running') section = status;
  const suffix = facts.length > 0 ? ` · ${facts.join(' · ')}` : '';
  return {
    id: row.id,
    toolName: row.toolUse.toolName,
    label,
    status,
    phase: row.phase ?? null,
    facts,
    ...(detail !== undefined && detail.text.length > 0 ? { detail } : {}),
    ...(child !== undefined ? { childRunId: child.id } : {}),
    ...(asking !== undefined ? { askingRunId: asking.id } : {}),
    ...(section !== undefined ? { section } : {}),
    line: `${SCRIPT_CALL_STATUS_LABEL[status]}: ${label}${suffix}${detail ? ` — ${detail.text}` : ''}`,
  };
}

function phasesOf(calls: readonly ScriptCallView[]): ScriptPhaseView[] {
  const byPhase = Map.groupBy(calls, (call) => call.phase);
  return [...byPhase].map(([title, members]) => ({
    title,
    sections: [
      ...SECTION_ORDER.map((section) => ({
        section,
        calls: members.filter((call) => call.section === section),
      })),
      {
        section: null,
        calls: members.filter((call) => call.section === undefined),
      },
    ].filter((group) => group.calls.length > 0),
  }));
}

/**
 * The runs `run` launched that are not a script's calls: what its dispatch
 * card lists (a direct `agent` call that detached, a background script's
 * run). A child whose card (`parentCard`) sits under a script stage, awaited
 * or sent to the background, has its one home in that stage's rows.
 */
export function dispatchedChildren(
  run: RunView,
  view: Pick<SessionView, 'runs'>,
): RunView[] {
  const { taskGroups, rows } = run.transcript;
  const stageIds = new Set(
    taskGroups
      .filter((group) => group.kind === 'script')
      .map((group) => group.id),
  );
  const scriptCards = new Set(
    rows.flatMap((row) =>
      row.kind === 'tool' &&
      row.groupId !== undefined &&
      stageIds.has(row.groupId)
        ? [row.id]
        : [],
    ),
  );
  return run.childIds.flatMap((id) => {
    const child = view.runs.get(id);
    return child === undefined ||
      (child.parentCard !== null && scriptCards.has(child.parentCard))
      ? []
      : [child];
  });
}

/**
 * The script stages of a run's transcript, oldest first: one per `script`
 * call that issued a call, its calls in issue order (first appearance) and
 * grouped by phase.
 */
export function scriptStages(
  run: RunView,
  view: StageSession,
): ScriptStageView[] {
  const { taskGroups, rows } = run.transcript;
  const stages = taskGroups.filter((group) => group.kind === 'script');
  if (stages.length === 0) return [];
  const byStage = Map.groupBy(
    rows.filter(
      (row: TranscriptRow): row is ToolRow =>
        row.kind === 'tool' && row.groupId !== undefined,
    ),
    (row) => row.groupId!,
  );
  return stages.map((stage) => {
    const calls = (byStage.get(stage.id) ?? [])
      .toSorted((a, b) => (a.seqNo ?? 0) - (b.seqNo ?? 0))
      .map((row) => callView(row, run, view));
    const cards = new Set(calls.map((call) => call.id));
    let costUsd = 0;
    for (const childId of run.childIds) {
      const child = view.runs.get(childId);
      if (child?.parentCard != null && cards.has(child.parentCard))
        costUsd += child.usage.cost;
    }
    return {
      id: stage.id,
      status: stage.status,
      calls,
      phases: phasesOf(calls),
      costUsd,
    };
  });
}

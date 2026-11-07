import * as path from 'node:path';

import { Effect } from 'effect';

import {
  toErrorMessage,
  isRunId,
  isTaskConfig,
  type RunId,
  type RunOutcome,
  serializeFilteredConfig,
} from '@texra-ai/harness/schemas';
import type {
  AgentRunListingEntry,
  RunResult,
  Session,
} from '@texra-ai/harness';
import {
  listRunGeneratedFiles,
  type RunGeneratedFile,
} from '@texra-ai/harness/host';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import { loadChatExportInput } from '@texra/agent/export/loadChatExportInput';
import type { ChatExportInput } from '@texra/agent/export/schemas';
import {
  runStatus,
  runStatusLabel,
  type RunStatusKey,
} from '@ui/copy/runStatus';

import {
  formatCliHistoryAgentLabel,
  formatCliHistorySubject,
} from './historyLabels';
import {
  createConversationPreview,
  createConversationTranscript,
  formatConversationPreview,
  formatConversationTranscript,
} from './history/conversationFormat';
import type { RunView, AgentConfig } from '@texra-ai/harness/schemas';

/** A run's generated files and its edited workspace files render alike.
 *  First group wins on a path collision; generated output precedes workspace. */
function mergeHistoryFiles(
  ...fileGroups: readonly (readonly RunGeneratedFile[])[]
): RunGeneratedFile[] {
  const files = new Map<string, RunGeneratedFile>();
  for (const group of fileGroups) {
    for (const file of group) {
      if (!files.has(file.path)) files.set(file.path, file);
    }
  }
  return [...files.values()].toSorted((a, b) => a.path.localeCompare(b.path));
}

export interface CliHistoryEntry {
  readonly id: RunId;
  readonly timestamp: string;
  readonly agent: string;
  readonly model: string;
  /** The run's durable outcome (its `run.end`); null while none has
   *  landed, as for a run its process left interrupted. */
  readonly outcome: RunOutcome | null;
  /** `records(id).readResumable()`'s answer, the one `texra resume` acts on.
   *  Ownership and loadability are decided when the run is opened.
   *  Independent of `outcome`: a failed run can be resumable. */
  readonly resumable: boolean;
  /** The listing's cause when the run cannot resume in this build (its rows
   *  are unreadable, or an earlier build's); resume surfaces show it. */
  readonly resumeBlocked?: string;
  readonly inputBasename: string;
  /** A document task's run, or a chat. */
  readonly kind?: 'task' | 'chat';
  readonly description?: string;
  readonly teamId?: string;
}

interface CliHistoryDetails {
  readonly id: RunId;
  readonly outcome: RunOutcome | null;
  readonly resumable: boolean;
  /** The run's launch facts as the session view holds them, and how its
   *  status reads (`@ui/copy/runStatus`). */
  readonly run:
    | (Pick<RunView, 'launchedAt' | 'parentId' | 'description'> & {
        readonly statusKey: RunStatusKey;
      })
    | null;
  readonly config: AgentConfig | null;
  readonly result: RunResult | null;
  readonly report: string | null;
  readonly conversationPreview: CliHistoryConversationPreview | null;
  readonly conversation?: CliHistoryConversationPreview | null;
  readonly files: readonly RunGeneratedFile[];
  /** Whether the run's loop opened it: its rows hold a `run.position`. */
  readonly checkpointPresent: boolean;
  /** The model the run is on; `config.model` is its launch model. */
  readonly currentModel?: string;
}

export interface CliHistoryConversationPreview {
  readonly messageCount: number;
  readonly messages: readonly CliHistoryConversationPreviewMessage[];
}

export interface CliHistoryConversationPreviewMessage {
  readonly index: number;
  readonly role: string;
  readonly content: string;
  readonly truncated: boolean;
}

/** Rows the `/resume` form offers: the resumable runs, newest first, and
 *  beside them, with their cause, the runs this build cannot resume, so none
 *  vanishes unexplained. The cap is the resumable runs': a burst of blocked
 *  rows (say, after a format change) is bounded on its own and never pushes
 *  a selectable run off the list. Filtering and capping live together so a
 *  caller cannot honor one half of the rule. */
const RESUME_LIST_LIMIT = 50;
const BLOCKED_LIST_LIMIT = 10;

export function listResumableCliHistoryEntries<
  T extends Pick<CliHistoryEntry, 'resumable' | 'resumeBlocked'>,
>(entries: readonly T[]): T[] {
  const listed: T[] = [];
  let resumable = 0;
  let blocked = 0;
  for (const entry of entries) {
    if (resumable === RESUME_LIST_LIMIT) break;
    if (entry.resumable) {
      listed.push(entry);
      resumable += 1;
    } else if (
      entry.resumeBlocked !== undefined &&
      blocked < BLOCKED_LIST_LIMIT
    ) {
      listed.push(entry);
      blocked += 1;
    }
  }
  return listed;
}

export type CliHistoryDeleteResult =
  | {
      readonly deleted: 'all';
      readonly count: number;
      readonly active: readonly RunId[];
      readonly failed: readonly {
        readonly runId: RunId;
        readonly message: string;
      }[];
    }
  | {
      readonly deleted: 'one';
      readonly id: RunId;
      readonly found: boolean;
      readonly status: 'deleted' | 'not-found' | 'active';
    };

export function parseCliHistoryId(raw: string): RunId | undefined {
  return isRunId(raw) ? raw : undefined;
}

/** The history readers take the project's session
 *  (`CliPlatformServices.runSession`): this process's own, or the
 *  service's, whichever holds the runs. */
export const listCliHistoryEntries = Effect.fn('cli.listCliHistoryEntries')(
  function* (session: Session) {
    return (yield* session.listRuns()).map(toCliHistoryEntry);
  },
);

export const readCliHistoryDetails = Effect.fn('cli.readCliHistoryDetails')(
  function* (
    session: Session,
    storage: string,
    id: RunId,
    options: { includeFullConversation?: boolean } = {},
  ) {
    const records = session.records(id);
    const [
      config,
      view,
      result,
      report,
      conversation,
      workspaceFiles,
      checkpointPresent,
      generatedFiles,
    ] = yield* Effect.all(
      [
        records.readConfig(),
        session.view.read([id]),
        records.readResult(),
        records.readReport(),
        records.readConversation(),
        records.readWorkspaceFiles(),
        records.readResumable(),
        listRunGeneratedFiles(id, storage),
      ],
      { concurrency: 8 },
    );
    const run = view.runs.get(id);
    if (!run && !config && conversation.length === 0 && !checkpointPresent) {
      return null;
    }
    // The model the run is on, as the view derives it for the listing too.
    const currentModel = config ? (run?.model ?? undefined) : undefined;
    // A run with no config is corrupt: there is nothing to resume it under.
    const resumable = config !== null && checkpointPresent;
    const conversationPreview = createConversationPreview(conversation);
    const fullConversation = options.includeFullConversation
      ? createConversationTranscript(conversation)
      : undefined;
    const files = mergeHistoryFiles(
      generatedFiles,
      workspaceFiles.map((file) => ({
        path: `workspace/${file.path}`,
        size: file.size,
        isDirectory: file.isDirectory,
      })),
    );

    return {
      id,
      outcome: run?.outcome ?? null,
      resumable,
      run: run
        ? {
            launchedAt: run.launchedAt,
            parentId: run.parentId,
            description: run.description,
            statusKey: runStatus(run).key,
          }
        : null,
      config,
      result,
      report,
      conversationPreview,
      ...(options.includeFullConversation
        ? { conversation: fullConversation }
        : {}),
      files,
      checkpointPresent,
      currentModel,
    } satisfies CliHistoryDetails;
  },
);

/** Outcome of loading a stored run's export input (see {@link readCliHistoryExportInput}). */
type CliHistoryExportInputResult =
  | { readonly status: 'ok'; readonly exportInput: ChatExportInput }
  /** No trace of this run at all — matches `history show`'s notion of "not found". */
  | { readonly status: 'not_found' }
  /** The run exists (has meta and/or config) but is missing what an
   *  export needs (config and/or conversation) — a different failure than
   *  "not found", so it gets a different message. */
  | { readonly status: 'incomplete' };

/**
 * Load a stored run's config + conversation as the format-agnostic {@link
 * ChatExportInput} the markdown export formatter consumes (the HTML export path
 * uses `assembleTrace` instead — see `commands/history.ts`). Thin CLI-specific
 * wrapper around the shared {@link loadChatExportInput} loader, which also
 * backs the progress-view `writeTranscript` operation — so the CLI
 * and GUI render the same conversation identically.
 *
 * Distinguishes "this run id has no stored data at all" (`not_found`
 * — the same case `history show` reports as not found) from "this run
 * exists but has nothing to export" (`incomplete` — e.g. `history show`
 * would still display it, just without a conversation to render). Reporting
 * both as "not found" would mislead a caller whose id is valid but whose
 * run simply never produced a conversation.
 */
export const readCliHistoryExportInput = Effect.fn(
  'cli.readCliHistoryExportInput',
)(function* (session: Session, id: RunId) {
  const [exists, { config, exportInput }] = yield* Effect.all(
    [session.records(id).exists(), loadChatExportInput(id, session)],
    { concurrency: 2 },
  );
  if (exportInput)
    return { status: 'ok', exportInput } satisfies CliHistoryExportInputResult;
  if (!exists && !config) {
    return { status: 'not_found' } satisfies CliHistoryExportInputResult;
  }
  return { status: 'incomplete' } satisfies CliHistoryExportInputResult;
});

/** Delete what `target` names among the stored runs, where they are held. */
export const deleteCliHistory = Effect.fn('deleteCliHistory')(function* (
  session: Session,
  target: RunId | 'all',
) {
  const { listed, deleted, active, failed } = yield* session.deleteRuns(target);
  if (target === 'all')
    return {
      deleted: 'all',
      count: deleted.length,
      active,
      failed: failed.map(({ runId, error }) => ({
        runId,
        message: toErrorMessage(error),
      })),
    } satisfies CliHistoryDeleteResult;
  const [refused] = failed;
  if (refused) return yield* Effect.fail(refused.error);
  let status: 'deleted' | 'active' | 'not-found' = 'not-found';
  if (deleted.length > 0) status = 'deleted';
  else if (active.length > 0) status = 'active';
  return {
    deleted: 'one',
    id: target,
    found: listed > 0,
    status,
  } satisfies CliHistoryDeleteResult;
});

export function formatCliHistoryText(
  entries: readonly CliHistoryEntry[],
): string {
  return entries
    .map((entry) =>
      [
        entry.id,
        entry.timestamp,
        formatCliHistoryAgentLabel(entry),
        historyStanding(entry),
        formatCliHistorySubject(entry, '-'),
      ].join('\t'),
    )
    .join('\n');
}

export function formatCliHistoryNotFoundText(id: RunId, cwd?: string): string {
  const workspace = cwd?.trim();
  return [
    workspace
      ? `Run not found in workspace ${workspace}: ${id}`
      : `Run not found: ${id}`,
    'History is scoped by --cwd; use the workspace from the original run or run `texra history list --cwd <workspace>`.',
  ].join('\n');
}

/**
 * `--export ''` (or any non-`html`/`md` value) reports this. `JSON.stringify`
 * keeps the reported value unambiguous — an empty string reads as `""`
 * instead of collapsing into a confusing double space after the colon.
 */
export function formatInvalidExportFormatText(raw: string): string {
  return `Invalid export format: ${JSON.stringify(raw)} (use html or md)`;
}

/** How a listed run stands in `texra history`'s text: its outcome, else
 *  none, and whether `texra resume` continues it. */
export function historyStanding(
  entry: Pick<CliHistoryEntry, 'outcome' | 'resumable'>,
): string {
  const outcome = entry.outcome ?? 'no outcome';
  return entry.resumable ? `${outcome} (resumable)` : outcome;
}

export function cliHistoryNdjsonRecords(
  entries: readonly CliHistoryEntry[],
): CliNdjsonRecord[] {
  const ts = new Date().toISOString();
  return entries.map((entry) => ({
    kind: 'history-entry',
    ts,
    entry,
  }));
}

/** `history show`'s NDJSON record. */
export function cliHistoryDetailNdjsonRecord(
  details: CliHistoryDetails,
): CliNdjsonRecord {
  return {
    kind: 'history-detail',
    detail: details,
  };
}

export function formatCliHistoryDetailsText(
  details: CliHistoryDetails,
): string {
  const { config, run } = details;
  const model = details.currentModel ?? config?.model;
  const team = teamIdOf(config);
  const cliOutputFile = config?.cli?.outputFile?.trim();
  // Worded as every host words it.
  const status = `${run ? runStatusLabel(run.statusKey) : 'Unknown'}${
    details.resumable ? ' (resumable)' : ''
  }`;
  const lines = [
    `Run: ${details.id}`,
    `Status: ${status}`,
    `Timestamp: ${run ? new Date(run.launchedAt).toISOString() : 'unknown'}`,
    `Agent: ${config?.agent ?? 'unknown'}`,
    `Model: ${model ?? 'unknown'}`,
  ];

  if (team) lines.push(`Team: ${team}`);
  if (
    details.currentModel &&
    config?.model &&
    details.currentModel !== config.model
  ) {
    lines.push(`Startup model: ${config.model}`);
  }
  if (config) lines.push(`Kind: ${runKindOf(config)}`);
  if (cliOutputFile) lines.push(`CLI output: ${cliOutputFile}`);
  if (run?.parentId) lines.push(`Parent: ${run.parentId}`);
  if (run?.description) lines.push(`Description: ${run.description}`);
  if (details.result) {
    lines.push(`Result: ${JSON.stringify(details.result)}`);
  }
  if (details.report) {
    lines.push('', 'Report:', details.report);
  }
  if (details.conversation) {
    lines.push('', formatConversationTranscript(details.conversation));
  } else if (!details.report && details.conversationPreview) {
    lines.push('', formatConversationPreview(details.conversationPreview));
  }
  const shown = config
    ? serializeFilteredConfig(
        config,
        runKindOf(config) === 'task' ? 'task' : 'agent',
      )
    : '{}';
  const files = details.files.map(
    (file) => `${file.isDirectory ? '<dir>' : file.size}\t${file.path}`,
  );
  lines.push('', 'Config:', shown, '', `Files (${files.length}):`);
  lines.push(...(files.length ? files : ['(none)']));
  if (details.checkpointPresent) lines.push('', 'Checkpoint: present');
  return lines.join('\n');
}

function toCliHistoryEntry(entry: AgentRunListingEntry): CliHistoryEntry {
  const config = entry.record;
  const firstInputFile = config.inputFiles.at(0);
  const inputBasename = firstInputFile ? path.basename(firstInputFile) : '-';
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    agent: config.agent,
    // The model the run is on, as the listing derives it from the run's
    // snapshots; the record keeps the model it was launched with.
    model: entry.model ?? config.model,
    outcome: entry.outcome,
    resumable: entry.resumable,
    ...(entry.resumeBlocked !== undefined && {
      resumeBlocked: entry.resumeBlocked,
    }),
    inputBasename,
    kind: runKindOf(config),
    description: entry.description,
    teamId: teamIdOf(config),
  };
}

/** A document task's run, or a chat: what its launch config ran. */
function runKindOf(config: AgentConfig): 'task' | 'chat' {
  return isTaskConfig(config) ? 'task' : 'chat';
}

function teamIdOf(config: AgentConfig | null): string | undefined {
  return config?.cli?.teamId?.trim() || undefined;
}

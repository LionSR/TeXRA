import * as path from 'node:path';

import { Effect, FileSystem, PlatformError, Result, Stream } from 'effect';

import {
  deriveResumability,
  getRunRecords,
  isUserVisibleRun,
  listRuns,
  listRunWorkspaceFiles,
  type AgentRunListingEntry,
  type RunResult,
} from '@agent/storage';
import type { AgentConfig, SessionHandle } from '@agent/runtime';
import { loadChatExportInput, type ChatExportInput } from '@agent/export';
import type { CliNdjsonRecord } from '@cli/schemas/cliOutput';
import {
  RunIdSchema,
  aggregateTarget,
  HISTORY_RUN_STATUS,
  HISTORY_RUN_STATUS_LABEL,
  isDocumentTaskConfig,
  RUN_SUBSTATE,
  type RunId,
  type HistoryRunStatus,
} from '@shared/schemas';
import type { SessionOpenError } from '@shared/session/database';
import type { RunView } from '@shared/session/sessionView';
import { runOutcomeToCliRunStatus } from '@shared/runs/runStatus';
import {
  listRunGeneratedFiles,
  type RunGeneratedFile,
} from '@tools/executions/runGeneratedFiles';
import { serializeFilteredConfig } from '@tools/executions/configView';
import { readCompletedRunConversation } from '@transcript';
import { byStringProp } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { absentReason } from '@utils/files/fsEntryExists';

import { CliUsageError } from './cliContext';
import { cliErrorMessage } from './logSinks';
import { cliRunStanding } from './toolUseResumeData';
import {
  blockedHistoryEntry,
  formatCliHistoryAgentLabel,
  formatCliHistorySubject,
} from './historyLabels';
import {
  createConversationPreview,
  createConversationTranscript,
  formatConversationPreview,
  formatConversationTranscript,
} from './history/conversationFormat';

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
  return [...files.values()].toSorted(byStringProp((f) => f.path));
}

export interface CliHistoryEntry {
  readonly id: RunId;
  readonly timestamp: string;
  readonly agent: string;
  readonly model: string;
  readonly status: HistoryRunStatus;
  /** `deriveResumability`'s answer, the one `texra resume` acts on.
   *  Ownership and loadability are settled when the run is opened.
   *  Independent of the frozen `status`: a failed run can be resumable. */
  readonly resumable: boolean;
  readonly inputBasename: string;
  /** A document task's run, or a chat. */
  readonly kind?: 'task' | 'chat';
  readonly description?: string;
  readonly teamId?: string;
  readonly parentRunId?: RunId;
}

interface CliHistoryDetails {
  readonly id: RunId;
  readonly status: HistoryRunStatus;
  /** The run's launch facts as the session's fold holds them. */
  readonly run: Pick<RunView, 'launchedAt' | 'parentId' | 'description'> | null;
  readonly config: AgentConfig | null;
  readonly result: RunResult | null;
  readonly report: string | null;
  readonly conversationPreview: CliHistoryConversationPreview | null;
  readonly conversation?: CliHistoryConversationPreview | null;
  readonly files: readonly RunGeneratedFile[];
  /** Whether the run aggregate carries a `run.snapshot`. */
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

/** Rows the resume surfaces offer. Both the launcher's resume browser and the
 *  `/resume` form read this, and the launcher's Resume row counts against it,
 *  so the advertised count can never exceed the list it opens. Filtering and
 *  capping live together so a caller cannot honor one half of the rule. */
const RESUME_LIST_LIMIT = 50;

export function listResumableCliHistoryEntries<
  T extends Pick<CliHistoryEntry, 'resumable'>,
>(entries: readonly T[]): T[] {
  return entries.filter((entry) => entry.resumable).slice(0, RESUME_LIST_LIMIT);
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
  return RunIdSchema.safeParse(raw).data;
}

/**
 * The history readers take the process session as the open that yields it
 * (`CliPlatformServices.session`), so the open runs inside the reader's own
 * program, on the runtime the calling surface holds.
 */
export const listCliHistoryEntries = Effect.fn('cli.listCliHistoryEntries')(
  function* (session: Effect.Effect<SessionHandle, SessionOpenError>) {
    const opened = yield* session;
    return (yield* listRuns(opened))
      .filter(isUserVisibleRun)
      .map((entry) =>
        entry.kind === 'blocked'
          ? blockedHistoryEntry(entry)
          : toCliHistoryEntry(entry),
      );
  },
);

export const readCliHistoryDetails = Effect.fn('cli.readCliHistoryDetails')(
  function* (
    sessionOpen: Effect.Effect<SessionHandle, SessionOpenError>,
    id: RunId,
    options: { includeFullConversation?: boolean } = {},
  ) {
    const session = yield* sessionOpen;
    const store = getRunRecords(session, id);
    const [
      run,
      config,
      result,
      report,
      conversation,
      persistedWorkspaceFilePaths,
      generatedFiles,
      resumeFrom,
    ] = yield* Effect.all(
      [
        session.readView([]).pipe(Effect.map((view) => view.runs.get(id))),
        store.readConfig(),
        store.readResult(),
        store.readReport(),
        readCompletedRunConversation(id, session),
        store.readWorkspaceFiles(),
        listRunGeneratedFiles(id, session),
        deriveResumability(id, session),
      ],
      { concurrency: 8 },
    );
    // The model the run is on, as the view folds it for the listing too.
    const currentModel = config ? (run?.model ?? undefined) : undefined;
    // The same rule the listing applies, from the same facts: `status` is a
    // frozen contract, so `history show` must not answer it differently from
    // `history list` for the run in the row the caller just read.
    const checkpointPresent = resumeFrom.kind === 'checkpoint';
    // A run with no config is corrupt: there is nothing to resume it under.
    const standing = cliRunStanding({
      resumable:
        config !== null &&
        (checkpointPresent || resumeFrom.kind === 'unopened'),
      phase: run?.status,
      paused: run?.substate === RUN_SUBSTATE.PAUSED,
      blocked: (run?.blocked ?? null) !== null,
    });
    const workspaceFiles = yield* listRunWorkspaceFiles(
      config,
      persistedWorkspaceFilePaths,
    );
    const conversationPreview = createConversationPreview(conversation);
    const fullConversation = options.includeFullConversation
      ? createConversationTranscript(conversation)
      : undefined;
    const files = mergeHistoryFiles(
      generatedFiles,
      workspaceFiles.map((file) => ({
        path: file.displayPath,
        size: file.size,
        isDirectory: file.isDirectory,
      })),
    );

    if (!run && !config && conversation.length === 0 && !checkpointPresent) {
      return null;
    }
    return {
      id,
      status: standing.status,
      run: run
        ? {
            launchedAt: run.launchedAt,
            parentId: run.parentId,
            description: run.description,
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
 * backs the progress-view `ChatExportController.buildExportInput` — so the CLI
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
)(function* (
  session: Effect.Effect<SessionHandle, SessionOpenError>,
  id: RunId,
) {
  const { run, config, conversation, exportInput } = yield* Effect.flatMap(
    session,
    (opened) => loadChatExportInput(id, opened),
  );
  if (exportInput)
    return { status: 'ok', exportInput } satisfies CliHistoryExportInputResult;
  if (!run && !config && conversation.length === 0) {
    return { status: 'not_found' } satisfies CliHistoryExportInputResult;
  }
  return { status: 'incomplete' } satisfies CliHistoryExportInputResult;
});

/** Single-file trace-viewer bundle (file://-safe, inlined assets). */
const TRACE_VIEWER_DIR_NAME = 'traceViewer';

/**
 * Read the trace-viewer's single-file default bundle — one self-contained
 * `index.html` with no external `assets/` (JS/CSS/fonts all inlined) so the
 * default export opens correctly via `file://` with no server. Succeeds with
 * `null` only when the template is absent — e.g. a dev checkout where
 * `packages/trace-viewer` hasn't been built — so the caller can report a clear
 * error instead of an ENOENT stack trace. Any other read failure (EACCES, a
 * transient I/O error) is not "rebuild the CLI", so it fails as a usage error
 * naming the real cause.
 */
export function readCliHistoryStandaloneTemplate(
  resourcesPath: string,
): Effect.Effect<string | null, CliUsageError, FileSystem.FileSystem> {
  const templatePath = path.join(
    resourcesPath,
    TRACE_VIEWER_DIR_NAME,
    'index.html',
  );
  return FileSystem.FileSystem.use((fs) =>
    fs.readFileString(templatePath),
  ).pipe(
    Effect.catch((error: PlatformError.PlatformError) =>
      absentReason(error)
        ? Effect.succeed(null)
        : Effect.fail(
            new CliUsageError(
              `history export: cannot read ${templatePath}: ${cliErrorMessage(error)}`,
            ),
          ),
    ),
  );
}

/** Delete indexed run lifetimes through the session's claim transaction. */
export const deleteCliHistory = Effect.fn('deleteCliHistory')(function* (
  session: SessionHandle,
  options: { id?: RunId; all?: boolean },
) {
  if (!options.all && !options.id) {
    return yield* Effect.fail(new Error('Expected a run id, or --all.'));
  }
  const rows = yield* Stream.runCollect(session.events.listing());
  const removed = new Set(
    rows
      .filter((row) => row.type === 'run.removed')
      .map((row) => row.aggregateId),
  );
  // A `run.start` row opens a run aggregate, so its aggregate id is the run id.
  const starts = rows.flatMap((row) => {
    if (row.type !== 'run.start' || removed.has(row.aggregateId)) return [];
    const target = aggregateTarget(row.aggregateId);
    if (target.kind !== 'run') {
      throw new Error(
        `run.start on a ${target.kind} aggregate: ${row.aggregateId}`,
      );
    }
    return [{ runId: target.id, commit: row.commit }];
  });
  const selected = options.all
    ? starts
    : starts.filter((start) => start.runId === options.id);
  const deleted: RunId[] = [];
  const active: RunId[] = [];
  const failed: { runId: RunId; message: string }[] = [];
  for (const start of selected) {
    const result = yield* Effect.result(
      session.requests.removeRun(
        start.runId,
        options.all ? 'bulk' : 'single',
        start.commit,
      ),
    );
    if (Result.isSuccess(result)) {
      deleted.push(start.runId);
    } else if (result.failure._tag === 'NotOwner') {
      active.push(start.runId);
    } else {
      if (!options.all) return yield* Effect.fail(result.failure);
      failed.push({
        runId: start.runId,
        message: toErrorMessage(result.failure),
      });
    }
  }
  if (options.all)
    return {
      deleted: 'all',
      count: deleted.length,
      active,
      failed,
    } satisfies CliHistoryDeleteResult;
  const id = options.id!;
  let status: 'deleted' | 'active' | 'not-found' = 'not-found';
  if (deleted.length > 0) status = 'deleted';
  else if (active.length > 0) status = 'active';
  return {
    deleted: 'one',
    id,
    found: selected.length > 0,
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
        entry.status,
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

/**
 * The one rename the NDJSON history records keep: a terminal outcome is
 * spelled as `CliRunStatus` ('completed' | 'interrupted' | 'error'), the
 * word the CLI contract promises; every other status passes through.
 */
function toNdjsonHistoryStatus(status: HistoryRunStatus): string {
  if (
    status === HISTORY_RUN_STATUS.RESUMABLE ||
    status === HISTORY_RUN_STATUS.PAUSED ||
    status === HISTORY_RUN_STATUS.BLOCKED ||
    status === HISTORY_RUN_STATUS.UNKNOWN
  ) {
    return status;
  }
  return runOutcomeToCliRunStatus(status);
}

export function cliHistoryNdjsonRecords(
  entries: readonly CliHistoryEntry[],
  ts = new Date().toISOString(),
): CliNdjsonRecord[] {
  return entries.map((entry) => ({
    kind: 'history-entry',
    ts,
    entry: { ...entry, status: toNdjsonHistoryStatus(entry.status) },
  }));
}

/** `history show`'s NDJSON record, with the frozen-boundary status projection. */
export function cliHistoryDetailNdjsonRecord(
  details: CliHistoryDetails,
): CliNdjsonRecord {
  return {
    kind: 'history-detail',
    detail: { ...details, status: toNdjsonHistoryStatus(details.status) },
  };
}

export function formatCliHistoryDetailsText(
  details: CliHistoryDetails,
): string {
  const { config, run } = details;
  const model = details.currentModel ?? config?.model;
  const team = teamIdOf(config);
  const cliOutputFile = config?.cli?.outputFile?.trim();
  const lines = [
    `Run: ${details.id}`,
    `Status: ${HISTORY_RUN_STATUS_LABEL[details.status]}`,
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
  const { status, resumable } = cliRunStanding({
    resumable: entry.resumable,
    phase: entry.status,
    paused: entry.paused,
    blocked: entry.blocked !== undefined,
  });
  return {
    id: entry.id,
    timestamp: entry.timestamp,
    agent: config.agent,
    // The model the run is on, as the listing folds it from the run's
    // snapshots; the record keeps the model it was launched with.
    model: entry.model ?? config.model,
    status,
    resumable,
    inputBasename,
    kind: runKindOf(config),
    description: entry.description,
    teamId: teamIdOf(config),
    parentRunId: entry.parentRunId,
  };
}

/** A document task's run, or a chat: what its launch config ran. */
function runKindOf(config: AgentConfig): 'task' | 'chat' {
  return isDocumentTaskConfig(config) ? 'task' : 'chat';
}

function teamIdOf(config: AgentConfig | null): string | undefined {
  return config?.cli?.teamId?.trim() || undefined;
}

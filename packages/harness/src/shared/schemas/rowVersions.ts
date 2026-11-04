/**
 * The registry of the session store's row kinds. Each kind the store holds
 * carries the version this build writes, the adjacent upcasters that bring
 * an older stored version to it, and where the listing keeps its newest
 * row. The session store's row codec is the one reader of the version and
 * the upcasters; `listingTypeOf` reads the listing class.
 *
 * A row is always written at its kind's current version. A lower stored
 * version is upcast step by step and then parsed with the current arm; a
 * higher one, or a kind this registry lacks and never retired, refuses the
 * whole store (`storeGate`) and is never rewritten.
 *
 * The release watermark is the schemas frozen at a release: a
 * version frozen there never changes in place. Before 1.0 a kind changes with
 * no upcaster; its version is bumped when an older build's row would read
 * wrong (or fail): such a row then reads as an earlier build's
 * (`DatabaseRowEarlier`, its whole run listed as written by an earlier
 * build), never as damaged or silently stripped.
 */
// The frozen schemas live in `config/storage/frozen/`, written by
// `npm run storage:freeze` at a release and checked by `rowVersions.vitest.ts`.
import type { JsonValue } from './jsonValue';
import type { SessionEventDraft } from './sessionEvent';

/** A stored row's data, as plain JSON. */
type RowData = { readonly [field: string]: JsonValue };

interface RowKind {
  /** The version this build writes. */
  readonly version: number;
  /** Adjacent conversions from `version - upcast.length` to `version`,
   *  oldest first, over plain JSON. */
  readonly upcast: readonly ((data: RowData) => RowData)[];
  /**
   * Where the listing keeps the kind's newest row: under the kind's own
   * type, under a key shared with the rows that update the same thing, or
   * nowhere. The request pair updates one set and the follow-up pair
   * another; the lifecycle pair (`run.start`, `run.removed`) updates one
   * existence, so a deletion marker's commit outranks a replayed
   * `run.start` below it, which makes the marker final under every read.
   * The run history and the transcript tier but `context.state` (the
   * run's context gauge, read from its newest row) are listed nowhere: a
   * cold initial load would pull the newest one of every run into every
   * renderer for no reader. `run.position` and `child.park` are listed:
   * the phase is read from them, so a listing without them would paint
   * every waiting run as ready and every waiting child as busy.
   */
  readonly listing: 'none' | 'own' | 'request' | 'followup' | 'lifecycle';
}

const V1 = { version: 1, upcast: [] } as const;

/**
 * The row kinds this build deleted from `ROW_KINDS`, each with what its rows
 * fed. A store that holds one is not a newer build's, and the rest of the
 * store opens. A `display` row fed only what a view showed: it is skipped on
 * read (logged once) and its run resumes, since no decision of the run was
 * made from it. An `execution` row fed a decision the run made (its
 * context, a retry permit, a request, its result): its run reads as an
 * earlier build's (`DatabaseRowEarlier`), shown read-only, since resuming
 * without it would continue from a different state. A kind moves here from
 * `ROW_KINDS` in the change that deletes it; every kind ever stored is
 * listed in `config/storage/row-kinds-ever.json`, which never shrinks.
 */
export const RETIRED_ROW_KINDS: ReadonlyMap<string, 'display' | 'execution'> =
  new Map([
    // A completed turn's tool-call count, which only the view showed.
    ['conversation.progress', 'display'],
    // An external inquiry thread's state: an open request.
    ['inquiryThreadUpdated', 'execution'],
    // A compaction of the model context.
    ['model.compaction', 'execution'],
    // The human retry permit a restart read back.
    ['model.retry', 'execution'],
    // A document round's outputs: the run's files.
    ['output.produced', 'execution'],
    // A goal run's plan.
    ['run.fact', 'execution'],
    // The loop state a resume continued from.
    ['run.snapshot', 'execution'],
    // An approval request's binding to its tool call.
    ['tool.binding', 'execution'],
    // The workflow engine's journal, plan, script, calls and attempts.
    ['workflow.attempt', 'execution'],
    ['workflow.call', 'execution'],
    ['workflow.journal', 'execution'],
    ['workflow.plan', 'execution'],
    ['workflow.script', 'execution'],
  ]);

/** The lowest stored version of a plugin fact kind's value this build reads: an
 *  older one has no upcaster here, so an earlier build wrote it. The store
 *  (`decodeRow`, `earlierRuns`) and an imported trace refuse it alike. */
export const pluginFactFloor = (factKind: {
  readonly version: number;
  readonly upcasters: readonly unknown[];
}): number => factKind.version - factKind.upcasters.length;

/** Plugin fact kinds a built-in plugin wrote before this build retired
 *  them, by `plugin/kind`: a row of one is an earlier build's, refused by
 *  the store (`factKindOf`) and an imported trace alike, never read
 *  unavailable, since its plugin is loaded. */
export const RETIRED_PLUGIN_FACTS: ReadonlySet<string> = new Set([
  'goal/state',
]);

/** Why a plugin fact is read uninterpreted: no plugin of this process
 *  registers its kind. Its row stays as written; the store and an imported
 *  trace read it with this reason (`unavailable`), its value and version
 *  unchanged, and a run holding one does not resume here. */
export const unavailableFactReason = (fact: {
  readonly plugin: string;
  readonly kind: string;
}): string =>
  `Plugin "${fact.plugin}" is unavailable: nothing loaded here registers its fact kind ${fact.kind}, so the fact is kept as written and not interpreted.`;

/** The version every current-value family writes and reads
 *  (each `ValueFamily`), until one gains an upcaster. */
export const CURRENT_VALUE_VERSION = 1;

/** Every arm of `SessionEventDraftSchema`: a new arm without an entry, its
 *  version and its listing class, does not compile. */
export const ROW_KINDS: Readonly<Record<SessionEventDraft['type'], RowKind>> = {
  // v2: the launching call's id and card are one `parent.call`, with no
  // top-level `parentCard` (no upcaster, as `run.config`).
  'run.start': { version: 2, upcast: [], listing: 'lifecycle' },
  'run.activate': { ...V1, listing: 'own' },
  // v2: a recipe's script names its block and options; `toolConfig` is
  // gone (no upcaster: an earlier build's v1 row refuses its run as written
  // by that build, rather than launching with its options dropped).
  // v3: a script's handed-down call commits in the run's opening batch (no
  // upcaster: a v2 script run cut before its handed-down row would resume
  // into a model call instead of its script).
  // v4: media-only tasks can produce outputs; earlier readers reject those
  // configurations because they count only text inputs (no upcaster).
  // v5: no OpenRouter backend (no upcaster: an earlier build's row would
  // fail as damaged).
  // v6: no Copilot backend (no upcaster, as v5).
  'run.config': { version: 6, upcast: [], listing: 'own' },
  'run.model': { ...V1, listing: 'own' },
  'run.detach': { ...V1, listing: 'own' },
  // v2: a recipe's value is `structured`, with no `documents` (no upcaster,
  // as `run.config`).
  // v3: the error's classification as `model.message` v9.
  // v4: an error always carries its `message` (no upcaster: an earlier
  // build's error without one would fail as damaged).
  // v5: the error's classification as `model.message` v10 (no upcaster: an
  // earlier build would fail a subscription's failure as damaged).
  // v6: a cancelled end carries `reason` (`user` or `shutdown`), which the
  // halt row carried as `closed` before, and the error kind `abort` is gone
  // (no upcaster: an earlier build's shutdown end would read as a user's
  // stop, holding a child's delivery back).
  // v7: the error is a model failure as the run's rows record it (`kind:
  // 'model'`, its classification beside) or a local one (`disk-full`,
  // `result-lost`, `unexpected`); `context-window` and `missing-api-key`
  // are classifications, no longer kinds (no upcaster: an earlier build's
  // classified end would fail as damaged).
  'run.end': { version: 7, upcast: [], listing: 'own' },
  'child.park': { ...V1, listing: 'own' },
  'run.removed': { ...V1, listing: 'lifecycle' },
  'run.description': { ...V1, listing: 'own' },
  'plugin.fact': { ...V1, listing: 'own' },
  // v2: `holdUntil` gained `turn` and `generation`, and a child's progress
  // notice is known by `holdUntil: 'generation'`, no longer by its text: a
  // v1 notice would read as an ordinary message (no upcaster, as
  // `run.config`).
  // v3: attached media by blob address (`media`), no `mediaFiles` paths (no
  // upcaster: a v2 row's paths would be read as no media).
  'followup.queued': { version: 3, upcast: [], listing: 'followup' },
  // v2: `disposition` says why the follow-up left the queue; a v1 row lacks
  // it and fails to decode (no upcaster, as `run.config`).
  'followup.consumed': { version: 2, upcast: [], listing: 'followup' },
  // v2: a task proposal carries its plugin's `options`, not `toolConfig`
  // (no upcaster, as `run.config`).
  // v3: a retry's credential switch names no OpenRouter key (no upcaster,
  // as `run.config`).
  // v4: a task proposal records whether approving it may bypass later
  // prompts (`allowBypass`); a v3 proposal lacks the field and fails to
  // decode (no upcaster, as `run.config`).
  // v5: tool edits require their stored proposal, whose original content
  // distinguishes a missing file from an empty one (no upcaster).
  // v6: no `externalInquiry` kind; a plugin's request is `kind: 'plugin'`,
  // declaring whether it blocks its caller and what it is answered with (no
  // upcaster: an earlier build's inquiry would fail as damaged).
  // v7: a retry carries its failure once and whole (`errorDetails`, no
  // `errorMessage`), classified as `model.message` v9, and a host words a
  // used-up plan from that classification (no upcaster: an earlier build's
  // retry would read without the tier and reset its text named).
  // v8: a retry's failure carries no `userRetryable`; the offer is the
  // `failed` row's own `next` (no upcaster, as `model.message` v12).
  'request.opened': { version: 8, upcast: [], listing: 'request' },
  // v2: no `setup` arm; a proposal's approve may carry edited files,
  // instruction and options (no upcaster, as `run.config`).
  'request.decided': { version: 2, upcast: [], listing: 'request' },
  'approval.policy': { ...V1, listing: 'own' },
  // v2: a `turn.end` carries the turn's `outcome` (no upcaster, as
  // `run.config`: a v1 `turn.end` would fail its check).
  // v3: a halt carries no `reason`; the end's `reason` says what stopped
  // the run (no upcaster: an earlier build's closed halt would read as a
  // crash and spend a retry).
  'run.position': { version: 3, upcast: [], listing: 'own' },
  // v2: no `latexdiff` or `missingOutputs` message type; a plugin's fact
  // holds both (no upcaster, as `run.config`).
  // v3: a user message names its attached media by blob address (`media`),
  // not by `mediaFiles` paths (no upcaster, as `followup.queued`).
  // v4: an error row's classification as `model.message` v9, and a
  // used-up plan's automatic retry is a `quotaFallback` row recording the
  // route it moved off (no upcaster: an earlier build's GLM exhaustion
  // would be refused as a damaged payload).
  // v5: an error row's classification as `model.message` v10 (no upcaster:
  // an earlier build would refuse a subscription's failure as a damaged
  // payload).
  // v6: an error row carries no `userRetryable` (no upcaster: an earlier
  // build's error row would be refused as a damaged payload).
  log: { version: 6, upcast: [], listing: 'none' },
  // v2: no `phase` kind and no `index`/`total` (no upcaster, as
  // `run.config`: an earlier build's workflow phase stage would fail its
  // run as damaged rather than read as that build's).
  'stage.start': { version: 2, upcast: [], listing: 'none' },
  'stage.end': { ...V1, listing: 'none' },
  // v2: a tool's card is stated (`card`), not derived from its name, so the
  // fold has no Codex builders (no upcaster, as `run.config`: an earlier
  // build's card would read without its sections).
  'tool.start': { version: 2, upcast: [], listing: 'none' },
  'tool.end': { ...V1, listing: 'none' },
  // v2: the counts carry `TurnUsage`'s names (`cachedInputTokens`,
  // `cacheWriteTokens`, `toolUsePromptTokens`), and `elapsedTime` is gone
  // (no upcaster: an earlier build's cache counts would read as absent).
  usage: { version: 2, upcast: [], listing: 'none' },
  'context.state': { ...V1, listing: 'own' },
  'stream.start': { ...V1, listing: 'none' },
  'stream.end': { ...V1, listing: 'none' },
  // v2: `cut` names the limit that ended the answer early (no upcaster: an
  // earlier build would show a cut answer as complete).
  'response.finalized': { version: 2, upcast: [], listing: 'none' },
  'run.report': { ...V1, listing: 'own' },
  // v2: no `cliWorkflow` producer and no delivery-time diffs (no upcaster,
  // as `run.config`).
  'run.result': { version: 2, upcast: [], listing: 'own' },
  'followup.closed': { ...V1, listing: 'own' },
  // v2: dispatch facts record `lane`, not `parallelSafe` (no upcaster: an
  // earlier build's v1 row refuses its run as written by that build).
  // v3: dispatch facts carry no `ordinal` (a call's place is its index) and
  // no `stageId` (no upcaster, as v2).
  // v4: stateless Google responses may have a null provider ID. Older builds
  // must refuse the newer store rather than parse those rows as corrupt.
  // v5: a media part holds its bytes by blob address, never inline (no
  // upcaster: an earlier build's inline bytes would read as the newer
  // shape's missing address).
  // v6: no OpenRouter protocol (no upcaster, as
  // `run.config`: an earlier build's row would fail as damaged).
  // v7: no `vscode-lm` protocol and no editor turn (no upcaster, as v6).
  // v8: a turn's usage counts its cache writes and tool-use prompt tokens
  // (`cacheWriteTokens`, `toolUsePromptTokens`) beside its cache reads, and
  // the priced usage names them so (no upcaster: an earlier build's
  // `cacheCreationTokens` would read as absent).
  // v9: a failure's used-up plan carries its tier and reset
  // (`planType`, `resetsInMs`), and the GLM Coding Plan's exhaustion is
  // named by its route, `glm-coding-plan-subscription` (no upcaster: an
  // earlier build's GLM exhaustion would fail as damaged).
  // v10: a subscription that could not bill is classified as
  // `subscription-session`, with its route, whether it needs a sign-in, and
  // the session's own failure (no upcaster: an earlier build would fail the
  // classification as damaged).
  // v11: no `context-window-exceeded` finish reason: an overflow is the
  // `context-overflow` failure on every protocol, and a `failed` row carries
  // the priced `usage` of a response the provider billed before refusing it
  // (no upcaster: an earlier build's overflowed turn would read as a
  // completed one).
  // v12: a failed attempt's error carries no `userRetryable`; whether a
  // person is offered a retry is the row's own `next` (no upcaster: a v11
  // row's flag would otherwise be silently dropped).
  'model.message': { version: 12, upcast: [], listing: 'none' },
  // v2: the causes are `compaction` and `fork` alone (no upcaster, as
  // `run.config`: an earlier build's edit of another cause would fail its
  // run as damaged rather than read as that build's).
  // v3: media parts by address, as `model.message` v5.
  // v4: no OpenRouter protocol, as `model.message` v6.
  // v5: no `vscode-lm` origin, as `model.message` v7.
  // v6: the priced usage's cache writes are `cacheWriteTokens`, as
  // `model.message` v8.
  // v7: a compaction may be triggered by an `overflow`, the request the
  // model's window could not hold (no upcaster: an earlier build would
  // refuse the trigger as damaged).
  'context.edit': { version: 7, upcast: [], listing: 'none' },
  'tool.intent': { ...V1, listing: 'none' },
  'script.call': { ...V1, listing: 'none' },
  // v2: a captured attachment holds its bytes by blob address, never inline.
  // v3: an executed result names the files its call read (`reads`), which
  // an edit of an existing file requires; an earlier build's row would read
  // as a call that read nothing, and the run's edits would be refused (no
  // upcaster: nothing records what that build's calls read).
  'tool.result': { version: 3, upcast: [], listing: 'none' },
  // v2: no `continuation`: goal mode is a script, and a waiting run never
  // continues itself (no upcaster: an earlier build's row names a plugin
  // continuation this build has none of).
  // v3: each tool records whether the step's requests send its declaration
  // (`sent`); an earlier build's row would send every tool directly.
  // v4: the modules a script may import (`modules`); an earlier build's
  // row would resume a script against the modules shipped now.
  'tools.offered': { version: 4, upcast: [], listing: 'none' },
  'context.blob': { ...V1, listing: 'none' },
  // v2: a `PreToolUse` answer is `decision` (allow, deny, ask) with its
  // `reason` and `updatedInput`, not a `deny` reason alone (no upcaster: an
  // earlier build's row has no decision to read).
  'hook.outcome': { version: 2, upcast: [], listing: 'none' },
  'child.turn': { ...V1, listing: 'none' },
};

/**
 * The listing type the fold keys `latest` by, from the kind's listing class,
 * or null for a kind the listing leaves out. `plugin.fact` holds several
 * kinds on one type, so it is read grouped by kind as well (`listingKeyOf`,
 * `Database`).
 */
export function listingTypeOf(
  event: Pick<SessionEventDraft, 'type'>,
): string | null {
  const { listing } = ROW_KINDS[event.type];
  if (listing === 'none') return null;
  return listing === 'own' ? event.type : listing;
}

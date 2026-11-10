/**
 * The registry of the session store's row kinds. Each kind the store holds
 * carries the version this build writes and reads, and where the listing
 * keeps its newest row. The session store's row codec is the one reader of
 * the version; `listingTypeOf` reads the listing class.
 *
 * A row is always written at its kind's current version, and read at that
 * version only: a lower stored version is an earlier build's row
 * (`DatabaseRowEarlier`, its whole run listed as written by an earlier
 * build), never damaged or silently stripped; a higher one, or a kind this
 * registry lacks and never retired, refuses the whole store (`storeGate`)
 * and is never rewritten. A kind's version is bumped when an older build's
 * row would read wrong (or fail). Nothing converts a stored row: the first
 * released version that must stay readable across a change brings the
 * first upcaster with it.
 *
 * The release watermark is the schemas frozen at a release: a version
 * frozen there never changes in place.
 */
// The frozen schemas live in `config/storage/frozen/`, written by
// `npm run storage:freeze` at a release and checked by `rowVersions.vitest.ts`.
import type { SessionRowDraft } from './sessionEvent';

interface RowKind {
  /** The version this build writes and reads. */
  readonly version: number;
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
   * renderer for no reader. `run.position` is listed: the phase is read
   * from it, so a listing without it would paint every waiting run as
   * ready.
   */
  readonly listing: 'none' | 'own' | 'request' | 'followup' | 'lifecycle';
}

const V1 = { version: 1 } as const;

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
    // A run's model switch, projected from the `run.config` that carries it.
    ['run.model', 'display'],
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
    // A child's turns, parks and result manifest, which its resume and its
    // parent's call read: a child is a run that ends, its `run.end` the
    // result.
    ['child.turn', 'execution'],
    ['child.park', 'execution'],
    ['run.result', 'execution'],
    // An approval request's binding to its tool call.
    ['tool.binding', 'execution'],
    // The script engine's journal, plan, script, calls and attempts.
    ['workflow.attempt', 'execution'],
    ['workflow.call', 'execution'],
    ['workflow.journal', 'execution'],
    ['workflow.plan', 'execution'],
    ['workflow.script', 'execution'],
  ]);

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
 *  (each `ValueFamily`). */
export const CURRENT_VALUE_VERSION = 1;

/** Every arm of `SessionRowDraftSchema`: a new arm without an entry, its
 *  version and its listing class, does not compile. */
export const ROW_KINDS: Readonly<Record<SessionRowDraft['type'], RowKind>> = {
  // v2: the launching call's id and card are one `parent.call`, with no
  // top-level `parentCard`.
  // v3: the parent call says whether it awaits the child (`awaited`); an
  // earlier build's child end would deliver to a call that reads it.
  // v4: whether the run takes a message is a boolean (`takesFollowUps`),
  // not `userFollowUpSupport`; an earlier build's row names neither.
  'run.start': { version: 4, listing: 'lifecycle' },
  'run.activate': { ...V1, listing: 'own' },
  // v2: a recipe's script names its block and options; `toolConfig` is gone
  // (an earlier build's v1 row refuses its run as written by that build,
  // rather than launching with its options dropped).
  // v3: a script's handed-down call commits in the run's opening batch (a v2
  // script run cut before its handed-down row would resume into a model call
  // instead of its script).
  // v4: media-only tasks can produce outputs; earlier readers reject those
  // configurations because they count only text inputs.
  // v5: no OpenRouter backend (an earlier build's row would fail as damaged).
  // v6: no Copilot backend.
  'run.config': { version: 6, listing: 'own' },
  'run.detach': { ...V1, listing: 'own' },
  'run.stop': { ...V1, listing: 'own' },
  // v2: a recipe's value is `structured`, with no `documents`.
  // v3: the error's classification as `model.message` v9.
  // v4: an error always carries its `message` (an earlier build's error
  // without one would fail as damaged).
  // v5: the error's classification as `model.message` v10 (an earlier build
  // would fail a subscription's failure as damaged).
  // v6: a cancelled end carries `reason` (`user` or `shutdown`), which the
  // halt row carried as `closed` before, and the error kind `abort` is gone
  // (an earlier build's shutdown end would read as a user's stop, holding a
  // child's delivery back).
  // v7: the error is a model failure as the run's rows record it (`kind:
  // 'model'`, its classification beside) or a local one (`disk-full`,
  // `result-lost`, `unexpected`); `context-window` and `missing-api-key` are
  // classifications, no longer kinds (an earlier build's classified end would
  // fail as damaged).
  // v8: no `reason`: why a run stopped is its `run.stop` row (an earlier
  // build's shutdown end would read as a person's stop, holding a child's
  // delivery back and spending a retry).
  // v9: a model failure is its verdict (`failure`: llm's on the vendor's
  // reply, the route's, or an attempt the process stopped during), never
  // its words or a classification of it (an earlier build's end would read
  // without its verdict).
  'run.end': { version: 9, listing: 'own' },
  'run.removed': { ...V1, listing: 'lifecycle' },
  // v2: a model's summary carries its helper request's priced `usage`,
  // which the run's spend counts (a v1 summary would read as free).
  'run.description': { version: 2, listing: 'own' },
  'plugin.fact': { ...V1, listing: 'own' },
  // v2: `holdUntil` gained `turn` and `generation`, and a child's progress
  // notice is known by `holdUntil: 'generation'`, no longer by its text: a v1
  // notice would read as an ordinary message.
  // v3: attached media by blob address (`media`), no `mediaFiles` paths (a v2
  // row's paths would be read as no media).
  // v4: a delivery or notice carries its summary as `displayText`, which
  // every surface shows (a v3 delivery would show its raw envelope).
  // v5: no `holdUntil: 'generation'`: a child queues no progress notice, and
  // a host's notification is known by its sender (a v4 row holding it would
  // fail as damaged).
  'followup.queued': { version: 5, listing: 'followup' },
  // v2: `disposition` says why the follow-up left the queue; a v1 row lacks
  // it and fails to decode.
  // v3: no `stale` reason: nothing drops a notice of an ended child (a v2
  // row dropped for it would fail as damaged).
  'followup.consumed': { version: 3, listing: 'followup' },
  // v2: a task proposal carries its plugin's `options`, not `toolConfig`
  // v3: a retry's credential switch names no OpenRouter key.
  // v4: a task proposal records whether approving it may bypass later prompts
  // (`allowBypass`); a v3 proposal lacks the field and fails to decode.
  // v5: tool edits require their stored proposal, whose original content
  // distinguishes a missing file from an empty one.
  // v6: no `externalInquiry` kind; a plugin's request is `kind: 'plugin'`,
  // declaring whether it blocks its caller and what it is answered with (an
  // earlier build's inquiry would fail as damaged).
  // v7: a retry carries its failure once and whole (`errorDetails`, no
  // `errorMessage`), classified as `model.message` v9, and a host words a
  // used-up plan from that classification (an earlier build's retry would
  // read without the tier and reset its text named).
  // v8: a retry's failure carries no `userRetryable`; the offer is the
  // `failed` row's own `next`.
  // v9: `allowBypass` is `offersGrant`, what it means: whether the request
  // offers the run grant of its kind (an earlier build's would fail to read).
  // v10: a retry carries its failure as the verdict (`failure`), not its
  // words and classification (`errorDetails`), and a host words it.
  'request.opened': { version: 10, listing: 'request' },
  // v2: no `setup` arm; a proposal's approve may carry edited files,
  // instruction and options.
  'request.decided': { version: 2, listing: 'request' },
  'approval.policy': { ...V1, listing: 'own' },
  // v2: a `turn.end` carries the turn's `outcome` (a v1 `turn.end` would fail
  // its check).
  // v3: a halt carries no `reason`; the end's `reason` says what stopped the
  // run (an earlier build's closed halt would read as a crash and spend a
  // retry).
  // v4: no `halted` position: `run.end` is the halt (an earlier build's halt
  // row would fail its check).
  // v5: no `family`: every run has the one loop, so the field said nothing
  // (an earlier build's row would have it silently dropped).
  'run.position': { version: 5, listing: 'own' },
  // v2: no `latexdiff` or `missingOutputs` message type; a plugin's fact
  // holds both.
  // v3: a user message names its attached media by blob address (`media`),
  // not by `mediaFiles` paths.
  // v4: an error row's classification as `model.message` v9, and a used-up
  // plan's automatic retry is a `quotaFallback` row recording the route it
  // moved off (an earlier build's GLM exhaustion would be refused as a
  // damaged payload).
  // v5: an error row's classification as `model.message` v10 (an earlier
  // build would refuse a subscription's failure as a damaged payload).
  // v6: an error row carries no `userRetryable` (an earlier build's error row
  // would be refused as a damaged payload).
  // v7: a script delivery's summary counts its `sectionCount`, not
  // `phaseCount` (an earlier build's user message would be refused as a
  // damaged payload).
  // v8: an error row's model failure is its verdict (`failure`), with no
  // worded `message`, status or classification beside it (an earlier
  // build's error row would be refused as a damaged payload).
  log: { version: 8, listing: 'none' },
  // v2: no `phase` kind and no `index`/`total` (an earlier build's script
  // phase stage would fail its run as damaged rather than read as that
  // build's).
  // v3: no run, turn or process-run stage, no `parentId` and no `kind` (an
  // earlier build's `Run:` stage would read as a section of this build's).
  'stage.start': { version: 3, listing: 'none' },
  'stage.end': { ...V1, listing: 'none' },
  // v2: a tool's card is stated (`card`), not derived from its name, so the
  // fold has no Codex builders (an earlier build's card would read without
  // its sections).
  // v4: a script's call names its `section` (the guest's `section()`
  // title), not its `phase` (an earlier build's title would be silently
  // dropped).
  'tool.start': { version: 4, listing: 'none' },
  'tool.end': { ...V1, listing: 'none' },
  // v2: the counts carry `TurnUsage`'s names (`cachedInputTokens`,
  // `cacheWriteTokens`, `toolUsePromptTokens`), and `elapsedTime` is gone (an
  // earlier build's cache counts would read as absent).
  usage: { version: 2, listing: 'none' },
  'context.state': { ...V1, listing: 'own' },
  'stream.start': { ...V1, listing: 'none' },
  'stream.end': { ...V1, listing: 'none' },
  // v2: `cut` names the limit that ended the answer early (an earlier build
  // would show a cut answer as complete).
  'response.finalized': { version: 2, listing: 'none' },
  'run.report': { ...V1, listing: 'own' },
  // v2: a capped log's tail row says how many characters it follows a gap
  // of (`elided`), in place of a notice row (an earlier build's capped log
  // would read as one unbroken stream).
  'process.output': { version: 2, listing: 'none' },
  'process.exit': { ...V1, listing: 'own' },
  'followup.closed': { ...V1, listing: 'own' },
  // v2: dispatch facts record `lane`, not `parallelSafe` (an earlier build's
  // v1 row refuses its run as written by that build).
  // v3: dispatch facts carry no `ordinal` (a call's place is its index) and
  // no `stageId`.
  // v4: stateless Google responses may have a null provider ID. Older builds
  // must refuse the newer store rather than parse those rows as corrupt.
  // v5: a media part holds its bytes by blob address, never inline (an
  // earlier build's inline bytes would read as the newer shape's missing
  // address).
  // v6: no OpenRouter protocol (an earlier build's row would fail as
  // damaged).
  // v7: no `vscode-lm` protocol and no editor turn.
  // v8: a turn's usage counts its cache writes and tool-use prompt tokens
  // (`cacheWriteTokens`, `toolUsePromptTokens`) beside its cache reads, and
  // the priced usage names them so (an earlier build's `cacheCreationTokens`
  // would read as absent).
  // v9: a failure's used-up plan carries its tier and reset (`planType`,
  // `resetsInMs`), and the GLM Coding Plan's exhaustion is named by its
  // route, `glm-coding-plan-subscription` (an earlier build's GLM exhaustion
  // would fail as damaged).
  // v10: a subscription that could not bill is classified as
  // `subscription-session`, with its route, whether it needs a sign-in, and
  // the session's own failure (an earlier build would fail the classification
  // as damaged).
  // v11: no `context-window-exceeded` finish reason: an overflow is the
  // `context-overflow` failure on every protocol, and a `failed` row carries
  // the priced `usage` of a response the provider billed before refusing it
  // (an earlier build's overflowed turn would read as a completed one).
  // v12: a failed attempt's error carries no `userRetryable`; whether a
  // person is offered a retry is the row's own `next` (a v11 row's flag would
  // otherwise be silently dropped).
  // v13: no `stop-sequence` finish reason or `stopSequence`, and an
  // accepted operation is its origin and response id alone, with no stream
  // position (an earlier build's operation would have its position silently
  // dropped).
  // v14: no `purpose`; a compaction's summary records no attempt.
  // v15: a failed attempt whose plan ran out records the route it declines
  // (`next: decline`) instead of a retry request answered at once, and the
  // rebind records the declined route on a `run.config` (an earlier build's
  // fallback would resume without its route declined).
  // v16: a failed attempt's error is its verdict: llm's (its kind, the
  // vendor's own message and status, the quota a plan or credit names),
  // the route's, or `interrupted` for an attempt the process stopped
  // during, in place of a made-up failure message (an earlier build's
  // error would read without its verdict).
  'model.message': { version: 16, listing: 'none' },
  // v2: the causes are `compaction` and `fork` alone (an earlier build's edit
  // of another cause would fail its run as damaged rather than read as that
  // build's).
  // v3: media parts by address, as `model.message` v5.
  // v4: no OpenRouter protocol, as `model.message` v6.
  // v5: no `vscode-lm` origin, as `model.message` v7.
  // v6: the priced usage's cache writes are `cacheWriteTokens`, as
  // `model.message` v8.
  // v7: a compaction may be triggered by an `overflow`, the request the
  // model's window could not hold (an earlier build would refuse the trigger
  // as damaged).
  'context.edit': { version: 7, listing: 'none' },
  'tool.intent': { ...V1, listing: 'none' },
  // v2: the guest's latest title is `section`, not `phase` (an earlier
  // build's row would fail as damaged).
  // v3: no `stageId`: a script's calls open under the stage its own card's
  // id names (an earlier build would read this build's row as damaged).
  'script.call': { version: 3, listing: 'none' },
  // v2: a captured attachment holds its bytes by blob address, never inline.
  // v3: an executed result names the files its call read (`reads`), which an
  // edit of an existing file requires; an earlier build's row would read as a
  // call that read nothing, and the run's edits would be refused (nothing
  // records what that build's calls read).
  // v4: no `diagnostics`; an earlier build's row holding them would have
  // them silently dropped.
  'tool.result': { version: 4, listing: 'none' },
  // v2: no `continuation`: goal mode is a script, and a waiting run never
  // continues itself (an earlier build's row names a plugin continuation this
  // build has none of).
  // v3: each tool records whether the step's requests send its declaration
  // (`sent`); an earlier build's row would send every tool directly.
  // v4: the modules a script may import (`modules`); an earlier build's row
  // would resume a script against the modules shipped now.
  'tools.offered': { version: 4, listing: 'none' },
  'context.blob': { ...V1, listing: 'none' },
  // v2: a `PreToolUse` answer is `decision` (allow, deny, ask) with its
  // `reason` and `updatedInput`, not a `deny` reason alone (an earlier
  // build's row has no decision to read).
  'hook.outcome': { version: 2, listing: 'none' },
};

/**
 * The listing type the fold keys `latest` by, from the kind's listing class,
 * or null for a kind the listing leaves out. `plugin.fact` holds several
 * kinds on one type, so it is read grouped by kind as well (`listingKeyOf`,
 * `Database`).
 */
export function listingTypeOf(
  event: Pick<SessionRowDraft, 'type'>,
): string | null {
  const { listing } = ROW_KINDS[event.type];
  if (listing === 'none') return null;
  return listing === 'own' ? event.type : listing;
}

/**
 * Whether one call proceeds, decided once, in an order that makes a
 * permission cover the operation that actually runs: what the call's
 * `PreToolUse` hooks said and how they rewrote it (recorded by `preToolUse`,
 * so a resume reads them back), the final input decoded again, the paths it
 * writes checked, then the policy's one reading ({@link sessionPermission})
 * over that input, whose ask opens the call's request through the run's
 * cell. A tool whose body opens its own request (an edit's review, a plan,
 * a delegation proposal) is decided there, after its proposal exists, with
 * the hooks' answer on `RunCall.hook`; a question it asks is no permission.
 * A body's own requests go through `callRequests`.
 */
import { isDeepStrictEqual } from 'node:util';

import { Context, Effect, Result, Schema } from 'effect';

import {
  ToolContext,
  type CallRequests,
  type ITool,
} from '@agent/core/tools/ToolTypes';
import {
  approvalPolicyDenialMessage,
  decideApproval,
  isApprovalDenied,
} from '@shared/approvalPolicy';
import {
  grantHeld,
  qualifyAggregateId,
  type DecisionOf,
  type HookOutcomePayload,
  type PermissionPayload,
  PermissionPayloadSchema,
  toJsonValue,
  type ToolResult,
} from '@shared/schemas';
import type { ApprovalBypassKind } from '@shared/approvalBypassKind';
import type { DatabaseReadFailed } from '@shared/session/database';
import { callRequestId, type AttemptRequests } from '@shared/session/inFlight';
import {
  Approvals,
  SessionLog,
  type CellError,
  type RunCell,
} from '@shared/session/runHistory';
import type { RunHistoryDraft } from '@shared/session/runState';
import type {
  ApprovalOperation,
  ApprovalsWithPermission,
  HookAnswer,
  SessionApprovals,
} from '@shared/session/sessionApprovals';
import type { LogWriteError } from '@shared/session/sessionLog';
import { assertWritable, resolveToolPath } from '@tools/pathResolution';
import { ensureError } from '@utils/errors/errorMessage';

import { Interactions } from '../HostInteractions';
import { decideRequest, openRequest, recordedDecision } from '../requests';
import { RunCall, requireToolRun } from '../RunCall';
import { askCommandApproval, commandRejectedResult } from './commandApproval';
import type { AgentRunShape } from '../run/AgentRun';
import type { SessionServices } from '../rootLaunch';
import type { PluginToolServices } from '../ToolServices';
import type { preToolUse } from './hooks';

const JSON_OBJECT_ARGUMENTS = Schema.Record(Schema.String, Schema.Unknown);

/** Each operation a run asks permission for: the grant that answers it. A
 *  call of a tool that declares no `command.grant` takes the run's
 *  delegated-work grant, so a command grant never approves it. */
const OPERATIONS = {
  bash: 'bash',
  call: 'superYolo',
  toolEdit: 'toolEdit',
  plan: 'superYolo',
  proposal: 'superYolo',
} as const satisfies Record<ApprovalOperation, ApprovalBypassKind>;

/**
 * The one reading of the policy for an operation of a run, with what the
 * call's `PreToolUse` hooks said: `never`, or an ask nobody can answer,
 * denies whatever a hook said; else a hook's `ask` asks and its `allow`
 * answers what the policy would ask.
 */
export const sessionPermission =
  (
    approvals: Pick<SessionApprovals, 'policy' | 'bypass'>,
    interactions: Interactions['Service'],
  ): ApprovalsWithPermission['permission'] =>
  (runId, operation, hook) => {
    const grant = OPERATIONS[operation];
    const canPresent = !interactions.approvalPromptsUnavailable;
    const policy = approvals.policy(runId);
    const decision = decideApproval({
      policy,
      scopedBypass: grantHeld(
        (kind) => approvals.bypass(runId, kind) !== null,
        grant,
      ),
      canPresent,
    });
    const denied = isApprovalDenied(decision)
      ? decision
      : hook === 'ask' && !canPresent && 'deny-unpresentable';
    if (denied)
      return { action: 'deny', reason: approvalPolicyDenialMessage(denied) };
    return hook ?? (decision === 'allow' ? 'allow' : 'ask');
  };

/** A call's recorded `PreToolUse` outcomes, and how a rewrite reads. */
type CallHooks = Pick<
  Effect.Success<ReturnType<typeof preToolUse>>,
  'outcomes' | 'fromHook'
>;

/** What a call's `PreToolUse` hooks said together, `deny` over `ask` over
 *  `allow`, and the input they rewrote it to. Two different rewrites deny:
 *  the hooks disagree about what would run. */
const answerOf = (outcomes: readonly HookOutcomePayload[]) => {
  const rewritten = outcomes.find((o) => o.updatedInput)?.updatedInput ?? null;
  const denials = outcomes.flatMap(({ plugin, decision, reason }) =>
    decision === 'deny' ? [`${reason} (hook of ${plugin})`] : [],
  );
  // Compared as script replay compares a call: key order is not a
  // different operation.
  if (
    outcomes.some(
      (o) => o.updatedInput && !isDeepStrictEqual(o.updatedInput, rewritten),
    )
  )
    denials.push('the hooks rewrote the call to different inputs');
  // An `allow` about the input another hook then rewrote is about a
  // different operation.
  const hook = (['ask', 'allow'] as const).find((answer) =>
    outcomes.some(
      (o) =>
        o.decision === answer &&
        (answer === 'ask' || !rewritten || o.updatedInput !== null),
    ),
  );
  const deny = denials.length === 0 ? null : denials.join('\n');
  return { deny, hook, rewritten };
};

const hookDenied = (tool: string, why: string): ToolResult => ({
  status: 'error',
  error: `Blocked by a PreToolUse hook: ${why}`,
  diagnostics: { code: 'hook_denied', tool },
});

/** The result that replaces the call when the chain stops it over its
 *  final `input`, and `undefined` when its body may run. */
const rejection = Effect.fn('toolUse.guard')(function* (
  tool: ITool<Error, PluginToolServices>,
  input: unknown,
  hook: HookAnswer,
  rewritten: boolean,
): Effect.fn.Return<ToolResult | undefined, Error, PluginToolServices> {
  const { guard, definition } = tool;
  // The loop asks about a command, a tool that requires approval, and a call
  // a hook asked about. A tool whose body opens its own request (`'inBody'`)
  // answers the hook there, from `RunCall.hook`.
  const asks =
    guard?.command !== undefined ||
    tool.requiresApproval === true ||
    (hook === 'ask' && tool.requiresApproval === undefined);
  if (!guard?.writes && !asks && !rewritten) return undefined;
  // The chain reads the call's own validated arguments, from the same schema
  // `call` validates with; a tool whose parameters are a pass-through JSON
  // Schema (an MCP server's) takes a JSON object, as its `call` checks. A
  // guarded tool with no schema would have the guard quietly stop gating it,
  // so it is a defect, not a skip.
  const schema =
    definition.schema ??
    (definition.parameters ? JSON_OBJECT_ARGUMENTS : undefined);
  if (!schema && guard !== undefined)
    return yield* Effect.die(
      new Error(
        `Tool ${definition.name} is guarded but declares no schema: the guard has no arguments to read.`,
      ),
    );
  const parsed = schema && Schema.decodeUnknownResult(schema)(input);
  if (parsed && !Result.isSuccess(parsed))
    // An issued input the schema refuses reaches no prompt and no path: the
    // `call` below re-reads it and reports the validation error. A rewrite
    // it refuses is the hook's, and denies the call.
    return rewritten
      ? hookDenied(
          definition.name,
          `it rewrote the call to an input ${definition.name} does not take.\n${parsed.failure.message}`,
        )
      : undefined;
  // `ITool` erases the guard's input type to `never`. The guard was declared
  // (`defineTool`) against the type `definition.schema` decodes, and a
  // pass-through-schema tool's against the JSON object it checks.
  // cast: the guard's declared input, per the note above.
  const decoded = (parsed ? parsed.success : input) as never;
  const call = yield* ToolContext;

  // Resolution and the read-only-root check both reject with a `ToolError`
  // the dispatcher reports to the model, so they stay a failure rather than
  // becoming a defect.
  const targets = yield* Effect.try({
    try: () => guard?.writes?.(decoded) ?? [],
    catch: ensureError,
  });
  for (const target of targets) {
    const path = yield* resolveToolPath(call.env, target);
    yield* assertWritable(path, path.display);
  }

  if (!asks) return undefined;
  // The call as the prompt shows it: the guard's spelling, else the tool's
  // name and its final input.
  const command = guard?.command
    ? guard.command.text(decoded)
    : `${definition.name} ${JSON.stringify(decoded)}`;
  // The directory the approved command runs in, as the tool declared it.
  // `'unknown'`: the executor can name none, so the prompt names none rather
  // than a directory the approved command may not run in, and the call's own
  // directory is not read at all; a call with no command spelling runs in no
  // directory either. Otherwise the call's working directory when it named
  // one and the workspace otherwise, which is what a shell-shaped tool runs
  // in.
  const cwd =
    guard?.command && guard.command.cwd !== 'unknown'
      ? (call.env.workingDirectory ?? call.env.roots.workspace)
      : undefined;

  const operation = guard?.command?.grant ?? 'call';
  const { run, requests, session } = yield* requireToolRun(
    'A call the loop asks about',
  );
  const approvals = Context.get(session, Approvals);
  const answer = approvals.permission(run.runId, operation, hook);
  if (answer === 'allow') return undefined;
  const decision =
    answer === 'ask'
      ? yield* askCommandApproval(run.runId, requests, {
          command,
          cwd,
          grant: hook === 'ask' ? null : OPERATIONS[operation],
        })
      : answer;
  return decision.action === 'approve'
    ? undefined
    : commandRejectedResult(command, decision);
});

/** One call through the chain, over the `issued` input and its recorded
 *  `hooks`: its rejection, else the tool's body on the final input, which
 *  `bodyStarts` is handed (and records) once the chain has let it run. */
export const guardedToolCall = (
  tool: ITool<Error, PluginToolServices>,
  issued: unknown,
  hooks: CallHooks = { outcomes: [], fromHook: (input) => input },
  bodyStarts: (input: unknown) => Effect.Effect<void, Error> = () =>
    Effect.void,
): ReturnType<ITool<Error, PluginToolServices>['call']> => {
  const { deny, hook, rewritten } = answerOf(hooks.outcomes);
  if (deny !== null)
    return Effect.succeed(hookDenied(tool.definition.name, deny));
  const input = rewritten === null ? issued : hooks.fromHook(rewritten);
  return rejection(tool, input, hook, rewritten !== null).pipe(
    Effect.flatMap((rejected) =>
      rejected
        ? Effect.succeed(rejected)
        : Effect.andThen(bodyStarts(input), tool.call(input)).pipe(
            Effect.updateService(RunCall, (call) => call && { ...call, hook }),
          ),
    ),
  );
};

/**
 * One tool call's requests (`CallRequests`), opened through its run's loop
 * under ids its attempt (`at`) derives: a fresh one past every ordinal it
 * `raised`. A resumed attempt joins the request it left `standing` when it
 * asks that kind again; one it no longer asks is retired as cancelled
 * (`retireStanding`, which the call's settlement runs too), so no surface
 * keeps offering it; a retirement the store refuses fails the call with the
 * refusal, which ends the run like any refused write. `commit` commits rows
 * of the call.
 */
export const callRequests = (
  run: Pick<AgentRunShape, 'runId'>,
  session: Context.Context<SessionServices>,
  cell: Pick<RunCell, 'opened'>,
  commit: (
    rows: readonly RunHistoryDraft[],
  ) => Effect.Effect<unknown, CellError>,
  at: Parameters<typeof callRequestId>[0],
  raised: number,
  standing: AttemptRequests['own'],
  retireCause: string,
): {
  readonly requests: CallRequests;
  readonly retireStanding: Effect.Effect<
    void,
    DatabaseReadFailed | LogWriteError
  >;
} => {
  const { runId } = run;
  const log = Context.get(session, SessionLog);
  const interactions = Context.get(session, Interactions);
  let reentering = standing;
  let opened = raised;
  // Through the decision's own check, so an answer a surface landed
  // meanwhile stands and the retirement writes nothing. `retireCause` is
  // why the call no longer asks: a resume that re-entered without it, or
  // a script that ended before the call settled.
  const retireStanding = Effect.suspend(() => {
    const open = reentering?.request.decision === null ? reentering : null;
    reentering = null;
    if (open === null) return Effect.void;
    return Effect.asVoid(
      decideRequest(runId, open.requestId, {
        action: 'cancel',
        cause: retireCause,
      }).pipe(Effect.provideService(SessionLog, log)),
    );
  });
  const requests: CallRequests = {
    nextId: (kind) =>
      reentering?.request.payload.kind === kind
        ? reentering.requestId
        : callRequestId(at, opened + 1),
    open: (payload, blobs) =>
      Effect.suspend(() => {
        const reentered =
          payload.data.requestId === reentering?.requestId ? reentering : null;
        if (reentered !== null) reentering = null;
        else if (payload.data.requestId === callRequestId(at, opened + 1))
          opened += 1;
        // Answered before this owner's loop reached the call: the answer
        // is the row's.
        // `nextId` rejoins only the same kind. Return the durable payload,
        // not the recomputation whose blobs are discarded on re-entry.
        const answered = (decision: DecisionOf<(typeof payload)['kind']>) => ({
          // cast: the derived request id rejoins only this payload's kind.
          payload: (reentered?.request.payload ?? payload) as Extract<
            PermissionPayload,
            { kind: (typeof payload)['kind'] }
          >,
          decision,
        });
        if (reentered?.request.decision != null)
          return recordedDecision(payload, reentered.request.decision).pipe(
            Effect.map(answered),
          );
        return Effect.flatMap(RunCall, (call) =>
          openRequest(runId, payload, {
            ...(blobs && { blobs }),
            ...(call?.hook && { hook: call.hook }),
            reentered: reentered !== null,
            // Open already: only what the policy decides commits, and the
            // decision is read from where the resume read the run. Fresh:
            // the standing request of another kind is retired first.
            commit: (rows) =>
              reentered !== null
                ? rows.length === 0
                  ? Effect.succeed(cell.opened.commit)
                  : commit(rows).pipe(Effect.as(cell.opened.commit))
                : retireStanding.pipe(
                    Effect.andThen(Effect.sync(() => log.now())),
                    Effect.flatMap((from) =>
                      commit(rows).pipe(Effect.as(from)),
                    ),
                  ),
          }),
        ).pipe(Effect.provide(session), Effect.map(answered));
      }),
    post: (requestId, request) =>
      Effect.suspend(() =>
        commit([
          {
            type: 'request.opened',
            aggregateId: qualifyAggregateId('run', runId),
            requestId,
            // A plugin's data as the JSON its row stores; one that is not
            // JSON is a defect of the plugin.
            payload: Schema.decodeUnknownSync(PermissionPayloadSchema)(
              toJsonValue(request),
            ),
          },
        ]),
      ).pipe(Effect.asVoid),
    present: interactions.emit.bind(interactions),
  };
  return { requests, retireStanding };
};

/**
 * Whether one call proceeds, decided once, in an order that makes a
 * permission cover the operation that actually runs: what the call's
 * `PreToolUse` hooks said and how they rewrote it (recorded by `StepHooks.preToolUse`,
 * so a resume reads them back), the final input decoded again, the paths it
 * writes checked, then the policy's one reading (`sessionPermission`, as
 * `Approvals.permission`) over that input, whose ask opens the call's
 * request through the run's cell. The hooks' answer is on `RunCall.hook`
 * for the whole call: a tool whose body opens its own request (an edit's
 * review, a plan, a delegation proposal) is decided there, after its
 * proposal exists; a question it asks is no permission. A body's own
 * requests go through `callRequests`.
 */
import { isDeepStrictEqual } from 'node:util';

import { Context, Effect, Option, Result, Schema } from 'effect';

import {
  ToolContext,
  type CallRequests,
  type ITool,
} from '@tools/core/ToolTypes';
import {
  type DecisionOf,
  type HookOutcomePayload,
  type RefusalDecision,
  type RequestPayload,
  RequestPayloadSchema,
  type RunId,
  toJsonValue,
  ToolError,
  type ToolResult,
} from '@shared/schemas';
import { refusalCopy } from '@shared/session/approvalDecision';
import {
  callRequestId,
  type AttemptRequests,
  type CallAttempt,
} from '@shared/session/inFlight';
import { Approvals, type CellError } from '@shared/session/runHistory';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';
import type {
  ApprovalOperation,
  HookAnswer,
} from '@shared/session/sessionApprovals';
import { assertWritable, resolveToolPath } from '@tools/pathResolution';
import { errorResult } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { previewLabel } from '@utils/text/stringUtils';

import { Interactions } from '../HostInteractions';
import { decisionOf, openRequest, recordedDecision } from '../requests';
import { RunCall } from '../RunCall';
import type { AgentRunShape } from '../run/AgentRun';
import type { SessionServices } from '../rootLaunch';
import type { PluginToolServices } from '../ToolServices';
import type { StepHooks } from './hooks';

const DEFAULT_BASH_REJECTION_GUIDANCE =
  'Do not retry this rejected command or another approval-gated shell command for the same check. ' +
  'Continue without running it, use a non-shell method, or explain what approval would be needed.';

/**
 * Ask the person about `command`: a `request.opened` on the run, answered
 * by a surface's `request.decide`, or by the grant that answers it turned
 * on meanwhile, which answers every open request it covers. `operation`
 * says which grant that is: the shell's command grant (`'bash'`), or, for
 * another tool's call, the delegated-work grant; a `PreToolUse` hook that
 * asked leaves it to a person.
 */
const askCommandApproval = Effect.fn('askCommandApproval')(function* (
  runId: RunId,
  requests: CallRequests,
  ask: {
    readonly command: string;
    readonly cwd: string | undefined;
    readonly operation: Extract<ApprovalOperation, 'bash' | 'call'>;
  },
): Effect.fn.Return<DecisionOf<'bash'>, Error> {
  // The payload every host lists: a blank directory is dropped, so no
  // renderer decides what an empty `cwd` means.
  const cwd = ask.cwd?.trim();
  const { decision } = yield* requests.open(
    {
      kind: 'bash',
      data: {
        requestId: requests.nextId(),
        command: ask.command,
        ...(cwd && { cwd }),
        runId,
      },
    },
    { operation: ask.operation },
  );
  return decision;
});

/** What the model is told when the person refuses `command`. */
function commandRejectedResult(
  command: string,
  refusal: RefusalDecision,
): ToolResult {
  const preview = previewLabel(command);
  const copy = refusalCopy('Command', refusal);
  const message =
    refusal.action === 'reject'
      ? `User rejected command: ${preview}`
      : `${copy.summary}: ${preview}`;
  const guidance =
    refusal.action === 'reject' ? DEFAULT_BASH_REJECTION_GUIDANCE : copy.detail;
  const feedback = copy.feedback;
  const error = feedback || !guidance ? message : `${message}\n\n${guidance}`;
  return errorResult(error, {
    summary: message,
    ...(feedback && { userInstruction: feedback }),
  });
}

const JSON_OBJECT_ARGUMENTS = Schema.Record(Schema.String, Schema.Unknown);

/** A call's recorded `PreToolUse` outcomes, and how a rewrite reads. */
type CallHooks = Pick<
  Effect.Success<ReturnType<StepHooks['preToolUse']>>,
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
});

/** The result that replaces the call when the chain stops it over its
 *  final `input`, and `undefined` when its body may run. */
const rejection = Effect.fn('toolUse.guard')(function* (
  tool: ITool<Error, PluginToolServices>,
  input: unknown,
  hook: HookAnswer,
  rewritten: boolean,
): Effect.fn.Return<
  ToolResult | undefined,
  Error,
  PluginToolServices | SessionServices
> {
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
    catch: (cause) =>
      cause instanceof ToolError
        ? cause
        : new ToolError(toErrorMessage(cause), { cause }),
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
  const { run } = call.env;
  const { requests } = call;
  const approvals = yield* Approvals;
  const answer = approvals.permission(run.runId, operation, hook);
  if (answer === 'allow') return undefined;
  const decision =
    answer === 'ask'
      ? yield* askCommandApproval(run.runId, requests, {
          command,
          cwd,
          operation,
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
): ReturnType<
  ITool<Error, PluginToolServices | SessionServices | RunCall>['call']
> => {
  const { deny, hook, rewritten } = answerOf(hooks.outcomes);
  if (deny !== null)
    return Effect.succeed(hookDenied(tool.definition.name, deny));
  const input = rewritten === null ? issued : hooks.fromHook(rewritten);
  // The hooks' answer is the call's: its command's request reads it as it
  // opens, and so does every request its body opens.
  return rejection(tool, input, hook, rewritten !== null).pipe(
    Effect.flatMap((rejected) =>
      rejected
        ? Effect.succeed(rejected)
        : Effect.andThen(bodyStarts(input), tool.call(input)),
    ),
    Effect.updateService(RunCall, (call) => ({ ...call, hook })),
  );
};

/**
 * One tool call's requests (`CallRequests`), opened through its run's loop
 * under ids its attempt (`at` and `entered.attempt`) derives: each a fresh
 * one, past every ordinal the attempt `raised`. A resumed call joins
 * nothing: a request its last run left open was cancelled when that run
 * ended or this one was activated, so it asks again. Every request opens at
 * the one door (`openRequest`) through `commit`, which commits rows of the
 * call, and a person's answer is the one wait (`decisionOf`).
 */
export const callRequests = (call: {
  readonly run: Pick<AgentRunShape, 'runId'>;
  readonly session: Context.Context<SessionServices>;
  readonly commit: (
    rows: readonly RunHistoryDraft[],
  ) => Effect.Effect<RunState, CellError>;
  readonly at: Omit<CallAttempt, 'attempt'>;
  readonly entered: Pick<AttemptRequests, 'raised'> & {
    readonly attempt: number;
  };
}): CallRequests => {
  const { run, session, commit, entered } = call;
  const { runId } = run;
  const asker = { runId, append: commit };
  const at: CallAttempt = { ...call.at, attempt: entered.attempt };
  const interactions = Context.get(session, Interactions);
  let opened = entered.raised;
  return {
    nextId: () => callRequestId(at, opened + 1),
    open: (payload, opening) =>
      Effect.suspend(() => {
        if (payload.data.requestId === callRequestId(at, opened + 1))
          opened += 1;
        return Effect.gen(function* () {
          // The hook of the call the request opens in, read from its
          // fiber: `CallRequests` is public and requires nothing of its
          // caller.
          const call = yield* Effect.serviceOption(RunCall);
          const hook = Option.isSome(call) ? call.value.hook : undefined;
          const { answer, from } = yield* openRequest(asker, payload, {
            ...opening,
            ...(hook && { hook }),
          });
          if (answer !== null) return answer;
          const decision = yield* decisionOf(
            runId,
            payload.data.requestId,
            from,
          );
          return yield* recordedDecision(payload, decision);
        }).pipe(
          Effect.provide(session),
          Effect.map((decision) => ({
            // cast: the payload is the request this call opened, of its kind.
            payload: payload as Extract<
              RequestPayload,
              { kind: (typeof payload)['kind'] }
            >,
            decision,
          })),
        );
      }),
    post: (request) =>
      Effect.suspend(() =>
        openRequest(
          asker,
          // A plugin's data as the JSON its row stores; one that is not
          // JSON is a defect of the plugin.
          Schema.decodeUnknownSync(RequestPayloadSchema)(toJsonValue(request)),
        ),
      ).pipe(Effect.provide(session), Effect.asVoid),
    present: interactions.emit,
  };
};

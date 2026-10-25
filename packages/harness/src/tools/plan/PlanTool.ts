/**
 * The plan tool: propose or replace the plan, a plain objective document
 * stating what to achieve, the approach, and a verifiable stopping
 * condition. Every proposal gates on the user's approval: approve, reject,
 * or run the plan as a goal, which runs the goal template (`goalScript`) as
 * a background script of this conversation with the plan as its objective.
 */

// Third-party imports
import { Effect, Result, Schema, SubscriptionRef } from 'effect';

// Local imports
import { requireToolRun, type RunToolCall } from '@agent/runtime/RunCall';
import { goalGrant } from '@agent/runtime/runApprovalQueue';
import { withLogChannel } from '@logger/effectLog';
import {
  NO_APPROVAL_GRANTS,
  type ApprovalBypassKind,
} from '@shared/approvalBypassKind';
import { Settings } from '@shared/config/settings';
import {
  GOAL_MAX_COST_SETTING,
  qualifyAggregateId,
  RunIdSchema,
  type Plan,
  type RunId,
  type ToolResult,
} from '@shared/schemas';
import { refusalOf } from '@shared/session/approvalDecision';
import { launchBackgroundScript } from '@tools/codemode/backgroundScript';
import { defineTool } from '@tools/core/definition';
import { errorResult, executed } from '@tools/core/result';

// Local file imports
import { goalScript } from './goalScript';

const CHANNEL = 'PlanTool';

/** A goal's background script, by its title. */
const GOAL_TITLE = 'Goal';

const PLAN = 'plan';

/** The run a plan answered with a goal launched, on its result. */
const LaunchedSchema = Schema.Struct({ runId: RunIdSchema });

/** How long a goal's script may run: the longest a script may. */
const GOAL_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** What a goal the user armed auto-approves: commands alone, or all agent
 *  work. */
const GOAL_AUTO_APPROVALS: Record<
  'commands' | 'allAgentWork',
  readonly ApprovalBypassKind[]
> = {
  commands: ['bash'],
  allAgentWork: ['superYolo', 'toolEdit', 'bash'],
};

const PlanToolInputSchema = Schema.Struct({
  objective: Schema.String.check(Schema.isMinLength(1)).annotate({
    description:
      'The plan document: what to achieve, the intended approach, and a ' +
      'verifiable stopping condition. Plain prose or markdown - no ' +
      'structured steps.',
  }),
});

type PlanToolInput = typeof PlanToolInputSchema.Type;

function buildApprovedResult(): ToolResult {
  return executed(
    'Plan approved by the user. Work toward the objective.',
    'Plan approved: proceed with implementation',
  );
}

/**
 * Run the just-approved plan as a goal: the goal template, a background
 * script of this conversation whose rounds are this agent again (`self()`),
 * with the plan document verbatim as its objective and the auto-approvals
 * the user's answer chose on the script's run, which its rounds inherit.
 * The conversation's own approvals stay as they were.
 */
const runPlanAsGoal = Effect.fn('PlanTool.runPlanAsGoal')(function* (
  call: RunToolCall,
  plan: Plan,
  armed: 'commands' | 'allAgentWork',
) {
  // A goal forks a conversation and reports to its later turns: a one-shot
  // run has no later turn, and a script's run is no conversation to fork.
  if (
    call.run.toolPolicy.stopAfterCycle === true ||
    call.run.config.script != null
  )
    return errorResult(
      'A goal runs from a conversation, forks it and reports to its later turns; this run is not one: work on the approved plan in this run instead.',
      { summary: 'Plan approved: no goal outside a conversation' },
    );
  // One goal at a time: two would race each other's edits and caps. The
  // goals this conversation launched are its `plan` results' runs; one is
  // running while its run has not ended, or, unborn while it waits for the
  // child-run budget, while this process holds it. "Keep agents running"
  // detached, a goal is still found by the call that launched it.
  const { session, runId } = call.run;
  const rows = yield* session.log.rows(qualifyAggregateId('run', runId), [
    'model.message',
    'script.call',
    'tool.result',
  ]);
  // A plan call, by the response its result names: a script's call, that of
  // the latest response to issue its `script` call before it.
  const plans = new Set<string>();
  const issuer = new Map<string, string>();
  for (const row of rows)
    if (row.type === 'model.message' && row.payload.kind === 'response')
      for (const { callId, toolName } of row.payload.calls) {
        issuer.set(callId, row.payload.responseId);
        if (toolName === PLAN) plans.add(`${row.payload.responseId}/${callId}`);
      }
    else if (row.type === 'script.call' && row.payload.toolName === PLAN)
      plans.add(
        `${issuer.get(row.payload.scriptCallId)}/${row.payload.callId}`,
      );
  const { runs } = SubscriptionRef.getUnsafe(session.view.ref);
  // A goal that ended still holds the conversation while work it started
  // (a round's background agent) runs on.
  const stillRunning = (id: RunId): boolean => {
    const run = runs.get(id);
    return (
      run !== undefined &&
      (run.durableOutcome === null || run.childIds.some(stillRunning))
    );
  };
  const running = rows
    .flatMap((row) => {
      if (row.type !== 'tool.result') return [];
      const { responseId, callId, result } = row.payload;
      const launched =
        result.status === 'executed'
          ? Schema.decodeUnknownResult(LaunchedSchema)(result.value)
          : undefined;
      const goal =
        launched !== undefined && Result.isSuccess(launched)
          ? launched.success.runId
          : undefined;
      return goal !== undefined && plans.has(`${responseId}/${callId}`)
        ? [goal]
        : [];
    })
    .find((goal) =>
      runs.has(goal)
        ? stillRunning(goal)
        : session.runs.get(goal) !== undefined,
    );
  if (running !== undefined)
    return errorResult(
      `The plan is approved, but a goal is already running (run ${running}): it was not started again. Work on the plan in this conversation, or stop that goal first and run the plan as a goal again.`,
      { summary: 'Plan approved: a goal is already running' },
    );
  const maxCostUsd = yield* Settings.get<number>(
    call.env.roots,
    GOAL_MAX_COST_SETTING.configKey,
  );
  const launched = yield* launchBackgroundScript(
    call,
    {
      code: goalScript(plan.objective, maxCostUsd),
      timeoutMs: GOAL_TIMEOUT_MS,
    },
    GOAL_TITLE,
    goalGrant(GOAL_AUTO_APPROVALS[armed])(NO_APPROVAL_GRANTS),
  );
  return {
    ...launched,
    output:
      `The user approved this plan and runs it as a goal: a background ` +
      `script runs you again in rounds, each continuing this conversation, ` +
      `until a round verifies the stopping condition.\n\n` +
      `${launched.output ?? ''}\n\n` +
      `Leave the objective to the goal's rounds: end this turn, and report ` +
      `the goal's result to the user when it arrives.`,
    summary: 'Plan approved: running as a goal',
  } satisfies ToolResult;
});

/** Show `plan` as the run's plan (null clears it): the run's `plan` fact,
 *  and the progress a parent of this run reads. */
const showPlan = (call: RunToolCall, plan: Plan | null): void => {
  call.run.logger.emit({ type: 'run.fact', fact: { key: 'plan', plan } });
  call.run.callbacks.onProgress?.({ kind: 'plan', plan });
};

/**
 * Request user approval for a new plan. Pauses run until approved/rejected.
 */
const requestApproval = Effect.fn('PlanTool.requestApproval')(function* (
  call: RunToolCall,
  plan: Plan,
  runId: RunId,
) {
  const requestId = call.requests.nextId('planApproval');

  yield* Effect.logInfo('Requesting approval for plan objective').pipe(
    withLogChannel(CHANNEL),
  );

  const result = yield* call.requests.open({
    kind: 'planApproval',
    // The tool is offered only while the goal plugin is on, so the user can
    // always run an approved plan as a goal.
    data: { requestId, runId, plan },
  });

  if (result.action === 'approve') {
    yield* Effect.logInfo('Plan approved by user').pipe(
      withLogChannel(CHANNEL),
    );
    return buildApprovedResult();
  }

  if (result.action === 'approve_and_goal') {
    yield* Effect.logInfo('Plan approved by user with goal mode').pipe(
      withLogChannel(CHANNEL),
    );
    return yield* runPlanAsGoal(
      call,
      plan,
      result.autoApproveAll ? 'allAgentWork' : 'commands',
    );
  }

  // Rejected — clear the plan from UI
  showPlan(call, null);

  const refusal = refusalOf('planApproval', result);

  // 'cancelled' and 'policy' differ only in wording: a host cancel with an
  // optional cause vs a policy denial with its reason.
  const denialResult = (
    outcome: string,
    detail?: string,
  ): Effect.Effect<ToolResult> => {
    const trimmed = detail?.trim();
    return Effect.logInfo(`Plan approval ${outcome}`).pipe(
      Effect.annotateLogs(trimmed ? { data: trimmed } : {}),
      withLogChannel(CHANNEL),
      Effect.as(
        errorResult(
          trimmed
            ? `Plan approval was ${outcome}.\n\n${trimmed}`
            : `Plan approval was ${outcome}.`,
          { summary: `Plan approval ${outcome}` },
        ),
      ),
    );
  };

  switch (refusal.action) {
    case 'cancel':
      return yield* denialResult('cancelled', refusal.cause ?? undefined);
    case 'deny':
      return yield* denialResult('denied', refusal.reason);
    case 'reject': {
      const feedback = refusal.feedback?.trim();
      const feedbackNote = feedback
        ? `\nUser feedback: ${feedback}`
        : '\nNo specific feedback was provided.';

      yield* Effect.logInfo('Plan rejected by user').pipe(
        Effect.annotateLogs({ data: feedback }),
        withLogChannel(CHANNEL),
      );

      return errorResult(
        `The user rejected this plan.${feedbackNote}\nPlease revise your approach based on the feedback and create an updated plan.`,
        {
          summary: 'Plan rejected: revise approach',
          ...(feedback ? { userInstruction: feedback } : {}),
        },
      );
    }
  }
});

const executeUpdate = Effect.fn('PlanTool.executeUpdate')(function* (
  call: RunToolCall,
  plan: Plan,
) {
  showPlan(call, plan);

  // Every update is a (re-)proposal: with no step statuses to record,
  // the only reason to call update is a new or changed objective, and
  // that decision belongs to the user.
  return yield* requestApproval(call, plan, call.run.runId);
});

export const PlanTool = defineTool({
  name: PLAN,
  requiresApproval: 'inBody',
  description: `Propose or replace the plan: \`objective\` is a plain document stating what to achieve, the intended approach, and a verifiable stopping condition. Every proposal is presented to the user, who may approve it, run it as a goal (a goal run then works on it in rounds until it verifies the stopping condition), or reject it. Propose a new plan only when the objective or approach genuinely changes.`,
  schema: PlanToolInputSchema,
  execute: (input: PlanToolInput) =>
    Effect.flatMap(requireToolRun('plan'), (call) =>
      executeUpdate(call, { objective: input.objective }),
    ),
});

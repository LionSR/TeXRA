/**
 * The plan tool: propose or replace the plan, a plain objective document
 * stating what to achieve, the approach, and a verifiable stopping
 * condition. Every proposal gates on the user's approval: approve, reject,
 * or run the plan as a goal, which launches the goal program
 * (`launchGoal`) on this run's own agent with the plan as its objective.
 */

// Third-party imports
import { Effect } from 'effect';
import { z } from 'zod';

// Local imports
import { requireToolRun, type RunToolCall } from '@agent/runtime/RunCall';
import { withLogChannel } from '@logger/effectLog';
import type { Plan, RunId, ToolResult } from '@shared/schemas';
import { refusalOf } from '@shared/session/approvalDecision';
import { launchGoal } from '@tools/goal/GoalTool';
import { defineTool } from '@tools/core/definition';
import { errorResult, executed } from '@tools/core/result';

const CHANNEL = 'PlanTool';

const PlanToolInputSchema = z.strictObject({
  objective: z
    .string()
    .min(1)
    .describe(
      'The plan document: what to achieve, the intended approach, and a ' +
        'verifiable stopping condition. Plain prose or markdown - no ' +
        'structured steps.',
    ),
});

type PlanToolInput = z.infer<typeof PlanToolInputSchema>;

function buildApprovedResult(): ToolResult {
  return executed(
    'Plan approved by the user. Work toward the objective.',
    'Plan approved: proceed with implementation',
  );
}

/**
 * Run the just-approved plan as a goal: the goal program on this run's own
 * agent, the plan document verbatim as its objective, approved by the user's
 * answer with the auto-approvals it chose. In a conversation the goal runs
 * in the background and its result arrives as a follow-up; in a one-shot run
 * the call waits for it.
 */
const runPlanAsGoal = Effect.fn('PlanTool.runPlanAsGoal')(function* (
  call: RunToolCall,
  plan: Plan,
  armed: 'commands' | 'allAgentWork',
) {
  const launched = yield* launchGoal({
    tool: 'plan',
    objective: plan.objective,
    agentName: call.run.config.agent,
    model: null,
    memories: [],
    workingDirectory: null,
    id: null,
    timeoutMs: null,
    background: null,
    armed,
  });
  if (launched.status !== 'executed') return launched;
  return {
    ...launched,
    output:
      `The user approved this plan and runs it as a goal: a goal run works ` +
      `on it in rounds until a round verifies the stopping condition.\n\n` +
      `${launched.output ?? ''}\n\n` +
      `Do not work on the objective yourself while the goal runs; report ` +
      `its result to the user when it arrives.`,
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
  name: 'plan',
  requiresApproval: 'inBody',
  description: `Propose or replace the plan: \`objective\` is a plain document stating what to achieve, the intended approach, and a verifiable stopping condition. Every proposal is presented to the user, who may approve it, run it as a goal (a goal run then works on it in rounds until it verifies the stopping condition), or reject it. Propose a new plan only when the objective or approach genuinely changes.`,
  schema: PlanToolInputSchema,
  execute: (input: PlanToolInput) =>
    Effect.flatMap(requireToolRun('plan'), (call) =>
      executeUpdate(call, { objective: input.objective }),
    ),
});

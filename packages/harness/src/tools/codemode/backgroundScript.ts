/**
 * A `script` call sent to the background: the call returns, once that run's
 * opening has committed, with the id of a child run that makes the same
 * call, `{ kind: 'script', title }`. A launch that fails before the run
 * exists fails the call, so the model reads the failure in the call's own
 * result instead of waiting for a follow-up that never comes.
 * That run is the parent's agent with the parent's tools, model and working
 * directory, opened on the call (`AgentConfig.script`); its result reaches
 * the parent as one follow-up (`childEndReport`), and a resume
 * replays it from its own rows.
 */
import { Effect, Schema, ScopedRef } from 'effect';

import { prepareAgentDefinition } from '@agent/runtime/AgentLaunchContext';
import { offeredBy } from '@agent/runtime/loop/step';
import { type RunToolCall } from '@agent/runtime/RunCall';
import {
  agentChildRunId,
  earlierChild,
} from '@agent/runtime/delegation/agentChild';
import { childRunDescription } from '@agent/runtime/delegation/childRun';
import { startChildRun } from '@agent/runtime/delegation/childLaunch';
import type { ApprovalGrants } from '@shared/approvalBypassKind';
import {
  AgentConfigSchema,
  SCRIPT_TOOL_NAME,
  type RunId,
} from '@shared/schemas';
import { executed } from '@tools/core/result';

/** What the model reads for a script sent to the background. */
const receipt = (title: string, runId: RunId, again: boolean) => ({
  ...executed(
    [
      again
        ? `The script '${title}' was sent to the background by an earlier attempt of this call; its result arrives as a follow-up.`
        : `The script '${title}' runs in the background; its result and summary arrive as one follow-up message when it ends. Continue other work meanwhile.`,
      `Run ID: ${runId}`,
      `To look at its calls without waiting: executions tool with path=/executions/${runId}.`,
    ].join('\n'),
    `Script '${title}' running in the background`,
  ),
  value: { runId },
});

/**
 * Launch the background run of a `script` call. The run is named by the
 * call and its attempt, so a resumed call finds the run an earlier attempt
 * launched instead of launching a second.
 */
export const launchBackgroundScript = Effect.fn('script.background')(function* (
  call: RunToolCall,
  input: { readonly code: string; readonly timeoutMs?: number },
  title: string,
  /** The grants its run starts with, beyond what it inherits: a goal's
   *  auto-approvals, which the user's plan answer chose. */
  grants?: ApprovalGrants,
) {
  const { run } = call;
  const { runId: parentRunId } = run;
  const earlier = yield* earlierChild(call);
  if (earlier !== null) return receipt(title, earlier, true);
  const bound = yield* ScopedRef.get(run.model);
  const runId = agentChildRunId(call);
  const workingDirectory =
    call.env.workingDirectory ?? run.config.workingDirectory;
  const offered = yield* offeredBy(run);
  // The parent's agent, model and tools, opened on the call rather than on
  // a prompt: it reads no input files and renders no instruction.
  const definition = yield* prepareAgentDefinition({
    config: Schema.decodeUnknownSync(AgentConfigSchema)({
      ...run.config,
      model: bound.modelId,
      instruction: '',
      displayInstruction: null,
      inputFiles: [],
      contextFiles: [],
      mediaFiles: [],
      outputFiles: [],
      memories: [],
      outputSchema: null,
      cli: null,
      workingDirectory: workingDirectory ?? null,
      delegationAgentScope: run.config.delegationAgentScope ?? null,
      script: {
        code: input.code,
        title,
        // The tools its parent's step offered it, less the parent's own
        // terminal tool and the script tool its run adds itself.
        tools: offered.flatMap(({ name, plugin }) =>
          plugin === 'run' || name === SCRIPT_TOOL_NAME ? [] : [name],
        ),
        ...(input.timeoutMs !== undefined && { timeoutMs: input.timeoutMs }),
        kind: 'background',
      },
    }),
  });
  // The script's opening commits here, under the session's runs; a launch
  // that fails before it fails this call.
  yield* startChildRun(runId, definition, {
    identity: { kind: 'script', title },
    parentRunId,
    parentCall: { callId: call.callId, card: call.logId, awaited: false },
    description: childRunDescription(title),
    ...(grants !== undefined && { grants }),
  });
  return receipt(title, runId, false);
});

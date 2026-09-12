// Third-party imports
import { z } from 'zod';
import { Cause, Effect, Exit, Fiber } from 'effect';

// Local imports
import { getRunRecords } from '@agent/storage';
import {
  deriveWorkflowScriptCheckpointId,
  readWorkflowScriptCheckpoint,
} from '@agent/workflowScript/checkpoint';
import { parseWorkflowScript } from '@agent/workflowScript/parseScript';
import { ToolCall } from '@agent/runtime/ToolCall';
import { registerRun } from '@agent/storage/runLifecycle';
import { RunLeaseActiveError } from '@agent/storage/runLease';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import type { ToolServices } from '@agent/runtime/ToolServices';
import { aggregateId } from '@shared/schemas';
import type { ToolResult, WorkflowAgentProposal } from '@shared/schemas';
import {
  AgentCategory,
  DEFAULT_TOOL_CONFIG,
  JsonValueSchema,
  RUN_OUTCOME,
  ToolError,
  USER_FOLLOW_UP_SUPPORT,
  WorkflowScriptFilesSchema,
} from '@shared/schemas';
import { DELEGATE_MULTI_AGENTS_TOOL_NAME } from '@shared/constants/delegationTools';
import { configureDelegatedChildApprovals } from '@tools/approval';
import {
  assertWritable,
  resolveWorkspaceRelativePath,
} from '@tools/pathResolution';
import { defineTool } from '@tools/core/define';
import { errorResult, executed } from '@tools/core/result';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { deriveRunId } from '@utils/core/idHash';
import { childRunDescription, createChildRun } from './childRun';

// Local file imports
import { startDetachedChildRunLoop } from './detachedChildRun';
import { createWorkflowScriptAgentRunner } from './workflowScriptAgentRunner';
import {
  createWorkflowScriptStrategy,
  formatWorkflowScriptReference,
} from './workflowScriptStrategy';
import {
  assertWorkflowFilesExist,
  fingerprintWorkflowAgentDependencies,
  rejectOversizedBibAttachments,
} from './inputFields';
import { selectAvailableDelegationModel } from './delegationAvailability';
import {
  proposalResultToToolResult,
  requestDelegationProposal,
  requireDelegationParent,
  requireWorkflowOrToolUseAgent,
} from './proposalFlow';

const WorkflowScriptToolInputSchema = z
  .strictObject({
    agent: z
      .string()
      .min(1)
      .describe(
        'Default workflow agent used when agent() omits agentName. Part of the checkpoint identity with meta.name: resume with the same value; a different agent starts a new journal.',
      ),
    args: z
      .unknown()
      .nullish()
      .describe('JSON value exposed to the script as the global args value.'),
    files: WorkflowScriptFilesSchema.nullish().describe(
      'Workspace files bound to the workflow run by role and exposed to the script as the immutable global files object.',
    ),
    script: z
      .string()
      .min(1)
      .nullish()
      .describe(
        'Complete newly submitted workflow script source beginning with an export const meta object. Provide exactly one of script or scriptPath.',
      ),
    scriptPath: z
      .string()
      .min(1)
      .nullish()
      .describe(
        'Path to a previously saved editable workflow script file, resolved by the normal tool path policy. Provide exactly one of script or scriptPath.',
      ),
  })
  .superRefine((input, ctx) => {
    if (input.args != null && !JsonValueSchema.safeParse(input.args).success) {
      ctx.addIssue({
        code: 'custom',
        message: 'Workflow arguments must contain valid JSON values.',
        path: ['args'],
      });
    }
    if ((input.script == null) === (input.scriptPath == null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide exactly one of script or scriptPath.',
        path: ['script'],
      });
    }
  });

type WorkflowScriptToolInput = z.infer<typeof WorkflowScriptToolInputSchema>;

const WORKFLOW_SCRIPT_DIRECTORY = '.texra/workflow-scripts';

function workflowScriptDraftStem(id: string): string {
  const slug = id
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return `draft-${slug || 'workflow'}`;
}

const persistWorkflowScript = Effect.fn('persistWorkflowScript')(function* (
  script: string,
  submissionId: string,
  workingDirectory: string | undefined,
  inScope: <A>(operation: () => A) => A,
) {
  const directory = inScope(() =>
    resolveWorkspaceRelativePath(WORKFLOW_SCRIPT_DIRECTORY, workingDirectory),
  );
  assertWritable(directory, WORKFLOW_SCRIPT_DIRECTORY);
  yield* Effect.tryPromise({
    try: () => inScope(() => WorkspaceFS.ensureDir(directory.fsPath)),
    catch: ensureError,
  });
  const stem = workflowScriptDraftStem(submissionId);
  for (let suffix = 0; ; suffix += 1) {
    const filename = suffix === 0 ? `${stem}.mjs` : `${stem}-${suffix + 1}.mjs`;
    const resolved = inScope(() =>
      resolveWorkspaceRelativePath(
        `${WORKFLOW_SCRIPT_DIRECTORY}/${filename}`,
        workingDirectory,
      ),
    );
    assertWritable(resolved, resolved.relative);
    const exists = yield* Effect.tryPromise({
      try: () => inScope(() => WorkspaceFS.exists(resolved.fsPath)),
      catch: ensureError,
    });
    if (exists) {
      const existing = yield* Effect.tryPromise({
        try: () => inScope(() => WorkspaceFS.read(resolved.fsPath)),
        catch: ensureError,
      });
      if (existing === script) {
        return resolved.relative;
      }
      continue;
    }
    yield* Effect.tryPromise({
      try: () => inScope(() => WorkspaceFS.write(resolved.fsPath, script)),
      catch: ensureError,
    });
    return resolved.relative;
  }
});

function workflowScriptToolError(
  error: unknown,
  scriptPath: string,
): ToolError {
  return new ToolError(
    `${toErrorMessage(error)}\n\n${formatWorkflowScriptReference(scriptPath)}`,
    { cause: error },
  );
}

function withScriptReference(
  result: ToolResult,
  scriptPath: string,
): ToolResult {
  const reference = formatWorkflowScriptReference(scriptPath);
  if (result.status === 'error') {
    return {
      ...result,
      error: `${result.error}\n\n${reference}`,
    };
  }
  return {
    ...result,
    output: [result.output, reference].filter(Boolean).join('\n\n'),
  };
}

/**
 * Execute a durable, deterministic workflow script from an agent whose tool
 * list names it. Gated by the "Multi-Agent Workflow" dashboard switch (id
 * `workflow-script` in {@link @tools/externalToolDefs}), which
 * `resolveAgentTools()` enforces regardless of any agent's configured tools -
 * new installs start with the switch off.
 */
export class WorkflowScriptTool extends defineTool({
  name: DELEGATE_MULTI_AGENTS_TOOL_NAME,
  // The script runner is bi-categorical (plain agent() calls use the workflow
  // roster; structured calls name tool-use agents explicitly). The workflow
  // roster is what the description advertises.
  availabilityCategory: 'workflow',
  slow: true,
  description: `Run a deterministic JavaScript workflow that coordinates workflow agents and tool-use agents in parallel. Workflow agent calls (with inputFiles) resolve to a result envelope { category: 'workflow', outcome, outputs, diffs, compileFailures, cost } listing the files they produced, never prose. Tool-use agent calls (with agentName, model, schema) resolve to a structured JSON result via agent().structured: use these for analysis, code edits, test runs, and any task that benefits from a focused interactive agent rather than a whole-document rewriter. Use \`delegate_multi_agents\` only when the complete fan-out, pipeline, and join structure is known before run and should resume safely after interruption. Keep using \`delegate_agent\` one call at a time when a later decision depends on reviewing an earlier result.

Script input: every source submission is saved immediately as a unique, non-overwriting draft under .texra/workflow-scripts/. Every result returns that editable path; on an error, edit the file and retry with scriptPath instead of rewriting the source.

Script rules:
- Meta: start with an export const meta object containing name and description. No imports or require: only the injected primitives exist: agent, phase, log, parallel, args, and files. Metadata and agent() options reject unknown fields, so typos fail at the saved script instead of being ignored. meta.phases accepts title strings such as ['Draft', 'Merge'] or objects such as [{ title: 'Draft' }].
- Tasks: when the calls are known in advance, declare meta.tasks as { id, label, phase? } records so progress shows the pending plan before run. A task phase must name a title in meta.phases. Every agent() call must then reference one declared task with { id }; omit label and phase from the call because meta.tasks owns them (exact matching duplicates are accepted, but conflicts fail). Omit meta.tasks when the call set is data-dependent.
- Files: the tool's files field binds workspace files to the whole run as files.inputFiles (editable), files.contextFiles (read-only documents), and files.mediaFiles (read-only visual or audio inputs). A workflow agent() call may use inputFiles, contextFiles, and mediaFiles; inputFiles is required unless the agent declares default outputs. Paths may name workspace files, launch files, or a previous call's outputs. Structured (tool-use) agent() calls do not accept file options.
- Calls: every call may use agentName (another visible workflow or tool-use agent; defaults to this tool's agent field) and model (an available model short name for this call); omit model to follow ordinary delegation policy. A call without meta.tasks may also use id, label, and phase. Its logical identity is the explicit id when present, otherwise its call ordinal. Logical ids must be unique. Canonical labels prefer an explicit label, then a meaningful file and agent, then agent role and ordinal.
- Awaiting: agent() and parallel() return Promises: await them. Use ordinary JavaScript loops and awaited calls for sequential stages.
- Failures: a failed agent call, including a workflow agent that produces no output files, resolves to null. An interactive skip resolves to the truthy '__WORKFLOW_SKIPPED__' sentinel; exclude both non-results before synthesis. JavaScript errors in parallel() thunks fail the workflow and preserve the editable script path rather than being silently converted to null.

Structured output: agent(prompt, { agentName, model, schema }) runs a tool-use agent that finishes by calling submit_output with a value matching the JSON Schema. Structured calls do not accept file options and must name the tool-use agent explicitly; model remains optional. The call resolves to an envelope whose .structured is the validated object rather than edited files.

Async: this tool returns immediately with a run ID and runs the workflow as its own detached run. The script's return value plus the run log (phases, log() lines, per-call outcomes with cost) are delivered back as a follow-up message when the run completes. Check intermediate progress with the executions tool (path=/executions/<id>, action=wait).

Example:
export const meta = {
  name: 'fix-drafts',
  description: 'Fix typos in two drafts',
  phases: ['Fix', 'Merge'],
  tasks: [
    { id: 'first', label: 'Fix first draft', phase: 'Fix' },
    { id: 'second', label: 'Fix second draft', phase: 'Fix' },
    { id: 'merge', label: 'Merge corrected drafts', phase: 'Merge' },
  ],
}
phase('Fix')
const results = await parallel(files.inputFiles.slice(0, 2).map((file, index) => () =>
  agent('Fix spelling errors only.', {
    id: index === 0 ? 'first' : 'second',
    inputFiles: [file],
  })
))
const correctedFiles = results
  .filter((result) => result != null && result !== '__WORKFLOW_SKIPPED__')
  .flatMap((result) => result.outputs.map((output) => output.absolutePath))
phase('Merge')
return await agent('Merge the corrected drafts.', {
  id: 'merge',
  inputFiles: correctedFiles,
})

Durability: the journal is keyed by meta.name and the agent field within this session. If the run times out or is interrupted, call this tool again with the SAME meta.name and the same agent: completed agent() calls replay for free (the script may be revised or reordered; only changed or unfinished calls execute). A different agent starts a new journal. Use a new meta.name to start over. The default whole-run wall clock is 10 minutes; set meta.timeoutMs (1s to 60min) for longer runs.`,
  schema: WorkflowScriptToolInputSchema,
}) {
  protected execute(
    input: WorkflowScriptToolInput,
  ): Effect.Effect<ToolResult, unknown, ToolServices> {
    return Effect.gen(function* () {
      const parent = requireDelegationParent(
        'delegate_multi_agents',
        yield* ToolCall,
      );
      const { session, runId: parentRunId } = parent.run;
      const workingDirectory = parent.workingDirectory;
      let scriptPath: string;
      let script: string;
      if (input.scriptPath != null) {
        const resolved = parent.inScope(() =>
          resolveWorkspaceRelativePath(input.scriptPath!, workingDirectory),
        );
        scriptPath = resolved.relative;
        script = yield* Effect.tryPromise({
          try: () => parent.inScope(() => WorkspaceFS.read(resolved.fsPath)),
          catch: (error) =>
            new ToolError(
              `Unable to read workflow script '${input.scriptPath}': ${toErrorMessage(error)}`,
              { cause: error },
            ),
        });
      } else {
        // The schema's exactly-one refinement guarantees source here.
        script = input.script as string;
        const submissionId =
          parent.toolCallId ??
          deriveRunId({
            parentRunId,
            script,
          });
        scriptPath = yield* persistWorkflowScript(
          script,
          submissionId,
          workingDirectory,
          parent.inScope,
        );
      }

      // Every phase below fails with the same annotation: prefix the
      // underlying error with the saved script reference so the model edits the
      // file and retries with scriptPath instead of rewriting the source.
      const runSyncPhase = <T>(phase: () => T): Effect.Effect<T, ToolError> =>
        Effect.try({
          try: phase,
          catch: (error) => workflowScriptToolError(error, scriptPath),
        });
      const runPromisePhase = <T>(
        phase: () => PromiseLike<T>,
      ): Effect.Effect<T, ToolError> =>
        Effect.tryPromise({
          try: () => parent.inScope(phase),
          catch: (error) => workflowScriptToolError(error, scriptPath),
        });

      const { meta, defaultAgent } = yield* runSyncPhase(() => {
        const { meta } = parseWorkflowScript(script);
        return {
          meta,
          defaultAgent: parent.inScope(() =>
            requireWorkflowOrToolUseAgent(
              input.agent,
              parent.delegationAgentScope ?? undefined,
            ),
          ),
        };
      });
      // Named checkpoint, not content- or toolCallId-keyed: a retrying model
      // rewrites its script, so any key derived from call identity or source
      // text orphans the journal exactly when resume matters (#8666). meta.name
      // is the durable identity; per-entry prompt/options hashes in the journal
      // keep replays honest when the script evolves.
      const checkpointId = deriveWorkflowScriptCheckpointId({
        name: meta.name,
        defaultAgent: defaultAgent.name,
        parentRunId,
      });
      const priorCheckpoint =
        input.files == null
          ? yield* readWorkflowScriptCheckpoint(session, checkpointId).pipe(
              Effect.mapError((error) =>
                workflowScriptToolError(error, scriptPath),
              ),
            )
          : null;
      const files = yield* runPromisePhase(async () => {
        const parsedFiles = WorkflowScriptFilesSchema.parse(
          input.files ?? priorCheckpoint?.files ?? {},
        );
        await assertWorkflowFilesExist([
          { label: 'Workflow input file', files: parsedFiles.inputFiles },
          { label: 'Workflow context file', files: parsedFiles.contextFiles },
          { label: 'Workflow media file', files: parsedFiles.mediaFiles },
        ]);
        return parsedFiles;
      });
      const oversizedBibRejection = yield* runPromisePhase(() =>
        rejectOversizedBibAttachments(files.contextFiles),
      );
      if (oversizedBibRejection) {
        return withScriptReference(oversizedBibRejection, scriptPath);
      }

      // The run runId is deterministic from the checkpoint identity, NOT a
      // fresh random id: a relaunch with the same meta.name regenerates the same
      // run id, so registration, stream, and grandchildren re-root at one stable
      // anchor and resume still replays completed calls (#8712). The journal
      // itself lives on the checkpoint aggregate, which outlives the run.
      const runId = deriveRunId({ checkpointId });

      // Capture the invocation hook explicitly so the detached run can still
      // roll its cost into the parent after this call returns. Undefined totals
      // are skipped (a malformed-journal failure never records a spurious cost).
      const recordSubagentCost = parent.hooks?.recordSubagentCost;
      const recordCost = (totalCost: number | undefined): void => {
        if (totalCost !== undefined) recordSubagentCost?.(totalCost);
      };

      // Same availability gate as delegate_agent/delegate_workflow: a run model
      // the active credentials cannot serve fails here, with the available list,
      // instead of mid-run on the first provider call.
      const runModel = yield* selectAvailableDelegationModel({
        parentModel: parent.model,
        withScope: parent.inScope,
      }).pipe(
        // Same annotation `runPhase` puts on every other phase failure.
        Effect.mapError((error) => workflowScriptToolError(error, scriptPath)),
      );

      const runConfigPayload: AgentConfigPayload = {
        agent: defaultAgent.name,
        agentSource: defaultAgent.source,
        agentCategory: AgentCategory.Workflow,
        model: runModel,
        instruction: `Workflow script '${meta.name}'`,
        inputFiles: [...files.inputFiles],
        contextFiles: [...files.contextFiles],
        mediaFiles: [...files.mediaFiles],
        ...(workingDirectory !== undefined && {
          workingDirectory,
        }),
      };
      const runConfig = yield* runSyncPhase(() =>
        AgentConfigSchema.parse(runConfigPayload),
      );

      const proposal: WorkflowAgentProposal = {
        agent: defaultAgent.name,
        agentSource: defaultAgent.source,
        agentCategory: AgentCategory.Workflow,
        model: runModel,
        instruction: meta.description,
        memories: [],
        inputFiles: [...files.inputFiles],
        contextFiles: [...files.contextFiles],
        mediaFiles: [...files.mediaFiles],
        outputFiles: [],
        toolConfig: DEFAULT_TOOL_CONFIG,
        ...(workingDirectory !== undefined && {
          workingDirectory,
        }),
        workflowScript: {
          name: meta.name,
          description: meta.description,
          scriptPath,
          phases: [...(meta.phases ?? [])],
          tasks: [...(meta.tasks ?? [])],
        },
      };
      const proposalDecision = yield* requestDelegationProposal(
        proposal,
        parent,
      );
      const declined = proposalResultToToolResult(
        proposalDecision.result,
        defaultAgent.name,
        proposal,
      );
      if (declined) return withScriptReference(declined, scriptPath);

      // Preserve the committed workflow snapshot when reopening this named run.
      const runStore = getRunRecords(session, runId);
      const initialSnapshot = yield* runStore.readWorkflow().pipe(
        Effect.map((snapshot) => snapshot ?? undefined),
        Effect.mapError((error) =>
          workflowScriptToolError(
            new ToolError(
              `Failed to launch workflow script '${meta.name}': prior workflow run snapshot is malformed and cannot be recovered (${toErrorMessage(error)})`,
            ),
            scriptPath,
          ),
        ),
      );
      const runResult = Effect.gen(function* () {
        const launched = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const registration = yield* Effect.exit(
              registerRun(
                session,
                runId,
                {
                  name: meta.name,
                  instruction: `Workflow script '${meta.name}'`,
                  model: runModel,
                  ...(workingDirectory !== undefined && {
                    workingDirectory,
                  }),
                },
                meta.name,
                {
                  category: runConfig.agentCategory,
                  checkpointId,
                  identity: {
                    kind: 'multiAgentWorkflow',
                    workflowName: meta.name,
                  },
                  userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
                  parentRunId,
                  description: childRunDescription(meta.description),
                },
              ),
            );
            if (Exit.isFailure(registration)) {
              const error = Cause.squash(registration.cause);
              // A relaunch whose prior run is still in flight shares this deterministic
              // id: the fresh-lease acquisition fails closed rather than starting a
              // second competing run over the same journal. Point the model at the
              // live run instead of erroring.
              if (error instanceof RunLeaseActiveError) {
                return withScriptReference(
                  executed(
                    [
                      `A workflow script run for meta.name '${meta.name}' is already in progress (or finishing); its result arrives as a follow-up. Do not launch a competing run: wait for it, then resume with the same meta.name and agent if it did not complete.`,
                      `Run ID: ${runId}`,
                      `To check progress or collect the result: executions tool with path=/executions/${runId} and action=wait (returns immediately if it already finished).`,
                    ].join('\n'),
                    `Workflow script '${meta.name}' is already running`,
                  ),
                  scriptPath,
                );
              }
              throw workflowScriptToolError(
                new ToolError(
                  `Failed to launch workflow script '${meta.name}': ${toErrorMessage(error)}`,
                ),
                scriptPath,
              );
            }

            // Attempt-scoped setup runs inside the lease launch guard: it runs after
            // the deterministic run lease is held, so a throw here must release the
            // lease - otherwise the record survives for this process's lifetime and
            // a prompt relaunch is refused.
            return yield* startDetachedChildRunLoop({
              session,
              runId,
              parentRunId,
              agentName: meta.name,
              recordCost,
              createChildRun: () =>
                Effect.gen(function* () {
                  yield* restore(Effect.void);
                  // A deterministic run id may retain the prior attempt's report.
                  // Clear it before starting this attempt so an interruption before
                  // delivery cannot be mistaken for a newly persisted result.
                  yield* runStore.clearReport();

                  // meta.name deliberately reuses one deterministic stream across
                  // launches. Reserve its writer while rehydrating so transcript
                  // eviction cannot race a resumed run.
                  return yield* createChildRun(session, runId, parentRunId, {
                    run: {
                      kind: 'multiAgentWorkflow',
                      workflowName: meta.name,
                    },
                    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
                    description: meta.description,
                    config: runConfig,
                    checkpointId,
                  });
                }),
              buildLaunch: (childRun) =>
                Effect.sync(() => {
                  // A proposal-bypass approval carries the same explicit child edit
                  // grant as delegate_agent/delegate_workflow. A human one-off approval
                  // inherits only the parent's ordinary per-kind bypass state.
                  configureDelegatedChildApprovals(
                    childRun.childRunId,
                    parentRunId,
                    proposalDecision.autoApproved ? 'auto-approved' : 'inherit',
                    session,
                  );

                  return {
                    strategy: createWorkflowScriptStrategy({
                      fingerprintAgentDependencies: (options) =>
                        fingerprintWorkflowAgentDependencies(
                          session,
                          runId,
                          options,
                        ),
                      session,
                      runId,
                      logger: childRun.logger,
                      parentRunId,
                      checkpointId,
                      script,
                      scriptPath,
                      args: input.args,
                      files,
                      name: meta.name,
                      workflowControls: session.workflowControls,
                      initialSnapshot,
                      onSnapshot: (snapshot) =>
                        Effect.gen(function* () {
                          session.publish([
                            {
                              type: 'run.workflow',
                              aggregateId: aggregateId('run', runId),
                              workflow: snapshot,
                            },
                          ]);
                          yield* Effect.tryPromise({
                            try: () => session.settlePublications(),
                            catch: ensureError,
                          });
                        }),
                      ...((parent.stopAfterCycle ??
                        parent.run.toolPolicy.stopAfterCycle) && {
                        deliveryMode: 'persistOnly' as const,
                      }),
                      createRunAgent: (hooks) => {
                        const runAgent = createWorkflowScriptAgentRunner(
                          parent,
                          defaultAgent,
                          checkpointId,
                          {
                            runId,
                          },
                          hooks,
                        );
                        return runAgent;
                      },
                    }),
                    // Detached callers do not await completion. Own late finalization
                    // failures here as trace diagnostics; the child loop already owns
                    // its one user-facing result/error delivery.
                    ...(!(
                      parent.stopAfterCycle ??
                      parent.run.toolPolicy.stopAfterCycle
                    ) && {
                      onLoopFailed: (error: unknown): void => {
                        childRun.logger.error(
                          `Workflow script '${meta.name}' run loop failed after launch`,
                          { data: error },
                        );
                      },
                    }),
                  };
                }),
            });
          }),
        );
        if ('status' in launched) return launched;
        const { completion: runCompletion } = launched;

        if (parent.stopAfterCycle ?? parent.run.toolPolicy.stopAfterCycle) {
          yield* Fiber.join(runCompletion);
          const [report, runEnd] = yield* Effect.all([
            runStore.readReport(),
            runStore.readRunEnd(),
          ]);
          if (!report) {
            throw new Error(
              `Workflow script '${meta.name}' completed without a persisted report.`,
            );
          }
          if (runEnd?.outcome !== RUN_OUTCOME.COMPLETED) {
            return errorResult(report, {
              summary: `Workflow script '${meta.name}' failed`,
            });
          }
          return executed(report, `Completed workflow script '${meta.name}'`);
        }

        return withScriptReference(
          executed(
            [
              `Workflow script '${meta.name}' launched. Its result and run log will be delivered automatically as a follow-up message when the run completes.`,
              `Run ID: ${runId}`,
              `Agent: ${defaultAgent.name} (part of the checkpoint identity with meta.name)`,
              `The result arrives automatically. Continue other work meanwhile. To check progress: executions tool with path=/executions/${runId}; use action=wait only when you cannot proceed without it.`,
              `To resume after a timeout or interruption: call this tool again with the same meta.name and agent.`,
            ].join('\n'),
            `Launched workflow script '${meta.name}' (async)`,
          ),
          scriptPath,
        );
      });
      return yield* runResult.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.fail(
                workflowScriptToolError(Cause.squash(cause), scriptPath),
              ),
        ),
      );
    });
  }
}

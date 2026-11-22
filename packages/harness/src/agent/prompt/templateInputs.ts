import { runsScript, type AgentConfig } from '@shared/schemas';

/**
 * The variables a run's system text (and the harness's own tool-use suffix)
 * may read, rendered once at launch. Nothing persists them: a run records
 * the text it rendered, and what follows the step (the tool-call mechanics,
 * the skills) is rendered per request (`stepInstructions`).
 */
interface PromptVariables {
  /** Working directory the run's tools operate in. */
  CWD: string;
}

/**
 * The roots of the session this run belongs to, held as data, so a run never
 * reads whichever roots the calling fiber carries. Tools use the working
 * directory (else the workspace).
 */
interface BuildTemplateInputsOptions {
  workspaceRoot: string | undefined;
  workingDirectory?: string;
}

/**
 * What a launch opens from: the prompt variables, and the names of the
 * skills a tool-use run's user activated with its launch.
 */
export interface TemplateOpening {
  readonly inputs: Readonly<PromptVariables>;
  readonly activated: readonly string[];
}

/**
 * Build what a launch renders its prompts from.
 *
 * @param options.workspaceRoot - Workspace root of the run's session.
 */
export function buildTemplateInputs(
  agentConfig: AgentConfig,
  options: BuildTemplateInputsOptions,
): TemplateOpening {
  const inputs: PromptVariables = {
    CWD: options.workingDirectory ?? options.workspaceRoot ?? '.',
  };

  return {
    inputs,
    // What the launch activates (`/skills`): each step resolves the names
    // against its own catalog; a script's run, which renders no prompt,
    // none.
    activated: runsScript(agentConfig) ? [] : (agentConfig.skills ?? []),
  };
}

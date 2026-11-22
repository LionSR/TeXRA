import { runsScript, type AgentConfig } from '@shared/schemas';
import {
  listExternalRoots,
  type ExternalRootKind,
} from '@utils/files/externalRoots';

/**
 * The variables a persona's prompt (and the harness's own tool-use suffix)
 * may read, rendered once at launch. Nothing persists them: a run records
 * the text it rendered, and what follows the step (the tool-call mechanics,
 * the skills) is rendered per request (`stepInstructions`).
 */
interface PromptVariables {
  /** Working directory the run's tools operate in. */
  CWD: string;
  /** Absolute agent-directory paths from the external-roots registry, ''
   *  when unregistered: the `creator` agent names them. */
  BUILTIN_AGENTS_DIR: string;
  CUSTOM_AGENTS_DIR: string;
  AGENT_DOCS_DIR: string;
}

/** The variable each external root kind fills, keyed off the stable `kind`
 *  so renaming a user-visible label cannot break prompt rendering. */
const AGENT_DIRECTORY_VARIABLES: Record<
  ExternalRootKind,
  'BUILTIN_AGENTS_DIR' | 'CUSTOM_AGENTS_DIR' | 'AGENT_DOCS_DIR'
> = {
  builtIn: 'BUILTIN_AGENTS_DIR',
  custom: 'CUSTOM_AGENTS_DIR',
  agentDocs: 'AGENT_DOCS_DIR',
};

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
  // An unregistered agent directory renders as '' (e.g. in tests that run
  // no activation).
  const inputs: PromptVariables = {
    CWD: options.workingDirectory ?? options.workspaceRoot ?? '.',
    BUILTIN_AGENTS_DIR: '',
    CUSTOM_AGENTS_DIR: '',
    AGENT_DOCS_DIR: '',
  };
  for (const root of listExternalRoots())
    inputs[AGENT_DIRECTORY_VARIABLES[root.kind]] = root.absolutePath;

  return {
    inputs,
    // What the launch activates (`/skills`): each step resolves the names
    // against its own catalog; a script's run, which renders no prompt,
    // none.
    activated: runsScript(agentConfig) ? [] : (agentConfig.skills ?? []),
  };
}

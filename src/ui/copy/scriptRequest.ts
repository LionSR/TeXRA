import type { AgentProposalPermission } from '@shared/schemas';

/** The script a request for a script's `agent` calls shows: its title, its
 *  source, and the calls it had issued when it asked. */
type ScriptRequestScript = NonNullable<AgentProposalPermission['script']>;

/**
 * Copy for the request a script's first `agent` call opens (Q5), shared by
 * every host. It leads with what approving allows and the first agent; the
 * code is evidence, folded under "Show code", never the first thing shown.
 */
export const SCRIPT_REQUEST_COPY = {
  title: (script: ScriptRequestScript): string =>
    script.title === null
      ? 'Start agents for this script?'
      : `Start agents for "${script.title}"?`,
  grant:
    "Approving lets this script start agents until it ends. Each agent's edits and commands still ask you.",
  callsHeading: 'Calls so far',
  /** `Code (14 lines)`: the folded source's heading. */
  code: (script: ScriptRequestScript): string =>
    `Code (${script.source.split('\n').length} lines)`,
  showCode: (script: ScriptRequestScript): string =>
    `Show code (${script.source.split('\n').length} lines)`,
} as const;

/** `First agent: referee · GPT-6.1 Sol — "Review chapter 2 as a referee…"`:
 *  the agent the request is for, and its instruction's first line. */
export function scriptRequestFirstAgentLine(
  agent: string,
  modelLabel: string,
  instruction: string,
): string {
  const first =
    instruction
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  return first.length > 0
    ? `First agent: ${agent} · ${modelLabel} — "${first}"`
    : `First agent: ${agent} · ${modelLabel}`;
}

/** `read_file notes.tex`: one call the script issued before it asked. */
export function scriptRequestCallLine(
  call: ScriptRequestScript['calls'][number],
): string {
  return call.preview.length > 0
    ? `${call.toolName} ${call.preview}`
    : call.toolName;
}

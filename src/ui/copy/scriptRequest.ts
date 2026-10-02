import type { AgentProposalPermission } from '@shared/schemas';

/** The script a request for a script's `agent` calls shows: its title, its
 *  source, and the calls it had issued when it asked. */
type ScriptRequestScript = NonNullable<AgentProposalPermission['script']>;

/**
 * Copy for the request a script's first `agent` call opens (Q5), shared by
 * every host: one approval covers every `agent` call of the script, and the
 * card shows the whole source before anything runs.
 */
export const SCRIPT_REQUEST_COPY = {
  title: (script: ScriptRequestScript): string =>
    script.title === null ? 'Run a script' : `Run the script ${script.title}`,
  grant: 'Approving runs every agent call this script makes.',
  callsHeading: 'Calls so far',
  sourceHeading: 'Source',
} as const;

/** `read_file notes.tex`: one call the script issued before it asked. */
export function scriptRequestCallLine(
  call: ScriptRequestScript['calls'][number],
): string {
  return call.preview.length > 0
    ? `${call.toolName} ${call.preview}`
    : call.toolName;
}

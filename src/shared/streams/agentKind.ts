/**
 * Agent-kind classification for stream presentation.
 *
 * A "process agent" runs as a raw OS process (e.g. the `bash` tool) rather
 * than an LLM-driven reasoning session. Its stream carries no meaningful
 * model and its log entries are unstructured stdout/stderr, so info builders
 * and UI components render it differently than regular agents.
 *
 * Keeping the classification here — rather than open-coded against the agent
 * name at each site — lets callers express their own concern (hide the model,
 * render terminal-style, etc.) without knowing which specific tools qualify.
 */

const PROCESS_AGENTS: ReadonlySet<string> = new Set(['bash']);

export function isProcessAgent(agent: string | undefined): boolean {
  return agent !== undefined && PROCESS_AGENTS.has(agent);
}

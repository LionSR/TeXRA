import {
  AGENT_FILE_EXTENSION,
  AGENT_SOURCE,
  type AgentSource,
} from '@texra-ai/harness/schemas';

/** Stable editor resource names resolve through the agent catalog, never an
 * arbitrary absolute path supplied by the renderer. */
export function agentDocumentTarget(source: AgentSource, name: string): string {
  return `texra-agent:${source}/${name}${AGENT_FILE_EXTENSION}`;
}

export function agentDocumentIdentity(target: string) {
  const source = Object.values(AGENT_SOURCE).find((source) =>
    target.startsWith(`texra-agent:${source}/`),
  );
  if (!source || !target.endsWith(AGENT_FILE_EXTENSION)) return undefined;
  return {
    source,
    name: target.slice(
      `texra-agent:${source}/`.length,
      -AGENT_FILE_EXTENSION.length,
    ),
  };
}

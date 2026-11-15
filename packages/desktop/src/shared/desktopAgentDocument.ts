import {
  AGENT_FILE_EXTENSION,
  AGENT_SOURCE,
  type AgentSource,
} from '@texra-ai/harness/schemas';

const AGENT_DOCUMENT_PREFIX = 'texra-agent:';

/** Whether an editor target names an agent file, not a workspace path. */
export function isAgentDocumentTarget(target: string): boolean {
  return target.startsWith(AGENT_DOCUMENT_PREFIX);
}

/** Stable editor resource names resolve through the agent catalog, never an
 * arbitrary absolute path supplied by the renderer. */
export function agentDocumentTarget(source: AgentSource, name: string): string {
  return `${AGENT_DOCUMENT_PREFIX}${source}/${name}${AGENT_FILE_EXTENSION}`;
}

export function agentDocumentIdentity(target: string) {
  const source = Object.values(AGENT_SOURCE).find((source) =>
    target.startsWith(`${AGENT_DOCUMENT_PREFIX}${source}/`),
  );
  if (!source || !target.endsWith(AGENT_FILE_EXTENSION)) return undefined;
  return {
    source,
    name: target.slice(
      `${AGENT_DOCUMENT_PREFIX}${source}/`.length,
      -AGENT_FILE_EXTENSION.length,
    ),
  };
}

import { AGENT_SOURCE, type AgentSource } from '@shared/schemas';

/** Stable editor resource names resolve through the agent catalog, never an
 * arbitrary absolute path supplied by the renderer. */
export function agentDocumentTarget(source: AgentSource, name: string): string {
  return `texra-agent:${source}/${name}.yaml`;
}

export function agentDocumentIdentity(target: string) {
  const source = Object.values(AGENT_SOURCE).find((source) =>
    target.startsWith(`texra-agent:${source}/`),
  );
  if (!source || !target.endsWith('.yaml')) return undefined;
  return {
    source,
    name: target.slice(`texra-agent:${source}/`.length, -'.yaml'.length),
  };
}

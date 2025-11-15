// Local imports - core flow primitives
import { BaseNode, Flow } from '@agent/node';

// Internal imports
import { AgentInitNode, type AgentInitNodeConfig } from './AgentInitNode';
import { buildRunFlow } from './buildRunFlow';

interface FlowLink<Shared> {
  from: BaseNode<Shared>;
  on: string;
  to?: BaseNode<Shared>;
}

interface CreateAgentRunFlowOptions<Shared> {
  init: AgentInitNodeConfig<Shared>;
  finalize: BaseNode<Shared>;
  links(
    nodes: {
      init: AgentInitNode<Shared>;
      finalize: BaseNode<Shared>;
    },
  ): FlowLink<Shared>[];
}

export function createAgentRunFlow<Shared>({
  init,
  finalize,
  links,
}: CreateAgentRunFlowOptions<Shared>): Flow<Shared> {
  const initNode = new AgentInitNode<Shared>(init);
  const linkDefinitions = links({ init: initNode, finalize });

  return buildRunFlow({
    init: initNode,
    finalize,
    links: linkDefinitions,
  });
}

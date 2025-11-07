import { Flow, BaseNode } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';

interface FlowLink<Shared> {
  from: BaseNode<Shared>;
  on: string;
  to?: BaseNode<Shared>;
}

interface BuildRunFlowOptions<Shared> {
  init: BaseNode<Shared>;
  finalize: BaseNode<Shared>;
  links: FlowLink<Shared>[];
}

export function buildRunFlow<Shared>({
  init,
  finalize,
  links,
}: BuildRunFlowOptions<Shared>): Flow<Shared> {
  init.on(FlowTransition.FINALIZE, finalize);
  for (const link of links) {
    const target = link.to ?? finalize;
    link.from.on(link.on, target);
  }
  return new Flow<Shared>(init);
}

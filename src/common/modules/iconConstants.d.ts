export const AGENT_DECORATORS: {
  properties: {
    remote: { icon: string; hint: string };
    custom: { icon: string; hint: string };
    multipleOutputs: { icon: string; hint: string };
  };
  agentCategories: Record<string, { icon: string; label: string }>;
};

export function getAgentCategoryDecorator(agentCategory: string): {
  icon: string;
  label: string;
};

export function getCodiconClass(iconName: string): string;

const AGENT_LABEL_SEPARATOR_PATTERN =
  /^(.*?)(?:\s*---\s*|\s*[\u2013\u2014]\s*)/u;

export function formatAgentOptionLabel(label: string): string {
  const shortLabel = label.match(AGENT_LABEL_SEPARATOR_PATTERN)?.[1]?.trim();
  return shortLabel || label;
}

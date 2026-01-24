export const AGENT_PLACEHOLDER: string;
export const MODEL_PLACEHOLDER: string;

export function withPlaceholder(
  optionsHtml: string,
  placeholder: string,
): string;

export function applyAgentOptions(
  selectElement: HTMLElement,
  optionsHtml: string,
  options?: { preserveValue?: string },
): void;

export function applyModelOptions(
  selectElement: HTMLElement,
  optionsHtml: string,
  options?: { preserveValue?: string },
): void;

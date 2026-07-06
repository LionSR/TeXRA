/**
 * Shared XML envelope formatting for child-run deliveries.
 *
 * The child drivers decide what facts belong in the payload. This helper owns
 * the repetitive boundary mechanics: ordered attributes, XML escaping, and
 * opening/closing tags.
 */

// Local imports
import { escapeAttr } from '@shared/utils/xmlEscape';

export interface DeliveryEnvelopeAttribute {
  readonly name: string;
  readonly value: string | number | boolean | null | undefined;
}

export interface DeliveryEnvelopeParams {
  readonly tag: string;
  readonly attributes: readonly DeliveryEnvelopeAttribute[];
  readonly bodyLines: readonly string[];
}

export function formatDeliveryEnvelope(params: DeliveryEnvelopeParams): string {
  const attrs = params.attributes
    .filter((attr) => attr.value !== null && attr.value !== undefined)
    .map((attr) => `${attr.name}="${escapeAttr(String(attr.value))}"`)
    .join(' ');
  const open = attrs ? `<${params.tag} ${attrs}>` : `<${params.tag}>`;
  return [open, ...params.bodyLines, `</${params.tag}>`].join('\n');
}

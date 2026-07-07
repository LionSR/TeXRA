/**
 * Shared XML envelope formatting for child-run deliveries.
 *
 * The child drivers decide what facts belong in the payload. This helper owns
 * the repetitive boundary mechanics: ordered attributes, XML escaping, and
 * opening/closing tags.
 */

// Local imports
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';

interface DeliveryEnvelopeAttribute {
  readonly name: string;
  readonly value: string | number | boolean | null | undefined;
}

interface DeliveryEnvelopeParams {
  readonly tag: string;
  readonly attributes: readonly DeliveryEnvelopeAttribute[];
  readonly bodyLines: readonly string[];
}

function formatDeliveryEnvelope(params: DeliveryEnvelopeParams): string {
  const attrs = params.attributes
    .filter((attr) => attr.value !== null && attr.value !== undefined)
    .map((attr) => `${attr.name}="${escapeAttr(String(attr.value))}"`)
    .join(' ');
  const open = attrs ? `<${params.tag} ${attrs}>` : `<${params.tag}>`;
  return [open, ...params.bodyLines, `</${params.tag}>`].join('\n');
}

interface ChildRunDeliveryParams {
  readonly tag: string;
  readonly executionId: string;
  readonly attributes?: readonly DeliveryEnvelopeAttribute[];
  readonly bodyLines: readonly string[];
}

export function formatChildRunDelivery(params: ChildRunDeliveryParams): string {
  return formatDeliveryEnvelope({
    tag: params.tag,
    attributes: [
      { name: 'id', value: params.executionId },
      ...(params.attributes ?? []),
    ],
    bodyLines: params.bodyLines,
  });
}

interface ChildRunErrorParams {
  readonly tag: string;
  readonly executionId: string;
  readonly attributes?: readonly DeliveryEnvelopeAttribute[];
  readonly preambleLines?: readonly string[];
  readonly message: string;
}

export function formatChildRunError(params: ChildRunErrorParams): string {
  return formatChildRunDelivery({
    tag: params.tag,
    executionId: params.executionId,
    attributes: params.attributes,
    bodyLines: [
      ...(params.preambleLines ?? []),
      `<message>${escapeText(params.message)}</message>`,
    ],
  });
}

// Third-party imports
import yaml from 'yaml';

// Local imports
import { getBasename } from './pathUtils';

const trimmedOrNull = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const firstTrimmed = (primary: unknown, fallback: unknown): string =>
  trimmedOrNull(primary) ?? trimmedOrNull(fallback) ?? '';

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback;

export interface StringifyResult {
  text: string;
  language: string;
}

export const stringifyWithLanguage = (value: unknown): StringifyResult => {
  if (value === undefined || value === null) {
    return { text: '', language: 'plaintext' };
  }

  if (typeof value === 'string') {
    return { text: value, language: 'plaintext' };
  }

  try {
    const yamlString = yaml.stringify(value);
    const text = typeof yamlString === 'string' ? yamlString.trimEnd() : '';
    return { text, language: 'yaml' };
  } catch {
    return { text: String(value), language: 'plaintext' };
  }
};

export const extractCodeOnlyInput = (value: unknown) => {
  if (!isPlainObject(value) || Object.keys(value).length !== 1) {
    return { isCodeOnly: false, code: '' };
  }
  const codeValue =
    (value as { code?: unknown; command?: unknown }).code ??
    (value as { code?: unknown; command?: unknown }).command;
  if (typeof codeValue === 'string') {
    return { isCodeOnly: true, code: codeValue };
  }
  return { isCodeOnly: false, code: '' };
};

export const tryParseJson = (text: string): Record<string, unknown> | null => {
  if (!text || typeof text !== 'string') {
    return null;
  }

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
};

export const normalizeStructuredContent = (
  text: string,
  data: unknown,
): { decodedText: string; structured: unknown } => {
  if (data !== undefined) {
    return { decodedText: '', structured: data };
  }

  const rawText = typeof text === 'string' ? text : '';
  return { decodedText: rawText, structured: tryParseJson(rawText) };
};

export const normalizeFileListEntries = (
  structured: unknown,
): Array<{
  filePath: string;
  fileName: string;
  ok: boolean;
  source: string;
  sourceDisplay: string;
  internal: boolean;
  varName: string;
}> | null => {
  if (!Array.isArray(structured)) return null;

  return structured.map((file) => {
    const filePath = String((file as { path?: unknown })?.path ?? '');
    const source = (file as { source?: string })?.source || 'unknown';

    return {
      filePath,
      fileName: getBasename(filePath),
      ok: Boolean((file as { ok?: unknown })?.ok),
      source,
      sourceDisplay: stringOr(
        (file as { sourceDisplay?: unknown })?.sourceDisplay,
        source,
      ),
      internal: Boolean((file as { internal?: unknown })?.internal),
      varName: stringOr((file as { varName?: unknown })?.varName, ''),
    };
  });
};

export const normalizeMissingOutputsPayload = (
  structured: unknown,
): {
  missing: unknown[];
  xmlFile: string | null;
  documentTag: string | null;
} | null => {
  if (!structured || typeof structured !== 'object') return null;

  return {
    missing: Array.isArray((structured as { missing?: unknown }).missing)
      ? ((structured as { missing?: unknown[] }).missing ?? [])
      : [],
    xmlFile: trimmedOrNull((structured as { xmlFile?: unknown }).xmlFile),
    documentTag: trimmedOrNull(
      (structured as { documentTag?: unknown }).documentTag,
    ),
  };
};

export const ensureLatexdiffArray = (structured: unknown): unknown[] | null =>
  Array.isArray(structured) ? structured : null;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const extractOutputContent = (candidate: unknown): unknown => {
  if (!isPlainObject(candidate)) return candidate;
  if ('content' in candidate) return candidate.content;
  if ('output' in candidate) return candidate.output;
  return candidate;
};

const normalizeToolUseInput = (input: unknown) => {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (isPlainObject(input) && typeof input.content === 'string') {
    return input.content;
  }
  return stringifyWithLanguage(input).text;
};

export const normalizeToolUseLog = (
  structured: unknown,
): {
  parsed: Record<string, unknown>;
  toolName: string;
  headerSummary?: string;
  input: Record<string, unknown> | string;
  outputText: string;
  errorText: string;
  userInstructionText: string;
  isError: boolean;
  isUserFeedback: boolean;
} | null => {
  if (!structured || typeof structured !== 'object') return null;

  const parsed = structured as Record<string, unknown>;
  const toolName = stringOr(parsed.toolName, '');
  const errorText = firstTrimmed(parsed.error, parsed.errorText);
  const outputContent = extractOutputContent(parsed.output);
  const outputText = normalizeToolUseInput(outputContent);
  const userInstructionText = firstTrimmed(
    parsed.userInstruction,
    parsed.feedback,
  );

  return {
    parsed,
    toolName,
    headerSummary: stringOr(parsed.summary, ''),
    input: (parsed.input ?? '') as Record<string, unknown> | string,
    outputText,
    errorText,
    userInstructionText,
    isError: Boolean(parsed.error || parsed.isError),
    isUserFeedback: Boolean(parsed.feedback || parsed.userInstruction),
  };
};

export const extractTrimmedContent = (normalizedPayload: {
  decodedText?: string;
}) => {
  const trimmed = (normalizedPayload?.decodedText ?? '').trim();
  return { trimmed, isEmpty: trimmed.length === 0 };
};

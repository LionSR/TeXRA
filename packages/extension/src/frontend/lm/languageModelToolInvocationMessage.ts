// Local imports - core
import { isObject } from '@utils/core';
import { isNonEmptyString, truncateSummary } from '@utils/text/stringUtils';

export type LanguageModelResearchToolName =
  'arxiv_search' | 'crossref_search' | 'web_fetch';

const MAX_CONTEXT_LENGTH = 60;

function readInputString(input: unknown, key: string): string | undefined {
  if (!isObject(input)) return undefined;

  const value = input[key];
  return isNonEmptyString(value) ? value.trim() : undefined;
}

function searchMessage(service: string, input: unknown): string {
  const query = readInputString(input, 'query');
  return query
    ? `Searching ${service} for “${truncateSummary(query, MAX_CONTEXT_LENGTH)}”`
    : `Searching ${service}`;
}

/** Build the side-effect-free progress text shown before a native LM tool runs. */
export function buildLanguageModelToolInvocationMessage(
  toolName: LanguageModelResearchToolName,
  input: unknown,
): string {
  switch (toolName) {
    case 'arxiv_search':
      return searchMessage('arXiv', input);
    case 'crossref_search': {
      const doi = readInputString(input, 'doi');
      if (doi) {
        return `Looking up DOI “${truncateSummary(doi, MAX_CONTEXT_LENGTH)}”`;
      }
      return searchMessage('Crossref', input);
    }
    case 'web_fetch': {
      const rawUrl = readInputString(input, 'url');
      const url = rawUrl ? URL.parse(rawUrl) : undefined;
      const host =
        url?.protocol === 'http:' || url?.protocol === 'https:'
          ? url.host
          : undefined;
      return host ? `Fetching ${host}` : 'Fetching web content';
    }
  }
}

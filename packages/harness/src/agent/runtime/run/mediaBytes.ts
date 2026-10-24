/**
 * Media bytes at the provider boundary. The history holds a media part by
 * its blob address (`storedTurn.ts`), so every reader of the rows, a window's
 * replay, a resume, a child's history query, sees an address and never the
 * bytes. The invocation resolves the addresses here, once per request, right
 * before the provider call; the recorded-request check turns the bytes the
 * provider was sent back into addresses to compare them with the rows.
 */
import { Effect } from 'effect';
import type { StoredInputPart } from '@shared/schemas';
import type {
  HistoryMessage,
  HistoryMessageDraft,
} from '@shared/session/historyTurns';
import { blobAddress } from '@utils/core/idHash';
import type { MessageSchema } from '@texra-ai/llm';
import type { z } from 'zod';

type ProviderMessage = z.output<typeof MessageSchema>;
type ProviderInputPart = Extract<
  ProviderMessage,
  { readonly role: 'user' }
>['content'][number];

/** The addresses the messages' media parts name, each once. */
const mediaDigests = (messages: readonly HistoryMessage[]): string[] => {
  const digests = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'tool') continue;
    const parts =
      message.role === 'user'
        ? message.content
        : message.results.flatMap((result) => result.content);
    for (const part of parts)
      if (part.kind !== 'text') digests.add(part.digest);
  }
  return [...digests];
};

type ImageDetail = Extract<
  ProviderInputPart,
  { readonly kind: 'image' }
>['detail'];

const providerPart = (
  part: StoredInputPart,
  texts: ReadonlyMap<string, string>,
): ProviderInputPart => {
  if (part.kind === 'text') return part;
  const { digest, ...rest } = part;
  const base64 = texts.get(digest);
  // `read` fails on a digest the store lacks, so one is never missing here.
  if (base64 === undefined) throw new Error(`Media blob ${digest} not read`);
  if (rest.kind !== 'image')
    return { kind: rest.kind, mimeType: rest.mimeType, base64 };
  // Storage keeps the detail a string so the package's enum is no stored
  // format; the package validates the request it prepares.
  const { detail, ...image } = rest;
  return detail === undefined
    ? { ...image, base64 }
    : { ...image, base64, detail: detail as NonNullable<ImageDetail> };
};

/**
 * The history's messages as the package sends them: each media part's
 * address resolved to its base64 through `read`, the session store's blob
 * read. The one place media bytes enter a request.
 */
export const providerMessages = <E>(
  messages: readonly HistoryMessage[],
  read: (
    digests: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, string>, E>,
): Effect.Effect<readonly ProviderMessage[], E> =>
  Effect.map(read(mediaDigests(messages)), (texts) =>
    messages.map((message): ProviderMessage => {
      switch (message.role) {
        case 'user':
          return {
            role: 'user',
            content: message.content.map((part) => providerPart(part, texts)),
          };
        case 'tool':
          return {
            role: 'tool',
            results: message.results.map((result) => ({
              ...result,
              content: result.content.map((part) => providerPart(part, texts)),
            })),
          };
        default:
          return message;
      }
    }),
  );

type DraftInputPart = Extract<
  HistoryMessageDraft,
  { readonly role: 'user' }
>['content'][number];

const addressedPart = (part: DraftInputPart): StoredInputPart => {
  if (part.kind === 'text' || !('base64' in part)) return part;
  const { base64, ...rest } = part;
  return { ...rest, digest: blobAddress(base64) };
};

/** Messages with each media part's bytes as their address: what the rows
 *  hold, for the recorded-request check over the sent turn and the
 *  pre-commit fold over a draft. */
export const withMediaAddresses = (
  messages: readonly HistoryMessageDraft[],
): readonly HistoryMessage[] =>
  messages.map((message): HistoryMessage => {
    switch (message.role) {
      case 'user':
        return { role: 'user', content: message.content.map(addressedPart) };
      case 'tool':
        return {
          role: 'tool',
          results: message.results.map((result) => ({
            ...result,
            content: result.content.map(addressedPart),
          })),
        };
      default:
        return message;
    }
  });

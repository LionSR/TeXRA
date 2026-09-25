/**
 * The wire protocol between a workflow script and the host interpreter.
 *
 * A script never executes anything. It yields operations, which cross the
 * realm boundary as JSON text and are validated here. A branch that needs
 * several steps crosses as a reference to a generator function the realm
 * keeps in its own table; the host only ever asks the realm to step it.
 */
import { z } from 'zod';

export const MAX_FANOUT = 512;

export type WireNode =
  | { readonly _tag: 'Branch'; readonly fn: number }
  | {
      readonly _tag: 'Agent';
      readonly prompt: string;
      readonly options: Record<string, unknown>;
    }
  | {
      readonly _tag: 'All';
      readonly items: readonly WireNode[];
      readonly concurrency: number | null;
    }
  | { readonly _tag: 'Attempt'; readonly body: WireNode }
  | {
      readonly _tag: 'Retry';
      readonly body: WireNode;
      readonly times: number | null;
    }
  | { readonly _tag: 'Timeout'; readonly body: WireNode; readonly ms: number };

export const WireNodeSchema: z.ZodType<WireNode> = z.lazy(() =>
  z.discriminatedUnion('_tag', [
    z.object({ _tag: z.literal('Branch'), fn: z.number().int().nonnegative() }),
    z.object({
      _tag: z.literal('Agent'),
      prompt: z.string().min(1, 'agent(prompt) requires a non-empty prompt'),
      options: z.record(z.string(), z.unknown()),
    }),
    z.object({
      _tag: z.literal('All'),
      items: z.array(WireNodeSchema).max(MAX_FANOUT),
      concurrency: z.number().int().positive().nullable(),
    }),
    z.object({ _tag: z.literal('Attempt'), body: WireNodeSchema }),
    z.object({
      _tag: z.literal('Retry'),
      body: WireNodeSchema,
      times: z.number().int().min(0).max(10).nullable(),
    }),
    z.object({
      _tag: z.literal('Timeout'),
      body: WireNodeSchema,
      ms: z.number().int().positive(),
    }),
  ]),
);

/** What one step of a branch reports back to the host. */
export const StepReplySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('started'), id: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('op'), op: WireNodeSchema }),
  z.object({ kind: z.literal('done'), value: z.unknown() }),
  z.object({ kind: z.literal('threw'), name: z.string(), message: z.string() }),
]);
export type StepReply = z.infer<typeof StepReplySchema>;

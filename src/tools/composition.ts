/**
 * A run's tool composition as a value.
 *
 * A composition names what a run may be offered: the plugins still on (the
 * user's switches and the dependency probes applied), the switches that took
 * one off, the host and approval gates, the agent's declared tools and the
 * tools the manifest injects. It is plain data keyed by a sha256 of its
 * canonical JSON, so two runs with the same composition are offered the same
 * tools, and a named preset can later be a stored composition.
 *
 * The offered registry is rebuilt from the composition's plugin list over the
 * process's plugin table (`@tools/toolTable`; see `resolveAgentTools`), never
 * narrowed from a larger registry in place.
 */
import { createHash } from 'node:crypto';
import stableStringify from 'safe-stable-stringify';
import { z } from 'zod';

import type { ToolHost } from '@agent/core/tools/ToolTypes';
import { findToolPlugin } from '@tools/plugins';
import type { ToolTable } from '@tools/toolTable';

const CompositionSchema = z.object({
  /** Plugin ids whose tools may be offered, sorted. */
  plugins: z.array(z.string()),
  /** Plugin ids the user switched off, sorted. */
  disabled: z.array(z.string()),
  /** The product host; `null` when no composition root named one. */
  host: z.enum(['cli', 'desktop', 'extension']).nullable(),
  /** Whether approval-gated tools are withheld (no interactive channel). */
  approvalPromptsUnavailable: z.boolean(),
  /** The agent's declared tools, in declaration order, without repeats. */
  tools: z.array(z.string()),
  /** The manifest's injected tools whose setting is on, in manifest order. */
  injected: z.array(z.string()),
});

export type Composition = z.infer<typeof CompositionSchema>;

/**
 * The composition a run resolves its tools from. A plugin is off when the
 * user switched it off (only a probed plugin has a switch) or its probe last
 * reported its dependency missing.
 */
export function compositionFor(inputs: {
  readonly table: ToolTable;
  readonly disabledIds: ReadonlySet<string>;
  readonly unavailableTools: ReadonlySet<string>;
  readonly host: ToolHost | undefined;
  readonly approvalPromptsUnavailable: boolean;
  readonly tools: readonly string[];
  readonly injected: readonly string[];
}): Composition {
  const ids = [...inputs.table.plugins.keys()];
  const disabled = ids
    .filter(
      (id) =>
        inputs.disabledIds.has(id) &&
        findToolPlugin(id)?.availability !== undefined,
    )
    .toSorted();
  const plugins = ids
    .filter(
      (id) =>
        !disabled.includes(id) &&
        ![...(inputs.table.plugins.get(id)?.keys() ?? [])].some((name) =>
          inputs.unavailableTools.has(name),
        ),
    )
    .toSorted();
  return {
    plugins,
    disabled,
    host: inputs.host ?? null,
    approvalPromptsUnavailable: inputs.approvalPromptsUnavailable,
    tools: [...new Set(inputs.tools)],
    injected: [...inputs.injected],
  };
}

/** A sha256 over the composition's canonical (key-sorted) JSON. */
export function compositionHash(composition: Composition): string {
  return createHash('sha256')
    .update(stableStringify(composition))
    .digest('hex');
}

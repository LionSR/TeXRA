/**
 * One streaming tool-call fragment, normalized across provider SDKs.
 *
 * OpenAI- and OpenRouter-style streaming both deliver tool calls as indexed
 * deltas whose `id`, `name`, and `arguments` arrive spread across chunks. This
 * is the SDK-agnostic shape both feed into the accumulator.
 */
interface ToolCallDelta {
  index: number;
  id?: string | null;
  name?: string | null;
  arguments?: string | null;
}

/** A tool call assembled from streaming fragments, ready for materialization. */
interface AssembledToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

interface PartialToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** Options controlling how accumulated calls are materialized. */
interface BuildToolCallsOptions {
  /** Skip entries with no id, name, or arguments. Defaults to `true`. */
  dropEmpty?: boolean;
  /** Substitute a stable `tool_call_${index}` id when none streamed. Defaults to `true`. */
  fallbackId?: boolean;
}

/**
 * Accumulates streaming tool-call fragments keyed by index, then materializes
 * them in index order. Shared by the OpenAI-compatible reasoning aggregator and
 * the OpenRouter aggregator, which previously hand-rolled the same
 * `Map<index, {id, name, arguments}>` assembly.
 */
export class ToolCallAccumulator {
  private readonly calls = new Map<number, PartialToolCall>();

  /**
   * Merge a streaming delta fragment into the accumulated call at its index.
   * `name` and `arguments` fragments are concatenated; `id` is set once (the
   * first non-empty value wins) since SDKs stream a tool call's id whole in a
   * single chunk — re-sent ids must not be concatenated into a corrupted value.
   */
  add(delta: ToolCallDelta): void {
    const existing = this.calls.get(delta.index) ?? {
      id: '',
      name: '',
      arguments: '',
    };
    if (delta.id && !existing.id) {
      existing.id = delta.id;
    }
    if (delta.name) {
      existing.name += delta.name;
    }
    if (delta.arguments) {
      existing.arguments += delta.arguments;
    }
    this.calls.set(delta.index, existing);
  }

  /**
   * Materialize accumulated calls in index order. `map` converts each assembled
   * call into the caller's provider tool-call shape. By default fully-empty
   * entries are dropped and a stable `tool_call_${index}` id is substituted when
   * none streamed; callers that need the raw accumulated entries (e.g. to match
   * a prior provider's exact output) can opt out via {@link BuildToolCallsOptions}.
   */
  build<T>(
    map: (call: AssembledToolCall) => T,
    options?: BuildToolCallsOptions,
  ): T[] {
    const dropEmpty = options?.dropEmpty ?? true;
    const fallbackId = options?.fallbackId ?? true;
    const result: T[] = [];
    const sorted = [...this.calls.entries()].sort(([a], [b]) => a - b);
    for (const [index, call] of sorted) {
      if (dropEmpty && !call.id && !call.name && !call.arguments) {
        continue;
      }
      result.push(
        map({
          index,
          id: call.id || (fallbackId ? `tool_call_${index}` : ''),
          name: call.name,
          arguments: call.arguments,
        }),
      );
    }
    return result;
  }
}

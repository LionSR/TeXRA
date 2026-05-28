/**
 * One streaming tool-call fragment, normalized across provider SDKs.
 *
 * OpenAI- and OpenRouter-style streaming both deliver tool calls as indexed
 * deltas whose `id`, `name`, and `arguments` arrive spread across chunks. This
 * is the SDK-agnostic shape both feed into the accumulator.
 */
export interface ToolCallDelta {
  index: number;
  id?: string | null;
  name?: string | null;
  arguments?: string | null;
}

/** A tool call assembled from streaming fragments, ready for materialization. */
export interface AssembledToolCall {
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

/**
 * Accumulates streaming tool-call fragments keyed by index, then materializes
 * them in index order. Shared by the OpenAI-compatible reasoning aggregator and
 * the OpenRouter aggregator, which previously hand-rolled the identical
 * `Map<index, {id, name, arguments}>` assembly with subtly divergent edge-case
 * handling.
 */
export class ToolCallAccumulator {
  private readonly calls = new Map<number, PartialToolCall>();

  /** Merge a streaming delta fragment into the accumulated call at its index. */
  add(delta: ToolCallDelta): void {
    const existing = this.calls.get(delta.index) ?? {
      id: '',
      name: '',
      arguments: '',
    };
    if (delta.id) {
      existing.id += delta.id;
    }
    if (delta.name) {
      existing.name += delta.name;
    }
    if (delta.arguments) {
      existing.arguments += delta.arguments;
    }
    this.calls.set(delta.index, existing);
  }

  get size(): number {
    return this.calls.size;
  }

  /**
   * Materialize accumulated calls in index order, dropping fully-empty entries.
   * `map` converts each assembled call into the caller's provider tool-call
   * shape; a stable `tool_call_${index}` id is substituted when none streamed.
   */
  build<T>(map: (call: AssembledToolCall) => T): T[] {
    const result: T[] = [];
    const sorted = [...this.calls.entries()].sort(([a], [b]) => a - b);
    for (const [index, call] of sorted) {
      if (!call.id && !call.name && !call.arguments) {
        continue;
      }
      result.push(
        map({
          index,
          id: call.id || `tool_call_${index}`,
          name: call.name,
          arguments: call.arguments,
        }),
      );
    }
    return result;
  }
}

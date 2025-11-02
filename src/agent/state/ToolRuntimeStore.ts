// Local imports - state components
import { ToolScratchpadState } from './ToolScratchpadState';
import { MediaAttachmentState } from './MediaAttachmentState';
import { ReasoningTraceState } from './ReasoningTraceState';

/**
 * Composed store for tool runtime state.
 *
 * This store brings together the three focused state modules (scratchpad, media,
 * reasoning) under a single interface, providing a structured alternative to the
 * monolithic ToolState while maintaining clear boundaries between concerns.
 */
export interface IToolRuntimeStore {
  scratchpad: ToolScratchpadState;
  media: MediaAttachmentState;
  reasoning: ReasoningTraceState;
}

/**
 * Manages tool runtime state through composed focused stores.
 *
 * Instead of mixing unrelated responsibilities in a single object, this store
 * delegates to specialized state modules that each handle one concern.
 */
export class ToolRuntimeStore implements IToolRuntimeStore {
  scratchpad: ToolScratchpadState;
  media: MediaAttachmentState;
  reasoning: ReasoningTraceState;

  constructor() {
    this.scratchpad = new ToolScratchpadState();
    this.media = new MediaAttachmentState();
    this.reasoning = new ReasoningTraceState();
  }

  /** Converts the entire tool runtime store to a serializable object. */
  toObject(): Record<string, any> {
    return {
      scratchpad: this.scratchpad.toObject(),
      media: this.media.toObject(),
      reasoning: this.reasoning.toObject(),
    };
  }

  /** Creates a ToolRuntimeStore instance from a persisted state object. */
  static fromObject(stateObj: Record<string, any> | null): ToolRuntimeStore {
    const store = new ToolRuntimeStore();

    if (stateObj) {
      store.scratchpad = ToolScratchpadState.fromObject(
        stateObj.scratchpad ?? null,
      );
      store.media = MediaAttachmentState.fromObject(stateObj.media ?? null);
      store.reasoning = ReasoningTraceState.fromObject(
        stateObj.reasoning ?? null,
      );
    }

    return store;
  }
}

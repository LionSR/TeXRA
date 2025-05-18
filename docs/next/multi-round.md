# Towards Multi-round Agents

This document outlines initial considerations for extending `BaseReflectionAgent` to handle more than the current two rounds (process and optional reflection).

## Infrastructure Needs

- **Configuration**

  - Introduce a `rounds` field in `ToolConfig` so a workflow can define how many sequential steps to perform.
  - Prompts may need to support an array of `userReflect` templates or reuse a single template for each additional round.

- **State Management**

  - The agent already tracks `AgentStateRound` and `AgentStateGlobal` which are not tied to a fixed number of rounds. These classes should work for arbitrary counts as long as arrays are sized dynamically.
  - `OutputHandler` stores processed files per round in `outputFiles[currRound]`; this can naturally extend to more rounds.

- **Agent Core Logic**

  - Refactor `BaseReflectionAgent` so `run()` iterates over rounds rather than calling `process()` and `reflect()` only once. Each iteration would:
    1. Render prompts for the current round.
    2. Invoke `processResponseCycle`.
    3. Run `handleRoundCompletion`.
  - The `outputFile` property has been changed to an array to simplify managing an arbitrary number of round outputs.

- **Prompt Rendering**
  - New helper methods may be needed to retrieve the correct `prefill` and prompt text for each round.

These changes should provide a smoother path to implementing true multi-round workflows in the future. Nothing is yet decided on this yet.

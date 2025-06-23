# Towards Multi-round Agents

This document outlines initial considerations for extending `BaseReflectionAgent` to handle more than the current two rounds (process and optional reflection).

## Infrastructure Needs

- **Configuration**

  - A `rounds` field now exists in `AgentSetting` allowing a workflow to specify how many sequential steps to perform (defaults to `2`).
  - The value is exposed to prompt templates via the `ROUNDS` user variable.
  - Prompts may need to support an array of `userReflect` templates or reuse a single template for each additional round.

- **State Management**

  - The agent already tracks `AgentStateRound` and `AgentStateGlobal` which are not tied to a fixed number of rounds. These classes should work for arbitrary counts as long as arrays are sized dynamically.
  - `OutputHandler` stores processed files per round in `outputFiles[currRound]`; this can naturally extend to more rounds.

- **Agent Core Logic**

  - Refactor `BaseReflectionAgent` so `run()` iterates over rounds rather than calling `process()` and `reflect()` only once. Each iteration would:
    1. Render prompts for the current round.
    2. Invoke `processResponseCycle`.
    3. Run `handleRoundCompletion`.
  - The `outputFile` property is initialized based on the configured number of rounds rather than assuming two.

- **Prompt Rendering**
  - New helper methods may be needed to retrieve the correct `prefill` and prompt text for each round.

These changes should provide a smoother path to implementing true multi-round workflows in the future. Nothing is yet decided on this yet.

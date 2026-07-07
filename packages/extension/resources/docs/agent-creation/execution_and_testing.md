# Execution & Testing Model

This note explains how TeXRA runs agents, and — more importantly — how the
`creator` agent can test a new agent before handing it back to the user.

## How TeXRA runs agents

Every agent run flows through one entry point: `texra.execute` command →
`executeAgent(config, executionId?, options?)`. The runtime takes an
`AgentConfig` (agent name, model, instruction, and optional input / memory /
working-directory fields), resolves the YAML, and dispatches one of two
flow shapes:

- **Workflow flow** for `agentCategory: workflow`. Fixed rounds, each round
  consumes `userRequest[i]`. Operates on `inputFiles` (or the active editor
  selection). Emits LaTeX output files from the unified `<documents>`
  container / `defaultOutputFiles`.
- **Tool-use flow** for `agentCategory: toolUse`. Multi-step loop invoking
  declared tools. May WAIT for interim follow-ups, spawn subagents via
  `delegate_workflow` / `delegate_agent`, and resume.

The creator agent does NOT need to call `executeAgent` directly. Instead it
delegates through tools that handle everything (including approval and the
follow-up queue) the way an ordinary user would.

## Testing a new agent

Use the `delegate_*` tools in the `tools:` list of `creator.yaml`.

### Testing a workflow agent

1. Make a small test input in the workspace. Example:
   ```
   bash: mkdir -p test_inputs
   write_file test_inputs/sample.tex with a 5–10 line LaTeX snippet
   ```
2. Call `delegate_workflow`:
   ```
   delegate_workflow(
     agent: "my_new_polish",
     model: "<a configured workflow model>",
     instruction: "Tighten the abstract",
     inputFiles: ["./test_inputs/sample.tex"]
   )
   ```
3. When the follow-up arrives:
   - Inspect the output file(s) the subagent produced.
   - Confirm the agent wrapped output correctly and produced non-empty LaTeX
     content.
   - Report pass/fail to the user.

### Testing a tool-use agent

1. Call `delegate_agent`:
   ```
   delegate_agent(
     agent: "my_new_tool_agent",
     model: "<a configured tool-use model>",
     instruction: "Do X (small end-to-end smoke test)"
   )
   ```
2. When the subagent hits WAITING (or finishes), read the output and decide
   whether the agent did what it was supposed to.
3. If more iteration is needed, pass the returned `execution_id` back to
   `delegate_agent` with a follow-up `instruction` — this resumes the same
   session with full context.

## When testing is not possible

Skip testing only if the user explicitly asks you to, or if the design
depends on live resources that are not available in the current workspace
(e.g. a real arXiv query that would burn API quota). In that case, state
plainly in the hand-off message that the agent has not been exercised.

## Iterating

If a test fails — invalid YAML, missing tool, unclear prompt, wrong output
structure — use `edit_file` on the custom YAML and re-run the delegation
call. Both delegation tools pick up the updated file on the next invocation.

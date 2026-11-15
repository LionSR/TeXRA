# Execution & Testing Model

## How TeXRA runs agents

TeXRA validates the agent YAML and runs it as a chat (or an `agent` call),
given a prompt: a multi-step loop invoking its declared tools. It may WAIT
for interim follow-ups, spawn subagents via the `agent` tool (directly or
from a `script`), and resume. Whole-document revisions are not custom
agents: they are programs a plugin ships, started with the `program` tool.

The `creator` agent tests new agents by delegating through the `agent`
tool, which exercises the same validation, approval, and follow-up flow as
a user launch.

## Testing a new agent

1. Call `agent`:
   ```
   agent(
     agentName: "my_new_agent",
     model: "<a configured model>",
     prompt: "Do X (small end-to-end smoke test)"
   )
   ```
2. When the subagent hits WAITING (or finishes), read the output and decide
   whether the agent did what it was supposed to.
3. If more iteration is needed, send the subagent a follow-up with the
   `executions` tool (`action: "send"` on `/executions/<run id>`) — this
   resumes the same session with full context.

## When testing is not possible

Skip testing only if the user explicitly asks you to, or if the design
depends on live resources that are not available in the current workspace
(e.g. a real arXiv query that would burn API quota). In that case, state
plainly in the hand-off message that the agent has not been exercised.

## Iterating

If a test fails — invalid YAML, missing tool, unclear prompt, wrong output
structure — use `edit_file` on the custom YAML and re-run the `agent`
call. It picks up the updated file on the next invocation.

# Prompt Improvement Analysis

*An opinionated review of TeXRA's prompt architecture — system prompts, tool design, orchestration, agent definitions, and the pieces that connect them.*

---

## Executive Summary

TeXRA has an impressively sophisticated prompt architecture: YAML-based agent definitions with inheritance, Nunjucks templating, multi-round reflection workflows, a full orchestrator/subagent delegation system, persistent memory, and a rich tool suite. The foundation is strong. But there are systematic patterns across the codebase where the prompts could be tighter, clearer, and more effective. This document identifies concrete improvements organized by component.

---

## 1. System Prompts: Identity and Role

### Problem: Vague or contradictory personas

The `correct.yaml` system prompt opens with:

> "Your task is to write a research paper."

But the agent *corrects* papers, it doesn't write them. The persona is misaligned with the task. Compare with `polish.yaml`:

> "You are a professional scientist. Your task is to use your knowledge to improve a LaTeX research paper..."

This is better — it establishes identity *and* task. But "professional scientist" is still generic.

The `chat.yaml` system prompt says:

> "You are a scientist and a collaborator of the user on a research project. Reason deeply."

"Reason deeply" is a bare instruction with no grounding. What does deep reasoning look like in this context? The model needs behavioral anchors, not aspirational adjectives.

### Recommendations

**a) Each agent should have a one-sentence identity that is specific and task-aligned:**

```yaml
# correct.yaml — before
systemPrompt: |
  Your task is to write a research paper.

# correct.yaml — after
systemPrompt: |
  You are a meticulous LaTeX copy-editor. Your task is to correct typos, grammar, and formatting errors in a research paper while preserving its mathematical content and the author's voice.
```

**b) Replace "Reason deeply" with observable behaviors:**

Instead of "Reason deeply," specify *what* deep reasoning produces:

> "When you encounter a non-trivial mathematical claim, trace the derivation step by step before accepting or modifying it. When you're uncertain whether a change is correct, flag it with a LaTeX comment rather than silently editing."

**c) Eliminate contradictions between system prompt and task.** The `correct` agent says "your task is to write a research paper" but actually corrects one. The `draw` agent says "creating or polishing figures" — good, that matches.

---

## 2. System Prompts: The LaTeX Style Guide Problem

### Problem: Duplicated, inconsistent rule sets

The LaTeX best-practices rules are copy-pasted across `correct.yaml`, `polish.yaml`, `draw.yaml`, `chat.yaml`, `research.yaml`, `review.yaml`, `ask.yaml`, and `presenter.yaml` — with slight variations each time.

For example:
- `correct.yaml` says: "Use $\tr$ instead of \text{tr} or \textrm{tr}"
- `polish.yaml` omits this rule entirely
- `chat.yaml` uses a numbered-list format: "(1) Use `` and '' instead of..."
- `correct.yaml` uses a `\begin{itemize}` format

Some agents get the Dirac notation rule, others don't. Some get the chktex rule, others get a weaker version. This inconsistency means the model gets different quality signals depending on which agent runs.

### Recommendations

**a) Extract a single canonical LaTeX style guide** and reference it via Nunjucks include or a shared template variable. Currently the system already supports `.texrarules` — consider making the core LaTeX rules a built-in block that all agents share, with agent-specific overrides layered on top.

**b) Use consistent formatting.** Pick either `\begin{itemize}` or numbered `(1)...(2)...` lists and use it everywhere. The `\begin{itemize}` format is ironic — you're writing LaTeX inside a prompt that gets rendered as plain text. The model doesn't compile this. Use plain numbered lists consistently.

**c) Prioritize rules by impact.** Currently the rules are a flat list. Order them: most-violated rules first, edge-case rules last. Better yet, group them:

```
CRITICAL (errors that break compilation or meaning):
- Ensure mathematical accuracy
- Don't delete LaTeX comments

STYLE (warnings from chktex):
- Use non-breaking spaces with \ref, \cite
- Use $\ldots$ not $\dots$

PREFERENCE (house style):
- Prefer \bra{} and \ket{} for Dirac notation
```

---

## 3. Tool Descriptions: Precision Matters

### Problem: Tool descriptions that leave room for misuse

Tool descriptions are the single most important piece of steering for tool-use agents. A few observations:

**`edit_file`**: The description says "Performs exact string replacements in workspace files using literal matching." This is good — it's precise. But the error messages do more work than the description:

```
old_str not found in ${targetPath}.
To fix:
- Re-read the file — content may have changed since last read
- Copy text exactly from read_file output, excluding the line-number prefix
```

This remediation guidance is excellent and should be partially surfaced in the description itself, not just in error paths. Models that see clear usage patterns in descriptions make fewer errors.

**`bash`**: The description says "Execute shell commands directly in the workspace directory." It should be more explicit about what the model should and shouldn't do:

```
Execute shell commands in the workspace directory.
Commands run from the project root ($PROJECT_DIR).
Use for: compilation (latexmk, pdflatex), git operations, running scripts.
Do not use for: reading files (use read_file), searching files (use grep/glob).
```

**`delegate_workflow` vs `delegate_agent`**: These descriptions are among the best in the codebase — they clearly distinguish the two tools, provide examples, and list available agents. However, the example in `delegate_workflow` buries critical information:

> "instruction='This research paper proposes a new quantum error correction scheme. Please fix grammar errors...'"

This example instruction is *excellent* — it demonstrates that good instructions should include context about the paper's topic, not just "fix grammar." But it's in the example, not called out as a principle. Make it explicit:

```
Instructions should include:
1. What the document is about (topic/field context)
2. What specifically to do
3. What to pay attention to or preserve
```

### Recommendations

**a) Add anti-patterns to tool descriptions** where models commonly make mistakes. The `edit_file` tool already does this in error messages — surface key anti-patterns in the description.

**b) For tools with complex schemas, add a "Common mistakes" section** to the description. For `delegate_workflow`:

```
Common mistakes:
- Putting .bib files in referenceFile instead of auxiliaryFile
- Setting useMultipleOutputs=false when outputFiles has multiple entries
- Writing vague instructions like "fix the paper" instead of specific ones
```

**c) Make `bash` description explicitly redirect to specialized tools.** Currently `TOOL_USE_INSTRUCTIONS` says "Prefer using tools over asking the user to take manual actions" — but it should say "Prefer specialized tools (read_file, edit_file, grep, glob) over equivalent bash commands."

---

## 4. The Orchestrator: Delegation Prompt Gaps

### Problem: No system-level guidance for the orchestrator role

When a tool-use agent has `delegate_workflow` and `delegate_agent` tools, it becomes an orchestrator. But there's no dedicated orchestrator system prompt — the agent just gets its normal persona plus the delegation tools appear in its tool list.

This means the orchestrator doesn't get guidance on:
- When to delegate vs. do work directly
- How to decompose a complex task across multiple subagents
- How to handle partial failures (one subagent fails, others succeed)
- How to synthesize results from multiple subagents
- Whether to run subagents in parallel vs. sequentially

The `ORCHESTRATOR_MEMORY_INSTRUCTIONS` touch on memory coordination but not task orchestration itself.

### Recommendations

**a) Add an `ORCHESTRATOR_INSTRUCTIONS` block** appended when delegation tools are present:

```
<orchestrator_instructions>
You have access to delegation tools that let you launch specialized subagents.

When to delegate:
- Whole-document rewrites (grammar, polish, merge) → delegate_workflow
- Tasks requiring file exploration, targeted edits, or multi-step reasoning → delegate_agent
- Simple questions or small edits → handle directly, don't over-delegate

Decomposition:
- Independent tasks on separate files can run in parallel
- Tasks with dependencies (edit file A, then use result in file B) must be sequential
- For multi-file operations, prefer one subagent per logical unit of work

Result handling:
- Subagent results arrive asynchronously as follow-up messages
- Read the full delivery before acting on it
- For workflow results, check the diff to verify the changes match your intent
- If a subagent fails, diagnose from the error before retrying
</orchestrator_instructions>
```

**b) The delegation tool examples should model good decomposition.** Currently the `delegate_agent` example is a single targeted edit. Add examples showing parallel delegation:

```
For a paper with 5 chapters needing independent polish:
  - Launch 5 parallel delegate_workflow calls, one per chapter
For a paper needing both grammar correction and figure enhancement:
  - Launch correct agent and draw agent in parallel (independent tasks)
```

---

## 5. The Scratchpad Pattern: Structured Thinking

### Problem: Scratchpads are underspecified in some agents, over-specified in others

The `polish.yaml` scratchpad is well-structured:

```
\begin{enumerate}
    \item [Specific improvement 1 addressing the instruction]
        \begin{itemize}
            \item Rationale: [explanation]
            \item Implementation: [Concrete steps]
        \end{itemize}
```

But the `draw.yaml` scratchpad is just:

```
1. [Specific figure creation/improvement idea 1]
2. [Specific figure creation/improvement idea 2]
3. [Specific figure creation/improvement idea 3]
```

No rationale, no implementation steps. The scratchpad's value comes from forcing the model to *plan before executing*. A bare numbered list doesn't achieve this.

Meanwhile, `polish.yaml` round 2 has a *seven-item* reflection checklist. This is too many — by item 5 or 6, the model is generating filler to satisfy the template rather than doing genuine reflection.

### Recommendations

**a) Standardize scratchpad structure** across agents. Every scratchpad should have:
1. **Analysis** — what did I observe?
2. **Plan** — what will I change and why?
3. **Risks** — what could go wrong?

**b) Trim reflection checklists to 3-4 items max.** Fewer, higher-quality reflection prompts produce better results than exhaustive lists. The current 7-item reflection in `polish.yaml` should be:

```
<reflection>
1. Does each change directly serve the given instruction? Flag any drift.
2. Is anything from the original now missing or weakened?
3. Are added passages substantive or merely fluffy?
</reflection>
```

**c) Make scratchpad format consistent.** Don't use `\begin{enumerate}` in some agents and plain `1. 2. 3.` in others. The LaTeX formatting inside scratchpads is wasted tokens — the model isn't compiling this. Use plain text lists everywhere.

---

## 6. Prefill Strategy

### Problem: Prefills vary in effectiveness

The `correct.yaml` prefill is:

```
"Here is the revised \LaTeX document. <latex_document>"
```

This is a good pattern — it forces the model to immediately begin outputting the document without preamble.

But `polish.yaml` prefills with just `<scratchpad>`, which means the model must generate the entire scratchpad *and* the document. The prefill doesn't seed the scratchpad's structure — the template in `userRequest` provides the structure, but there's a gap between the template and what the model actually generates.

### Recommendations

**a) For scratchpad agents, prefill with the first structural element:**

```yaml
prefills:
  - "<scratchpad>\n1. "
```

This nudges the model into the numbered-list format immediately rather than letting it generate arbitrary preamble inside the scratchpad.

**b) For the correction agent, the current prefill is good but could be even more directive:**

```yaml
prefills:
  - "<latex_document>\n"
```

The "Here is the revised LaTeX document." preamble wastes tokens and could confuse extraction. Prefill directly with the tag.

---

## 7. Memory System Prompts

### Problem: Memory instructions are procedural but not strategic

The `MEMORY_TOOL_INSTRUCTIONS` say:

> "ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING ANYTHING ELSE."

This all-caps imperative is effective for compliance but the instructions focus on *mechanics* (view, record, organize) without guidance on *what's worth remembering*:

```
Record user preferences: writing style, coding conventions, formatting
requirements, workflow preferences...
```

This is a flat list. What's missing is *strategic memory* — patterns that make future sessions more effective.

### Recommendations

**a) Add examples of high-value vs. low-value memories:**

```
HIGH VALUE (pin these):
- "User prefers \boldsymbol over \mathbf for bold math symbols"
- "Project uses custom \newcommand{\expect}{\mathbb{E}} — always use \expect"
- "User rejected adding conclusion sections twice — don't add them proactively"

LOW VALUE (don't record):
- "Corrected typo in section 3" (ephemeral, not reusable)
- "User asked me to read main.tex" (trivial action, no insight)
```

**b) The `ORCHESTRATOR_MEMORY_INSTRUCTIONS` mention "what approaches worked or failed and why" — this is the right instinct but needs concrete framing:**

```
After completing a task, record:
- What agent/model combination worked well for this type of task
- Any file naming conventions or project structure patterns discovered
- User feedback that reveals preferences not captured elsewhere
```

---

## 8. Tool-Use Instructions Block

### Problem: The `TOOL_USE_INSTRUCTIONS` mix critical rules with formatting guidance

The current block:

```
IMPORTANT — Working directory: ...
When using a tool, follow the JSON schema exactly...
Always produce valid JSON when calling a tool.
Prefer using tools over asking the user to take manual actions.
...
For math in responses, use $...$ or \(...\)...
```

The working directory note is critical infrastructure. The math rendering note is formatting preference. These have very different priority levels but are presented equally.

### Recommendations

**a) Separate infrastructure rules from style rules:**

```
<tool_use_rules>
Working directory is {{ CWD }}. Use relative paths.
Follow JSON schemas exactly. Produce valid JSON.
Call tools sequentially — wait for output before the next call.
Do not reference tool names when speaking to the user.
</tool_use_rules>

<response_formatting>
For math: $...$ for inline, $$...$$ for display.
Wrap align/gather inside $$...$$.
{% if DEFAULT_BIB_PATH %}Default bib: {{ DEFAULT_BIB_PATH }}.{% endif %}
</response_formatting>
```

**b) The instruction "Call tools sequentially and wait for the output before calling another" may be overly restrictive** if the underlying model supports parallel tool calls. Consider whether this is a hard constraint or a recommendation, and adjust accordingly.

---

## 9. Agent YAML: Structural Inconsistencies

### Problem: Agents use inconsistent prompt architecture

| Agent | Has userPrefix? | Has scratchpad? | Has reflection? | Rounds |
|-------|----------------|-----------------|-----------------|--------|
| correct | Yes | No | No | 1 |
| polish | Yes | Yes | Yes | 2 |
| draw | Yes | Yes | Yes | 2 |
| ocr | Yes | Yes | Yes | 2 |
| merge | Yes | No | No | 1 |
| chat | No | No | No | N/A |
| research | No | No | No | N/A |
| review | No | No | No | N/A |

The `correct` agent gets 1 round with no reflection. But correction is *exactly* the kind of task where a second-pass review catches mistakes. A model correcting a paper might introduce new errors (changing a correct equation, removing an important comment). A reflection round would catch these.

### Recommendations

**a) Give `correct` a reflection round.** Even a simple one:

```yaml
rounds: 2
userRequest:
  - |
    [existing correction prompt]
  - |
    Review your corrections. Check that:
    1. No correct mathematical content was altered
    2. No LaTeX comments were deleted
    3. No labels or references were broken
    4. Corrections are consistent throughout the document
    Output the final version.
```

**b) For tool-use agents, the system prompt IS the entire instruction set.** Make sure each one has clear sections. Currently `chat.yaml` has seven different concern areas jumbled together (Mathematical Communication, LaTeX Best Practices, File Operations, Scientific Code Quality, etc.) without clear delineation. Use XML tags or clear headers:

```yaml
systemPrompt: |
  You are a scientific research collaborator with expertise in mathematics and LaTeX.

  <mathematical_communication>
  ...rules...
  </mathematical_communication>

  <file_operations>
  ...rules...
  </file_operations>

  <scientific_code_quality>
  ...rules...
  </scientific_code_quality>
```

---

## 10. Subagent Result Formatting

### Problem: XML delivery format is information-dense but context-poor

The `formatSubagentDelivery` function produces:

```xml
<subagent-result id="abc123" agent="correct" category="workflow" status="completed">
  <output-files>
    <file path="paper.tex" location="..." original="..." added="12" removed="8"
          diff="diffs/paper.tex.diff" />
  </output-files>
</subagent-result>
```

This tells the orchestrator *what happened* but not *what to do next*. The orchestrator must figure out:
- Should I read the diff or the full file?
- Should I apply these changes or review them first?
- Was the result good enough or should I ask for revisions?

### Recommendations

**a) Add actionable guidance to delivery messages:**

```xml
<subagent-result ...>
  <output-files>...</output-files>
  <next-steps>
    To review changes: read the diff via executions tool
    To apply changes: the output files are already written to disk
    To request revisions: re-delegate with more specific instructions
    For large changes (large-change="true"): read the full output file, not just the diff
  </next-steps>
</subagent-result>
```

This is especially important after context compaction, when the orchestrator may have lost the earlier instructions about how to handle results.

---

## 11. The `_multiple` Variant Pattern

### Problem: Multi-file agents have weaker instructions

The `correct_multiple.yaml` inherits from `correct.yaml` and overrides the output format. But the multi-file coordination instructions are minimal:

```
Output all files in the given order.
```

What's missing:
- How to handle cross-file consistency (if you change notation in file A, should you change it in file B?)
- How to prioritize when files have conflicting styles
- Whether to apply the same correction strategy uniformly or adapt per file

### Recommendations

**a) Add cross-file coordination instructions to `_multiple` variants:**

```yaml
userRequest: |
  You are correcting multiple files from the same project.
  Cross-file rules:
  - Notation must be consistent across all files
  - If a command is defined in an auxiliary file, use it consistently in all documents
  - Apply the same correction standards to all files — don't be thorough on one and cursory on another
  - If files reference each other (e.g., main paper references appendix), ensure references remain valid after corrections
```

---

## 12. The `.texrarules` System

### Problem: Great feature, but the integration point is a plain string concatenation

```typescript
return rules ? `${basePrompt}\n${rules}` : basePrompt;
```

User rules are appended at the end of the system prompt, which means they compete with the agent's built-in rules for attention. If a user rule contradicts a built-in rule (e.g., "use \dots not \ldots"), the model has conflicting instructions with no clear priority.

### Recommendations

**a) Wrap `.texrarules` in a priority tag:**

```typescript
return rules
  ? `${basePrompt}\n<user_rules priority="override">\nThe following rules are provided by the project author and take precedence over any conflicting built-in rules:\n${rules}\n</user_rules>`
  : basePrompt;
```

**b) Consider documenting in `.texrarules` guidance what kinds of rules are most effective,** since users will write these without prompt engineering expertise.

---

## 13. Conditional Logic in Prompts

### Problem: Provider-specific conditionals are a code smell

Several agents have:

```yaml
{% if IS_ANTHROPIC_MODEL %}
(4) Do not create excessive markdown files or documentation unless explicitly requested.
{% endif %}
```

This implies Anthropic models create excessive files and others don't — it's papering over a behavioral difference with a conditional rather than fixing the root cause.

### Recommendations

**a) Make provider-agnostic rules that address the underlying behavior:**

```yaml
File creation policy: Only create files when the user explicitly requests file output.
Respond conversationally by default. Do not create markdown summaries, documentation
files, or reports unless specifically asked.
```

This is cleaner, applies to all models, and addresses the behavior directly.

**b) If provider-specific behavior truly requires conditional prompting, document *why* in a comment** so future maintainers understand the reasoning:

```yaml
# Anthropic models tend to proactively create .md files when given write_file access.
# This instruction mitigates that behavior without restricting other providers.
{% if IS_ANTHROPIC_MODEL %}...{% endif %}
```

---

## 14. Instruction Injection and the `{{ INSTRUCTION }}` Pattern

### Problem: User instructions are injected with minimal framing

In most agents, the user instruction is injected as:

```yaml
userRequest: |
  {{ INSTRUCTION }}
```

or wrapped in a simple `<instruction>` tag:

```yaml
<instruction>
{{ INSTRUCTION }}
</instruction>
```

The `polish.yaml` does this well:

```yaml
Important: Focus solely on the given instruction. If asked to revise section A,
do not modify section B unless absolutely necessary for consistency.
```

But `chat.yaml` and `research.yaml` just inject `{{ INSTRUCTION }}` bare, with no framing about scope or boundaries.

### Recommendations

**a) Always frame instructions with scope guidance:**

```yaml
userRequest: |
  <instruction>
  {{ INSTRUCTION }}
  </instruction>

  Scope: Address the instruction above. Do not make changes unrelated to the instruction
  unless they are necessary for consistency or correctness.
```

**b) For tool-use agents, add a meta-instruction about instruction ambiguity:**

```yaml
If the instruction is ambiguous or could be interpreted multiple ways, ask the user
for clarification before proceeding with a potentially wrong interpretation.
```

---

## 15. Cross-Cutting: Token Efficiency

### Problem: Prompts contain redundant or low-signal content

A few examples:
- The `polish.yaml` reflection round has this: "Now it is time to be brutally honest with yourself." This anthropomorphizing doesn't improve model behavior — it's wasted tokens.
- The `correct.yaml` system prompt uses `\begin{itemize}...\end{itemize}` LaTeX formatting that the model processes as plain text. The backslashes and braces add noise.
- Multiple agents repeat "For example, in the instruction, if I ask you to revise section A, you do not need to revise section B" — this appears in at least 3 agents with slight variations.

### Recommendations

**a) Audit all prompts for anthropomorphizing language** ("be brutally honest", "take a moment to reflect"). Replace with behavioral instructions ("List concrete deficiencies in the current version").

**b) Use plain text formatting in prompts,** not LaTeX. The model doesn't compile these prompts. `\begin{itemize}` → bullet points or numbered lists.

**c) Extract repeated patterns into shared blocks** via the template system or Nunjucks includes.

---

## Summary of Highest-Impact Changes

Ranked by expected improvement in output quality:

1. **Fix `correct.yaml` persona** — the "write a research paper" opening is actively misleading
2. **Extract shared LaTeX rules** — eliminate inconsistency across 8+ agents
3. **Add orchestrator instructions** — the delegation system is powerful but under-prompted
4. **Add reflection round to `correct`** — correction is exactly where self-review pays off
5. **Trim reflection checklists** — 3-4 focused items beat 7 unfocused ones
6. **Standardize scratchpad format** — consistent structure across all agents
7. **Add delegation guidance to tool descriptions** — help orchestrators write good instructions
8. **Frame `.texrarules` with priority** — prevent conflicts between user and built-in rules
9. **Remove provider-specific conditionals** — use universal behavioral instructions
10. **Add next-steps to subagent deliveries** — help orchestrators act on results

---

*This analysis is based on a complete reading of all 11 workflow agent YAMLs, 6 tool-use agent YAMLs, 15+ tool implementations, the PromptBuilder, delegation system, memory system, subagent result formatting, and workspace info infrastructure.*

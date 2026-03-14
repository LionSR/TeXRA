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

*The structural analysis above is based on a complete reading of all 11 workflow agent YAMLs, 6 tool-use agent YAMLs, 15+ tool implementations, the PromptBuilder, delegation system, memory system, subagent result formatting, and workspace info infrastructure.*

---

# Part II: Cognitive Problems

*The structural issues above are about prompt hygiene — formatting, deduplication, consistency. The problems below are deeper: they affect how the model reasons, what failure modes it falls into, and what kinds of errors systematically appear in outputs.*

---

## 16. The Scope Creep Trap: Instructions That Invite Overreach

### The core cognitive problem

Every workflow agent asks the model to output a *complete* document. The `correct` agent says "ensure that all mathematical equations are correct and all statements are factually accurate." The `polish` agent says "you must give the complete output containing all the sections."

This creates a fundamental tension: the instruction says "focus solely on the given instruction" but the output format demands "reproduce the entire document." When a model regenerates 40 pages of LaTeX, it *will* make unintended changes. Not because it's disobedient — because regenerating a long document from memory is a lossy process. Every token the model outputs is a new opportunity to drift.

This is the **faithfulness-completeness tradeoff**: the more text you ask the model to reproduce, the more it will accidentally mutate.

### Evidence in the prompts

`polish.yaml` line 115:
> "Include all the changes you added in the previous step."

This instruction, in round 2, asks the model to *remember and faithfully reproduce* changes it made in round 1 while also incorporating new changes. The model has its round 1 output in the conversation history, but it's regenerating the whole document, not diffing. It's doing lossless transcription and creative editing simultaneously — two cognitive modes that conflict.

`correct.yaml` asks the model to fix typos while reproducing the *entire* document verbatim except for corrections. This is like asking a proofreader to simultaneously be a photocopier. The model will "improve" sentences that weren't broken, drop comments it didn't notice, or subtly rephrase things near actual corrections.

### Recommendations

**a) Acknowledge the faithfulness-completeness tradeoff explicitly in prompts.** Tell the model the specific failure mode to watch for:

```
WARNING: When reproducing sections you did not modify, copy them verbatim.
Do not "improve" text outside the scope of your corrections. If you are
unsure whether something is an error or intentional, preserve the original.
The user wants minimal, targeted changes — not a rewrite.
```

**b) Consider a "changes-only" output mode** for agents like `correct` where the edits are typically sparse. Instead of regenerating 40 pages with 5 fixes, output a structured diff:

```xml
<corrections>
  <correction location="line 47" original="thier" replacement="their" />
  <correction location="Eq. 12" original="$\dot$" replacement="$\dots$" />
</corrections>
```

The merge agent could then apply these. This eliminates the faithfulness problem entirely for the correction case.

**c) For `polish`, the scratchpad already identifies *what* to change. Add an explicit step: "For each section you do NOT plan to modify, reproduce it exactly as given. Your modifications should be surgical — change only the sentences that need changing."**

---

## 17. The Sycophancy Problem: Prompts That Don't Model Disagreement

### The cognitive problem

None of the agent prompts give the model permission or guidance to **push back on the user's instruction**.

The `polish` agent says "focusing solely on addressing the given instructions." The `correct` agent says "Specific instructions that you must follow closely." The `chat` agent says "Confirm with User to sync with the user's intentions."

But what if the user's instruction is wrong? "Add more equations to the introduction" might be bad advice for a paper where the introduction should be accessible. "Fix the grammar in section 3" applied to a paper with a fundamental mathematical error in section 3 means the model polishes the prose around a wrong derivation.

The prompts currently encode a **servile epistemology**: the user is always right, the model's job is to execute. But the model is positioned as "a professional scientist" and "a collaborator" — roles that require the ability to say "I disagree" or "I notice something more important."

### Evidence in the prompts

`chat.yaml`:
> "Converse with the user and ensure mathematical accuracy. Confirm with User to sync with the user's intentions when a big task is to be completed."

This gets close to the right idea — it says "ensure mathematical accuracy" and "confirm with user." But it doesn't say what to do when mathematical accuracy *conflicts* with the user's instruction. The model defaults to compliance.

`review.yaml` is the exception — it's explicitly designed to find problems. But even it says: "When editing files, always ask for user confirmation before making changes." The auditor defers to the author on fixes.

### Recommendations

**a) Add a "professional judgment" clause to agents where the model has domain expertise:**

```
You are a collaborator, not a contractor. If the user's instruction would
damage the paper's quality (e.g., adding fluff to meet a word count,
removing a necessary derivation, or introducing incorrect mathematics),
flag the concern before proceeding. Suggest an alternative that achieves
the user's underlying goal.

However: if the user acknowledges the tradeoff and insists, respect their
decision. They may have context you don't.
```

**b) For the `correct` agent specifically, add a "triage" instinct:**

```
If you discover an error that is more severe than what the instruction
addresses (e.g., a sign error in a key equation while correcting grammar),
note it with a LaTeX comment:
  % [TeXRA note] Possible sign error in Eq. (7): $-\alpha$ should be $+\alpha$?
Do not silently fix mathematical content the user didn't ask you to touch.
```

**c) For `polish`, add a "diminishing returns" signal:**

```
If the instruction has been fully addressed and further changes would
only add marginal value or risk introducing new issues, say so in the
scratchpad and stop. A paper that is 95% improved with zero regressions
is better than 100% improved with accidental damage elsewhere.
```

---

## 18. The Attention Allocation Problem: Long Documents, Uneven Effort

### The cognitive problem

When a model processes a 30-page paper, it doesn't allocate attention uniformly. The beginning and end of the document get disproportionate attention (primacy/recency effects). Sections near the instruction get more attention than sections far from it.

None of the prompts address this. They all say "read the entire document carefully" — which is aspirational but doesn't change the model's attention distribution.

### Evidence in the prompts

`correct.yaml` userRequest:
> "Please carefully read through the entire document, looking for any typos, grammatical errors..."

`polish.yaml` userPrefix:
> "Please carefully read through the entire research paper above and ensure you fully understand all the details."

These instructions are equivalent to telling a human "pay equal attention to everything." Humans can't do this, and neither can models. The result: corrections cluster in the first few sections, with later sections getting lighter treatment.

### Recommendations

**a) Add section-awareness to workflow agents.** Before processing, have the scratchpad list all sections:

```
Before making any changes, list every section in the document:
1. Section name, approximate line range
2. One-sentence summary of content
3. How relevant this section is to the instruction (high/medium/low/none)

Then work through each section systematically, spending time proportional
to its relevance and error density.
```

This forces the model to *see* the whole document structure before starting edits, counteracting the tendency to front-load effort.

**b) For multi-round agents, consider alternating the direction of processing:**

```
Round 1: Process the document from beginning to end.
Round 2: Review your changes from END to BEGINNING. This counteracts the
natural tendency to invest more effort in early sections.
```

**c) For the `correct` agent, consider explicit section-by-section processing instructions:**

```
Process the document one section at a time. For each section:
1. Read it completely
2. List any corrections needed
3. Apply corrections
4. Move to the next section

Do not skip ahead or go back. This ensures every section receives equal scrutiny.
```

---

## 19. The Phantom Knowledge Problem: Models Inventing Content

### The cognitive problem

The `polish` agent is told: "brainstorm concrete ways to significantly improve the quality of the paper." The `draw` agent is told to "create informative, condensed, and aesthetically pleasing figures."

These instructions invite the model to *add content* to the paper. But the model doesn't know the research. It knows the text of the paper, but it doesn't know what's true in the field, what the authors' other results are, or what the correct interpretation of an ambiguous equation is.

When told to "improve," the model will:
- Add sentences that sound authoritative but may be factually wrong
- Introduce connections to other work it hallucinates
- Expand on results in ways that go beyond what the authors proved
- Add "discussion" that is generic rather than specific to the actual findings

This is particularly dangerous in `draw.yaml`, where the model creates TikZ figures. A figure that *looks* correct but misrepresents a mathematical relationship is worse than no figure at all.

### Evidence in the prompts

`polish.yaml` round 2 reflection item 7:
> "In the added parts, are there any fluffy statements like 'XXX provides crucial insights into the structure and behavior of these systems' that can be densed using the 'show not tell' technique?"

This is excellent — it shows awareness of the problem. But it's checking for fluff *after* the model has already generated it, rather than preventing it. The reflection catches symptom (fluff) rather than cause (model inventing content it doesn't have knowledge to write).

`draw.yaml`:
> "When working with TikZ diagrams connected to mathematical formulas, always reflect whether the visual representation accurately matches the underlying equations and relationships."

Good instinct, but "reflect" is a vague cognitive instruction. *How* should it verify? By re-deriving? By checking specific numerical values?

### Recommendations

**a) Add epistemic honesty rules to all agents that generate content:**

```
EPISTEMIC RULES:
- Only add content that is directly supported by the text of the paper
- Do not introduce claims, citations, or connections not present in the original
- If expanding a discussion, every sentence must be traceable to a specific
  result or equation already in the paper
- When uncertain whether a statement is correct, add a LaTeX comment:
  % [TeXRA note] Please verify: [the uncertain claim]
- Never invent numerical values, experimental results, or citations
```

**b) For `draw.yaml`, add concrete verification steps:**

```
After creating a TikZ figure:
1. List every mathematical relationship the figure depicts
2. For each relationship, cite the specific equation in the paper
3. Verify that the visual topology (arrows, connections, orderings)
   matches the mathematical structure (compositions, dependencies, orderings)
4. If the figure includes numerical axis values or specific points,
   verify them against the paper's stated values
```

**c) For `polish.yaml`, distinguish between editing and authoring:**

```
You are EDITING this paper, not CO-AUTHORING it. The distinction:
- Editing: Improving how existing ideas are expressed (clarity, flow, precision)
- Authoring: Adding new ideas, claims, or content

Stay in editing mode. If the instruction requires new content (e.g., "add a
discussion of limitations"), draw ONLY from what is already implied or stated
in the paper. Do not introduce external knowledge the authors may not endorse.
```

---

## 20. The Instruction-Following Ceiling: Scratchpads as Performance Theater

### The cognitive problem

The scratchpad/reflection pattern is designed to improve output quality through deliberate planning. But there's a failure mode: **the model fills in the template without genuine reasoning**.

When `polish.yaml` provides a reflection template with 7 items, the model will generate 7 answers — but they may be post-hoc rationalizations of the output it already produced, not genuine critical evaluation. The template structure makes it *look* like deep reflection while potentially being pattern-completion.

The key indicator: scratchpad items that are all positive. "The modifications address the instruction well." "The enhancements are clear and effective." "The changes maintain coherence." If the model never flags actual problems in its own work, the reflection is theater.

### Evidence in the prompts

`polish.yaml` reflection template asks questions as numbered items. Each item is phrased as a question that can be answered "yes" or "yes, but slightly better now." There's no template slot for "I made a mistake here and need to fix it."

`draw.yaml` reflection:
> "How well do the modifications address the specific instruction provided?"

This invites a self-congratulatory answer. Compare with:
> "List three specific ways the figure fails to accurately represent the mathematics."

The second phrasing forces the model to find problems. The first lets it celebrate.

### Recommendations

**a) Reframe reflection prompts as adversarial self-review:**

Instead of:
```
How well do the modifications address the instruction?
```

Use:
```
Find the three weakest changes you made. For each:
- What was the change?
- Why is it weak? (inaccurate, unnecessary, introduces inconsistency, etc.)
- How would you fix it?
```

This reframes reflection from "evaluate your work" (which invites positive assessment) to "find your mistakes" (which forces critical engagement).

**b) Add a "null check" to scratchpads:**

```
If the instruction is already fully addressed by the original document
and no changes are needed, say so explicitly in the scratchpad. Do not
invent changes to justify your existence. It is acceptable — and sometimes
correct — to return the document unchanged.
```

This gives the model an exit ramp from the "I must produce changes" assumption.

**c) For round 2 reflection, require specific evidence:**

Instead of:
```
Are the enhancements clear, condensed, and effective?
```

Use:
```
Quote a specific paragraph you changed. Show the before and after.
Is the 'after' genuinely better, or just different? If just different,
revert it.
```

Requiring the model to cite specific evidence forces it out of vague self-assessment.

---

## 21. The Context Window Trap: Prompts That Don't Scale

### The cognitive problem

The `correct_multiple` agent processes multiple documents in a single context window. All documents are injected via `{{ ALL_INPUTS }}` plus the main `{{ INPUT_CONTENT }}`. For a project with 5 chapters of 10 pages each, that's 50 pages of input, plus system prompt, plus output — potentially 100k+ tokens.

The prompts don't acknowledge this scaling problem. They say "carefully read through the entire document" regardless of whether "the entire document" is 3 pages or 50 pages. The model's behavior degrades gracefully — it doesn't crash, it just gets less careful. Late documents in a multi-file set get less attention than early ones.

### Evidence in the prompts

`correct_multiple.yaml` has no instruction about prioritization when processing multiple files. `merge_multiple.yaml` says "Process each document pair independently" — good — but doesn't say anything about what to do if the combined length exceeds comfortable processing capacity.

### Recommendations

**a) Add context-aware instructions for multi-document agents:**

```
You will process multiple documents. If the combined length is substantial:
- Process each document as a separate unit of work
- Give later documents the same care as earlier ones
- If you notice your attention flagging on later documents,
  explicitly re-read them before editing
```

**b) For the orchestrator, add guidance on when to split vs. batch:**

```
When delegating multi-file tasks:
- If total input exceeds ~20 pages, prefer separate delegations per file
  over a single multi-file delegation
- For uniform operations (correct all files), parallel single-file
  delegations are both faster and more reliable than one multi-file batch
```

---

## 22. The Grounding Gap: Models Without Feedback Loops

### The cognitive problem

Workflow agents operate open-loop: they receive input, produce output, and have no way to verify their work against reality. The `correct` agent can't compile the LaTeX to check for errors. The `draw` agent can't render the TikZ to see if the figure looks right. The `polish` agent can't run chktex to verify zero warnings.

The prompts ask for these quality standards ("zero warnings when checked by chktex") without giving the model any way to actually verify compliance. This is like asking someone to paint a wall while blindfolded and then asking "is it even?"

Tool-use agents (`chat`, `research`, `review`) *do* have feedback loops via bash, but the system prompts don't always emphasize using them for verification.

### Recommendations

**a) For workflow agents, be honest about the limitation:**

```
You cannot compile or verify the LaTeX output. Therefore:
- Be conservative: when unsure whether a change is correct, don't make it
- Prefer changes where you are confident of correctness over ambitious changes
  that might introduce compilation errors
- Pay extra attention to matching braces, environments, and command arguments
```

**b) For tool-use agents, explicitly require verification loops:**

In `chat.yaml` and `research.yaml`:
```
After writing or editing any LaTeX file:
1. If latexmk is available, compile and check for errors
2. If chktex is available, run it and fix any warnings
3. If neither is available, manually verify matching braces and environments
```

**c) For `draw.yaml`, the inability to render is particularly costly. Consider adding a recommendation to compile:**

```
After generating TikZ code, the user will need to compile it to verify
visual correctness. Structure your TikZ code to be compilable standalone
(with appropriate documentclass and packages) so the user can preview it
quickly.
```

---

## 23. The Merge Agent's Impossible Task

### The cognitive problem

The `merge` agent receives an "original" and an "edited" version and must produce the merged result. The edited version may contain markers like "previous parts remain unchanged."

This requires the model to:
1. Identify which parts of the edited version are actual edits vs. elision markers
2. Copy unchanged sections *verbatim* from the original
3. Insert edited sections at the correct positions
4. Maintain perfect LaTeX structural integrity

Step 2 is the hard one. "Copy verbatim" over potentially hundreds of lines is asking the model to be a photocopier — the thing it's worst at. Every line it "copies" is actually *regenerated*, with potential for subtle mutations (whitespace changes, comment modifications, equation reformatting).

The prompt says "Accuracy is paramount — even small discrepancies can affect diff tools." This is the right standard, but the prompt doesn't give the model strategies for meeting it.

### Recommendations

**a) Give the merge agent explicit strategies for the verbatim copying problem:**

```
CRITICAL: For unchanged sections, your goal is EXACT byte-for-byte reproduction.
Strategies:
- Do not "clean up" or "improve" unchanged sections, even if you notice issues
- Do not change whitespace, indentation, or line breaks in unchanged sections
- If an unchanged section has a LaTeX warning or style issue, preserve it exactly
  — the user wants an accurate merge, not a surprise correction
- When in doubt between what the original says and what you think it should say,
  always use the original verbatim
```

**b) Consider whether merge should even be a generative task.** A deterministic algorithm that identifies edited ranges and splices them into the original would be more reliable. The merge agent is using a probabilistic text generator for a task that requires deterministic text manipulation. This might be a case where code beats prompting.

---

## 24. The Missing Metacognition: Models Don't Know When They're Failing

### The cognitive problem

None of the prompts teach the model to recognize its own failure modes. The model doesn't know that:
- It's worse at the end of long documents than at the beginning
- It tends to over-edit when told to "improve"
- It hallucinates content when told to "expand"
- It loses track of nesting in deeply nested LaTeX environments
- It struggles with verbatim reproduction of mathematical notation

If the model knew these tendencies, it could compensate. A human editor who knows they get sloppy after page 20 takes a break and re-reads. A model that knows it over-edits can add a final check: "Did I change anything I wasn't asked to change?"

### Recommendations

**a) Add a "known failure modes" section to agents where it matters most:**

For `correct.yaml`:
```
KNOWN TENDENCIES TO WATCH FOR:
- You may "improve" sentences that weren't broken — resist this
- You may drop LaTeX comments that look like dead code — preserve all comments
- You may normalize spacing or formatting in ways that affect compilation — preserve original whitespace
- You tend to pay less attention to sections near the end — check those sections explicitly
```

For `polish.yaml`:
```
KNOWN TENDENCIES TO WATCH FOR:
- You may add generic academic filler ("This provides crucial insights...") — every sentence should say something specific
- You may lose mathematical precision when rephrasing — if you change a sentence containing math, verify the math is still correct
- You may rewrite sections that only needed minor tweaks — prefer surgical changes over rewrites
```

**b) For the orchestrator, teach it to recognize when a subagent's result is suspect:**

```
When reviewing subagent results:
- If a workflow agent changed more than ~30% of the document, the changes
  may include unintended modifications. Review the diff carefully.
- If a tool-use agent's response is very short for a complex task, it may
  have given up or misunderstood. Check the conversation history.
- If multiple corrections cluster in the first half of the document,
  the agent may have lost attention. Consider re-running on the second half.
```

---

## 25. The Evaluation Asymmetry: Harder to Check Than to Generate

### The cognitive problem

The `review.yaml` agent is asked to "reproduce [every key derivation] step-by-step" and "verify limiting cases." This is computationally expensive even for a model — reproducing a derivation requires as many tokens as the derivation itself.

But the prompt doesn't help the agent *triage*. It lists 8 mathematical verification items, 5 notation items, 4 goal items, 8 code items, 4 figure items, and 3 reference items. That's 32 verification tasks. For a 30-page paper, this could require hundreds of tool calls and enormous token expenditure.

The review agent needs *prioritization heuristics* — which things are most likely to be wrong and most important to check?

### Recommendations

**a) Add prioritization guidance:**

```
Triage your verification effort:

HIGH PRIORITY (check first):
- Main theorem statements and their proofs
- Equations referenced by multiple later results (errors propagate)
- Numerical results that appear in the abstract or conclusion
- Any result the authors flag as "novel" or "key contribution"

MEDIUM PRIORITY:
- Supporting lemmas and intermediate results
- Notation consistency across sections
- Figure accuracy for figures discussed in the main text

LOW PRIORITY (check if time permits):
- Formatting and style issues
- References to well-known results
- Peripheral remarks and footnotes

If you find a HIGH PRIORITY error, STOP and report it immediately —
it may invalidate downstream results and change what else needs checking.
```

**b) Teach the review agent to use Wolfram/computation *strategically*:**

```
Do not verify every equation computationally. Use computation for:
- Results that look surprising or counterintuitive
- Equations with specific numerical values (easy to spot-check)
- Claims about limits, asymptotics, or special cases (quick to verify)
- Any equation where you suspect an error based on reading

For straightforward algebraic manipulations, trace them mentally first.
Only invoke Wolfram when your manual check is uncertain.
```

---

## Summary of Cognitive Problems

The structural issues from Part I are about *what the prompts say*. The cognitive issues in Part II are about *how the prompts shape thinking*:

| # | Problem | Agents affected | Severity |
|---|---------|----------------|----------|
| 16 | Faithfulness-completeness tradeoff | All workflow agents | **Critical** |
| 17 | Sycophancy / no pushback | All agents | High |
| 18 | Uneven attention allocation | All workflow agents | High |
| 19 | Phantom knowledge / hallucination | polish, draw, chat | **Critical** |
| 20 | Reflection as performance theater | polish, draw, ocr | High |
| 21 | Context window scaling | _multiple variants | Medium |
| 22 | No feedback loops in workflows | All workflow agents | High |
| 23 | Merge as impossible copying task | merge | High |
| 24 | Missing metacognition | All agents | Medium |
| 25 | Evaluation without triage | review | Medium |

The three most impactful changes would be:
1. **Acknowledge the faithfulness problem** (#16) — this is the single biggest source of unintended changes
2. **Add epistemic honesty rules** (#19) — prevent models from inventing content the authors didn't write
3. **Reframe reflection as adversarial self-review** (#20) — force genuine critical engagement instead of template-filling

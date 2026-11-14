# History lowering in three codecs, and the reply-document recovery steps

Status: proposed. Two findings of the scheduled code-debt and SDK-readiness
audits of 2026-11-14, read against the tree on that date. Neither is a code
change in the audit's PR: the first needs a design choice, the second needs
evidence that does not exist yet.

## 1. The history-lowering walk in `packages/llm`

### What it is

Each provider codec turns the provider-neutral history of a resolved turn
(system, user, tool and assistant messages; assistant content as `message`,
`reasoning` and `local-call` parts, each with optional provider `evidence`)
into that provider's request items:

| Codec     | Where                                                                 | Output                                    |
| --------- | --------------------------------------------------------------------- | ----------------------------------------- |
| Anthropic | `packages/llm/src/api/anthropicMessages.ts` (inside `invocationBody`) | `MessageParam[]`, grouped by role         |
| Google    | `packages/llm/src/api/googleInteractions.ts` (`lowerMessages`)        | a flat `Interactions.Step[]`              |
| OpenAI    | `packages/llm/src/api/openaiResponsesLower.ts` (`lowerMessages`)      | a flat `ResponseInput`, one item per part |

Each walk is about 110 to 165 lines.

### What is the same, and what is already shared

The audit described the walk as repeated three times. Read closely, the
decisions that are the same in all three are already single functions in
`packages/llm/src/message.ts` and `packages/llm/src/api/transport.ts`:

- pairing each tool result with the call it answers (`answeredCalls`,
  `callsAnsweredBy`), including the "answers no call" error;
- the wrapper text of a system update shown as user text (`systemUpdateText`);
- dropping what another model of the same protocol left behind
  (`replayableHistory`; Anthropic and OpenAI call it, Google does not, see
  the open question below);
- parsing stored call arguments for the two APIs that take an object
  (`parseOutboundToolArguments`);
- the origin comparison (`sameModelOrigin`).

What is left repeated is the skeleton only: a loop over messages, a branch on
the four roles, and inside the assistant branch a branch on the three part
kinds. That is roughly 25 lines per codec. Everything inside the branches
differs:

| Decision                   | Anthropic                                                                                                         | Google                                                                                               | OpenAI Responses                                                                       |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| System message mid-history | native `system` role only in an allowed position (reads the next message and the previous output), else user text | always user text, joined into the previous `user_input` step                                         | `developer` on the OpenAI endpoint, else user text                                     |
| Role grouping              | one message per history message                                                                                   | joins adjacent user content; one step per assistant part                                             | one item per part or result                                                            |
| Tool result                | all results of a group in one user message, `is_error` flag                                                       | one step per result; non-text, non-image parts moved to a following user step, labelled by call name | one item per result; text-only results become a string, errors get an `Error: ` prefix |
| Reasoning                  | another origin's is an error after `replayableHistory`; needs a signature or redacted data                        | another origin's is skipped; signature optional, no content                                          | needs its own evidence; replays item id, status, encrypted content                     |
| Assistant text             | text blocks; refusal content rejected                                                                             | one `model_output` step; any evidence rejected                                                       | plain message, or the original item with id, status and phase when evidence is present |
| Local call                 | parsed arguments; evidence rejected                                                                               | parsed arguments; duplicate ids rejected                                                             | raw argument text; optional namespace, item id, status                                 |
| Attachments                | `inputPart` with an upload cache                                                                                  | `lowerInputPart`                                                                                     | `responsesContent` with document access                                                |

The OpenAI walk also has a counting twin (`loweredItemCount`) that must agree
with it item for item, and the Anthropic walk needs neighbouring messages,
so neither is a pure per-message mapping.

Conclusion: the shared part is smaller than the audit claimed. The repeated
text is the branch skeleton, not behavior.

### Designs compared

**A. One shared walk with a per-provider handler table.** A generic function
in `message.ts` iterates the history, resolves answered calls, and calls
`system`, `user`, `toolGroup`, `message`, `reasoning`, `localCall` handlers
that append to a provider accumulator. Removes about 60 to 75 lines of
skeleton across three files and adds about 45 (the walk, the handler
interface, its generics over the accumulator and error type). Net elements:
+2 (one function, one interface), −0. Risks: the handlers need lookahead
(Anthropic's system rule), the previous output item (Google's join), and
per-group versus per-result results, so the interface grows a context
argument per quirk and becomes a pass-through with a wide signature. A
switch that the compiler already checks for exhaustiveness is traded for a
table.

**B. A normalized intermediate the three lower from.** Flatten the history
once into a list of provider-neutral items (system update, user content,
answered result, text, reasoning, call), then map items per provider. The
neutral history is already this intermediate; a second one adds a type and a
pass, and the grouping the providers disagree on (per message, per group,
per part) has to be either lost or carried along. Net elements: +2 or more;
lines roughly even. Same wire-equivalence risk as A, plus OpenAI's
`loweredItemCount` would have to count the new items.

**C. Leave the walks, record the result.** No code change; add an entry to
`.agents/docs/refuted-candidates.json` beside the existing one that refused
the codec layout move, so the next audit does not re-raise it.

### Recommendation and verification

Choose C. A and B both add an interface over three callers whose branches
share no behavior, which is the single-caller-extraction and pass-through
shape the design guardrails refuse. Two smaller follow-ups are worth doing
on their own:

1. Decide whether Google should call `replayableHistory`. Today it handles
   another model's reasoning by skipping it in its own walk, while the other
   two codecs rely on the shared function. If the Google behavior is the
   same fact, call the shared function and delete the skip; if it differs on
   purpose, say why in the comment that currently points at the other codecs.
2. If a fourth protocol is added, revisit A with four callers.

Any change here is checked by the request bodies the codec suites already
assert: `packages/llm/test/api/AnthropicMessages.vitest.ts` (signed and
redacted blocks, ordered tool results, replay of another codec version),
`packages/llm/test/api/OpenaiResponses.vitest.ts`, and
`packages/llm/test/llm/GoogleInteractions.vitest.ts`, then the live suites
`packages/llm/test-live/anthropicMessages.live.ts`,
`packages/llm/test-live/googleInteractions.live.ts` and
`packages/llm/test-live/openaiResponses.live.ts`. Prompt-cache hits depend
on byte-identical prefixes (the top-level Anthropic `cache_control`, the
Responses prefix fingerprint in `packages/llm/src/api/prefixFingerprint.ts`),
so a refactor must leave every lowered body byte-identical, not merely
equivalent.

## 2. Recovery steps 3 to 5 of `extractReplyDocuments`

### The protocol and the steps

The reply format is fixed and stated once: `document_context`
(`packages/texra/src/tools/documents/documentState.ts`) ends every revision
request with the exact envelope, a `<documents>` container holding one
`<document name="...">` per expected file. Agent YAML never restates it.
`document_extract` (`packages/texra/src/tools/documents/documentTools.ts`)
applies the replacement rules, closes an open container
(`ensureCorrectXmlStructure`) and calls `extractReplyDocuments`
(`packages/texra/src/agent/output/replyDocuments.ts`), which tries these in
order and stops at the first that yields documents:

| Step | What it reads                                                                                         | What malformed reply it rescues                                       | Allowed when                               |
| ---- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------ |
| 1    | named document tags, in the container or anywhere in the reply; an unclosed tag is closed first       | the protocol itself, plus a missing container or a truncated last tag | always                                     |
| 2    | `% path/file.tex` comment headers and bare known-file labels, with or without Markdown fences         | a model that answered in Markdown but still named each file           | always; names limited to the expected ones |
| 3    | unlabeled ` ```latex ` / ` ```tex ` fences (first fence for a rewrite, all fences for a new document) | a model that dropped every label                                      | exactly one expected document              |
| 4    | a bare `\documentclass ... \end{document}` block anywhere in the reply                                | a model that dropped the tags and the fences                          | exactly one expected document              |
| 5    | unlabeled fences matched to the inputs by content similarity                                          | a model that dropped every label on a multi-file rewrite              | several inputs rewritten in place          |

Steps 1 and 2 route content by a name the model wrote. Steps 3 to 5 guess:
3 and 4 assume the only expected name, 5 picks the most similar input.
The replacement rules (`packages/texra/src/replacement/rules.ts`) add two
more repairs before step 1: an empty `name=""` becomes `unknown`, and stray
XML prologue and fence noise is removed.

The cost of the guessing steps: `contentSimilarity.ts` and most of the fence
parsing in `packages/texra/src/agent/output/extraction/` (about 300 lines
for similarity; fence parsing is shared with step 2), the base-file
plumbing in `outputFileExtraction.ts` (`similarityBaseFiles`, about 35
lines, which exists only for step 5), and most of
`src/test-kernel/agent/output/ReplyDocuments.vitest.ts`. The risk they carry
is the worse one: a wrong guess writes prose or a scratch draft into a
user's file as if it were the answer, and the round reads as a success.

### A stricter protocol

Three options, from least to most change:

1. **One accepted envelope, reject otherwise.** Keep steps 1 and 2. A reply
   that names no document yields no outputs and the existing warning; the
   round's `missing` list already reaches the critic through
   `document_review`, and the raw reply is kept.
2. **Reject and ask again.** As 1, plus the document recipe
   (`packages/texra/src/agent/output/documentRecipe.ts`) re-requests once
   with a short message naming what was missing, before compile and diff.
   One extra model call on a malformed reply instead of a guess.
3. **Tool-call emission.** The model writes each document through a tool
   call with a `name` argument. Removes text parsing entirely, but changes
   every document agent's prompt, the streaming preview and the cost profile
   of long documents; it is a feature-sized change, not a simplification.

Option 2 is the proposed target; option 3 is recorded, not proposed.

### Evidence needed first

There is no count today. Each step logs a `debug` line ("Recovered documents
from ...") through the run's trace, with no structured field naming the
step, and nothing aggregates them. Before retiring anything:

- add one structured field (the step that produced the documents) to the
  existing log line, or to the round record beside `missingOutputs`, so a
  stored run says which step fired;
- run the bundled document agents (`polish`, `correct`, `ocr`,
  `paper2slide` under `packages/extension/resources/agents/`) across the
  supported model routes and count step 1 through 5 hits;
- retire a step when it fires on none of the current routes, or only on
  routes where the re-request of option 2 succeeds.

The envelope is appended verbatim as the last text of every request, so the
rate at which steps 3 to 5 fire may already be near zero; that is a guess
until counted.

### Behavior change for users

With steps 3 to 5 gone, a reply that today is silently salvaged becomes a
revision that wrote nothing (option 1) or costs one more model call (option
2). The user sees a warning with the kept reply instead of a file whose
content was guessed. Weak or small models are the likely losers; custom
agents are unaffected in format because the envelope is not theirs to write.

### Staged plan

1. Record which step fired (one field, no behavior change).
2. Collect counts over the bundled agents and routes; attach the table to
   this note.
3. Add the single re-request to the recipe behind the same counts: confirm
   it recovers the replies steps 3 to 5 rescued.
4. Delete step 5 first (largest, least certain guess, and the only user of
   `similarityBaseFiles` and `assignByContentSimilarity`), then 4, then 3,
   each with its tests in `ReplyDocuments.vitest.ts`.
5. Re-read step 2 and the two replacement rules with the same counts; they
   may follow.

Net elements when complete: negative (three steps, the similarity module,
the base-file mapping and their tests removed; one log field and one
re-request added).

## 3. Audit findings checked and left as they are

The same audits listed these as code changes. Each was read against the tree
and not made, for the reason given, so a later audit does not raise it again
without new evidence.

- **`extractReplyDocuments` as one ordered list of steps.** The five steps
  share only "runs when nothing was found yet". They read different inputs
  (the tag-repaired reply or the raw one), have different conditions, two of
  them also add to `missing`, and one reads files while four are plain. A
  list needs a step type, a shared result shape and Effect wrappers on the
  plain steps, and removes four `!documents` conditions: more elements, same
  order. Section 2 removes steps instead. One smaller lead: the bare
  `\documentclass` step calls `documentsByTags` a second time only to reach
  its fallback, which parses the tags again and repeats a debug line;
  calling the fallback directly changes log output.
- **The max-style `\rho` equilibrium entries**
  (`packages/texra/src/replacement/maxRules.ts`). Their comment called them
  inert. The engine applies the longest pattern first, so they run before
  the shorter `\text{eq}` rules and decide the output
  (`\rho_{\text{eq}}` becomes `\rhoeq`; without them it becomes
  `\rho_\eq`). They stay, and the comment now says what they do.
- **Leading global flags in `packages/cli/src/commands/_helpers/dispatch.ts`.**
  Already one partition (`collectLeadingGlobalFlags`) used by the three
  reordering functions. `knownGlobalFlagTokenCount` is the per-token
  classifier it is built on, and `hasUsageNoColorFlag` scans the whole
  argv on purpose, to find `--no-color` after the subcommand.
- **`ancestryRows` in `RunRegistry.ancestorsOf` and the hook input's root
  lookup** (`packages/harness/src/agent/runtime/runRegistry.ts`,
  `packages/harness/src/agent/runtime/loop/hooks.ts`). Not the same walk.
  `ancestryRows` includes the starting run and drops a parent whose facts
  cannot be read; both call sites leave the run out or keep that parent's
  id (a removed ancestor is still the hook `session_id`). An adapter at
  either site is longer than the loop it replaces.
- **`selectAvailableDelegationModel` called twice per launch.** Two
  decisions: the launch checks the model the call asked for; the second
  call runs only when a person picked another model at approval, after a
  wait in which availability can change, and its error result has different
  text and no `ModelUnavailable` name. Making the two results the same
  shape is a wording change for the model and for scripts that catch the
  name, so it is a decision, not a cleanup.
- **`finishCall` split into "decide" and "run"**
  (`packages/harness/src/agent/runtime/loop/toolUseDispatch.ts`). What can
  be decided before any effect already is, as the early returns at the top.
  Whether the body starts is decided inside the guarded call (the
  pre-tool hook, the read-only checks, a person's approval), so
  `bodyStarted`, the output-stream state and `result` are set from effect
  results and would move, not disappear. One of the five variables was
  removed: `ran` always equalled the issued input where it was read.

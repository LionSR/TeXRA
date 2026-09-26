---
name: multi-agent-orchestration
description: Shape a delegate_multi_agents workflow script so it is thorough and trustworthy, not just parallel. Use before writing any workflow script, and when deciding between one script, several scripts in sequence, or plain delegate_agent calls. Covers pipeline versus barrier, adversarial verification, referee panels, loop-until-nothing-new sweeps, completeness critics, and what a script should return.
---

# Multi-Agent Orchestration

A workflow script is where you encode the structure of the work: what fans
out, what gets checked, and what gets combined. Parallelism is the easy part.
The value is in the checks: a finding a second, independent agent failed to
refute is worth more than three findings nobody checked.

## Choose the shape first

- **Plain `delegate_agent`** when the next step depends on reading the last
  result. You stay in the loop between steps.
- **One `delegate_multi_agents` script** when the whole fan-out and join is
  known before the run starts.
- **Several scripts in sequence, one per phase** for larger work: understand,
  then decide, then act, then check. Read each result before writing the next
  script. A decision the user should make never goes inside a script.

It is fine to scout first. List the sections, find the claims, or scope the
diff with ordinary tools, then write the script over that list.

## Primitives, and the traps in them

- `pipeline(items, stage1, stage2, ...)` is the default for multi-stage work.
  Each item moves through the stages on its own, so a fast item is already
  being verified while a slow one is still being read. Each stage receives
  `(previousResult, originalItem, index)`. A stage that returns `null` ends
  that item as `null`.
- `parallel(thunks)` is a barrier. Use it between stages only when the next
  stage needs every earlier result at once: dedup across all findings, stop
  early when the total is zero, or compare items against each other. Flatten,
  map, and filter do not need a barrier. Do them inside a pipeline stage.
- A failed call and a call the user skipped both resolve to `null`. Filter
  nulls before combining results. The run log says which were skipped.
- Two calls with the same prompt and options need distinct `id`s. A panel of
  voters on the same question is the usual case: give each voter its own id,
  or better, its own angle (see referee panels below).
- Without `meta.tasks`, pass `{ phase }` on each call inside `pipeline()`
  stages. The global `phase()` is shared, and concurrent items race on it.
- Structured calls (`schema`) must name a tool-use agent with `agentName` and
  take no file options. Put the file paths in the prompt; the agent reads
  them with its own tools.
- `Date.now()` and `Math.random()` throw, because they would break resume.
  Vary work by index instead.

## Patterns

Pick what the task needs and combine them freely.

### Adversarial verification

For every finding that matters, spawn independent agents told to refute it,
defaulting to "refuted" when they cannot confirm it. Keep the finding only if
a majority fail to refute it. This stops plausible but wrong findings, which
are the most common failure of a single reviewer.

### Referee panel

When a claim can fail in more than one way, give each verifier a different
angle instead of asking the same question three times. Diversity catches
failure modes that repetition cannot. For a derivation, useful angles are
signs and factors, whether the stated hypotheses are actually used, and
limiting or special cases. For a paper, they are correctness, notation,
literature, and clarity.

### Loop until nothing new

For discovery of unknown size (notation clashes, undefined symbols, broken
cross-references, unsupported claims), keep running finders until two rounds
in a row find nothing new. A fixed count misses the tail. Dedup against
everything seen so far, not only against what was confirmed, or rejected
findings come back every round and the loop never ends. Always add a round
cap as a backstop, and log when it is hit.

### Completeness critic

End with one agent that asks what is missing: a section nobody read, a claim
nobody verified, a source nobody opened. What it finds is the next round of
work, or the caveat in your report.

### Staged escalation

Run a cheap model over everything, and send only the uncertain or high-stakes
items to a stronger model. Set `model` per call for this. Omit it everywhere
else so ordinary delegation policy applies.

## Example: verify the load-bearing claims of a paper

```js
export const meta = {
  name: 'verify-claims',
  description: 'Find load-bearing claims per section, then try to refute each',
  phases: ['Find', 'Verify'],
};
const CLAIMS = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['location', 'statement'],
        properties: {
          location: { type: 'string' },
          statement: { type: 'string' },
        },
      },
    },
  },
};
const VERDICT = {
  type: 'object',
  required: ['refuted', 'reason'],
  properties: { refuted: { type: 'boolean' }, reason: { type: 'string' } },
};
const ANGLES = [
  'signs, factors, and algebra',
  'whether each stated hypothesis is actually used and sufficient',
  'limiting and special cases',
];

async function referee(claim, key) {
  const votes = await parallel(
    ANGLES.map(
      (angle, n) => () =>
        agent(
          `Try to refute this claim, focusing on ${angle}. Read the source ` +
            `before judging. If you cannot confirm the claim, set refuted=true.\n` +
            `${claim.location}: ${claim.statement}`,
          {
            agentName: 'prover',
            schema: VERDICT,
            phase: 'Verify',
            id: `${key}:${n}`,
          },
        ),
    ),
  );
  const cast = votes
    .filter((vote) => vote !== null)
    .map((vote) => vote.structured);
  const upheld = cast.filter((verdict) => !verdict.refuted).length;
  return { ...claim, upheld, of: cast.length, verdicts: cast };
}

const perSection = await pipeline(
  args.sections,
  (path) =>
    agent(
      `Read ${path}. List the claims later results depend on. Skip background.`,
      {
        agentName: 'review',
        schema: CLAIMS,
        phase: 'Find',
        id: `find:${path}`,
      },
    ),
  (found, path) =>
    parallel(
      found.structured.claims.map(
        (claim, i) => () => referee(claim, `verify:${path}:${i}`),
      ),
    ),
);
const checked = perSection.filter((section) => section !== null).flat();
const dropped =
  args.sections.length - perSection.filter((s) => s !== null).length;
if (dropped > 0)
  log(`${dropped} section(s) failed to read and were not checked.`);
return {
  suspect: checked.filter((claim) => claim.upheld < 2),
  upheld: checked.filter((claim) => claim.upheld >= 2).length,
  sectionsUnchecked: dropped,
};
```

## What a script should return

The return value comes back to you as data inside `<workflow-script-result>`,
next to the run log. Return compact, structured results you can act on: the
suspect claims with their reasons, counts of what passed, and anything that
was not covered. Do not return prose for its own sake, and do not return
whole documents; workflow-agent calls already report their output files.

## Scale and honesty

- Scale to the request. "Check this" gets a few finders and one vote each.
  "Audit this thoroughly" gets a bigger finder pool, three to five votes per
  finding, and a completeness critic.
- No silent caps. If the script samples, takes the top N, or stops at a round
  limit, `log()` what it dropped and say so in the return value. A silent cap
  reads as "covered everything".
- Keep verifiers independent. Give a verifier the claim and the source, not
  the finder's reasoning, so it cannot simply agree with it.
- If the run times out or is interrupted, call the tool again with the same
  `meta.name` and agent. Completed calls replay from the journal for free.

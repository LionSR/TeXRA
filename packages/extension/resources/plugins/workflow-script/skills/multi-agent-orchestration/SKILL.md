---
name: multi-agent-orchestration
description: Coordinate several agents so the work is thorough and trustworthy, not just parallel. Use before delegating work that spans more than one agent, and when deciding between direct `agent` calls you route yourself, one `script` that fans out and joins, or several scripts in sequence. Covers parent-routed coordination, per-item branches versus stage barriers, failures with try/catch and Promise.allSettled, adversarial verification, referee panels, loop-until-nothing-new sweeps, completeness critics, and what a script should return.
---

# Multi-Agent Orchestration

You coordinate; the agents you call do the work. Parallelism is the easy
part. The value is in the checks: a finding a second, independent agent
failed to refute is worth more than three findings nobody checked.

## Choose the shape first

- **Direct `agent` calls, routed by you (the default).** Call `agent`, read
  the result when it arrives, and decide what runs next. Launch independent
  calls in the same turn so they run together. Children do not message each
  other: every result comes back to you, and you pass on what the next agent
  needs, in its prompt or as its files. Use this whenever the next step
  depends on reading the last result.
- **One `script`** when the whole fan-out and join is known before anything
  runs: the items, the steps per item, and how results combine. The script
  calls `agent()` in code, and you read one result at the end.
- **Several scripts in sequence, one per phase** for larger work:
  understand, then decide, then act, then check. Read each result before
  writing the next script. A decision the user should make never goes inside
  a script.

It is fine to scout first. List the sections, find the claims, or scope the
diff with ordinary tools, then write the script with that list as a literal
in the code. A script has no arguments or bound files: its inputs are
literals.

## Script basics

`code` is the body of an async function. `await agent(prompt, opts)` runs
one agent and resolves to `{ category, response | outputs, structured?,
outcome, cost }`. A workflow agent takes `inputFiles` and resolves with
`outputs` (each with an `absolutePath` you can pass to the next call); a
tool-use agent resolves with `response`, or with `structured` when you pass
`schema`. `Promise.all` runs calls together, `try`/`catch` recovers,
`phase(title)` labels the calls that follow, and `console.log` lines come
back with the result (the last 80). There are no timers, no `Date.now()`,
no `Math.random()`, and no imports: the script replays exactly after an
interruption, and calls that finished are not run again.

The user approves the script once, seeing its source, and that approval
covers every `agent` call in it. Pass `run_in_background: true` for a long
script: it runs as its own background run and its result and a summary
arrive as one follow-up, so you keep working meanwhile.

## Branches, not stage barriers

The most common mistake is writing the work stage by stage:

```js
// Slow: every section waits for the slowest reader before any verifying starts.
const read = await Promise.all(
  SECTIONS.map((s) => agent(`Read ${s}`, { agentName: 'review' })),
);
const checked = await Promise.all(
  read.map((r) => agent(`Verify ${r.response}`, { agentName: 'prover' })),
);
```

Give each item its own async branch instead. Each branch moves through its
steps on its own, so one section is already being verified while a slower
one is still being read:

```js
const checked = await Promise.all(
  SECTIONS.map(async (s) => {
    const read = await agent(`Read ${s}`, { agentName: 'review' });
    return agent(`Verify ${read.response}`, { agentName: 'prover' });
  }),
);
```

Total time drops from "slowest read plus slowest verify" to "slowest single
section", and agent run times vary a lot.

Keep a barrier, meaning a second `Promise.all` over the first one's results,
only when the next step needs every earlier result at once: dedup across all
findings, stop early when the total is zero, or compare items against each
other. Flatten, map, and filter do not need a barrier.

## Failures and the other traps

- A failed call rejects with an Error whose `name` is `AgentFailed`; a call
  the user stopped rejects with `Skipped`, one past its `timeoutMs` with
  `TimedOut`, and one whose model is unavailable with `ModelUnavailable`.
  Check `error.name` in a `catch`.
- `Promise.all` rejects on the first failure, but the other calls keep
  running and their results are lost to it. For tolerant fan-out, catch
  inside each branch (`async (s) => { try { ... } catch (e) { return
{ s, error: e.name } } }`) or use `Promise.allSettled` and keep the
  `status === 'fulfilled'` values. An uncaught rejection ends the script.
- Retry with a loop and try/catch. Give each attempt its own `id`
  (``id: `${key}#${n}` ``): two calls of one script with the same prompt,
  options and files reject with `DuplicateCall`. A `Skipped` call is the
  user's verdict; do not retry it.
- Two calls with the same prompt and options need distinct `id`s. A panel of
  voters on the same question is the usual case: give each voter its own id,
  or better, its own angle (see referee panels below).
- A completed call is reused, not run again, by a later identical call in
  this run. Rerunning a fixed script re-sends the code, and every call that
  already finished comes back free.
- `phase(title)` labels the calls issued after it. Branches interleave their
  steps, so a branched stretch of work is one phase; tell its steps apart
  with `label` (for example `Find: intro.tex`, `Verify: intro.tex #2`).
- `schema` needs a tool-use agent and takes no file options. Put file paths
  in the prompt; the agent reads them with its own tools.
- A script launches at most 1000 agents. The session's child-run budget sets
  how many run at once; to hold fewer in flight, run the items in batches.

## Patterns

Pick what the task needs and combine them freely. Each works with direct
calls you route as well as inside a script.

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
findings come back every round and the loop never ends. Give each round's
calls their round number in `id`, always add a round cap as a backstop, and
log when it is hit.

```js
const SYMBOLS = {
  type: 'object',
  required: ['symbols'],
  properties: { symbols: { type: 'array', items: { type: 'string' } } },
};
const seen = new Set();
let quiet = 0;
let round = 0;
for (; round < 6 && quiet < 2; round++) {
  const found = await agent(
    `List undefined symbols in main.tex not in this list: ${[...seen].join(', ')}`,
    { agentName: 'review', schema: SYMBOLS, id: `round:${round}` },
  );
  const fresh = found.structured.symbols.filter((s) => !seen.has(s));
  fresh.forEach((s) => seen.add(s));
  quiet = fresh.length === 0 ? quiet + 1 : 0;
}
if (quiet < 2) console.log(`Stopped at the ${round}-round cap.`);
```

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
const SECTIONS = [
  'sections/intro.tex',
  'sections/model.tex',
  'sections/proof.tex',
];
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

// One claim, three referees with different angles, each allowed to fail.
async function referee(claim, key) {
  const votes = await Promise.allSettled(
    ANGLES.map((angle, n) =>
      agent(
        `Try to refute this claim, focusing on ${angle}. Read the source ` +
          `before judging. If you cannot confirm the claim, set refuted=true.\n` +
          `${claim.location}: ${claim.statement}`,
        {
          agentName: 'prover',
          schema: VERDICT,
          id: `${key}:${n}`,
          label: `Verify: ${key} #${n + 1}`,
        },
      ),
    ),
  );
  const cast = votes
    .filter((vote) => vote.status === 'fulfilled')
    .map((vote) => vote.value.structured);
  const upheld = cast.filter((verdict) => !verdict.refuted).length;
  return { ...claim, upheld, of: cast.length, verdicts: cast };
}

// One branch per section: find its claims, then referee each claim.
phase('Review');
const perSection = await Promise.all(
  SECTIONS.map(async (path) => {
    try {
      const found = await agent(
        `Read ${path}. List the claims later results depend on. Skip background.`,
        {
          agentName: 'review',
          schema: CLAIMS,
          id: `find:${path}`,
          label: `Find: ${path}`,
        },
      );
      return await Promise.all(
        found.structured.claims.map((claim, i) =>
          referee(claim, `verify:${path}:${i}`),
        ),
      );
    } catch (error) {
      return { path, failed: error.name };
    }
  }),
);
const checked = perSection.filter(Array.isArray).flat();
const unchecked = perSection
  .filter((section) => !Array.isArray(section))
  .map((section) => `${section.path} (${section.failed})`);
if (unchecked.length > 0) console.log(`Not checked: ${unchecked.join(', ')}`);
return {
  suspect: checked.filter((claim) => claim.upheld < 2),
  upheld: checked.filter((claim) => claim.upheld >= 2).length,
  unchecked,
};
```

## What a script should return

The return value comes back to you as JSON with the script's result, next to
the last lines it logged. Return compact, structured results you can act on:
the suspect claims with their reasons, counts of what passed, and anything
that was not covered. Do not return prose for its own sake, and do not return
whole documents; workflow-agent calls already report their output files,
which you review and accept with `accept_run_files`.

## Scale and honesty

- Scale to the request. "Check this" gets a few finders and one vote each.
  "Audit this thoroughly" gets a bigger finder pool, three to five votes per
  finding, and a completeness critic.
- No silent caps. If the script samples, takes the top N, or stops at a round
  limit, `console.log` what it dropped and say so in the return value. A
  silent cap reads as "covered everything".
- Keep verifiers independent. Give a verifier the claim and the source, not
  the finder's reasoning, so it cannot simply agree with it.
- If a script times out, is interrupted, or fails on a bug, fix it and send
  it again in the same run. Calls that completed are reused for free; only
  the unfinished ones run.

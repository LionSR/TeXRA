# Design red-flag audit brief (read-only)

You are auditing one area of the TeXRA repo (/home/user/TeXRA) for DESIGN problems in the sense of Ousterhout, _A Philosophy of Software Design_. The owner's verdict on the run-lifecycle cluster was: "these are design problems, not naming problems; many similar ones are red flags; find more, then find the better design". Your job: find the same species in your area, with evidence, and for each one propose the design that would make it disappear.

Do NOT edit any file. Do NOT run tests or builds. Read code with cat/sed/grep (or Read/Grep). Cite every claim as `path:line`. Grep consumer counts for every symbol you propose to delete or collapse (production corpus: packages/_/src; non-production: src/test-kernel, packages/_/test, docs).

## Read first (10 minutes)

- /home/user/TeXRA/AGENTS.md "Design guardrails", "Plain names and comments", "Effect" sections.
- /home/user/TeXRA/packages/harness/AGENTS.md "Run loop architecture", "Event channels and cards".
- /home/user/TeXRA/.agents/docs/proposed/architecture/2026-11-03-one-fact-one-representation.md — the owner's accepted decisions O1–O10 (sections "Owner decisions" and "Decided 2026-11-04"). Do not re-report what that note already lists in its "Findings by area" tables; you may cite it and add a NEW angle (a red flag it does not name, or a design it does not propose). O1 = one process per store (claims, liveness prover, takeover, ownedElsewhere, held parks all to be deleted). O2 = stop reason is 'user'|'shutdown' on run.end, nothing else. O3 = the `abort` error kind is deleted; a stop is fiber interruption. O4 = nothing resumes at open. O5 = an awaited child's result is its tool.result; a background child's completion is one delivered message that wakes the parent. O6 = hosts read view fields, never re-derive. O8 = retryability is llm's verdict once. O9 = parent edge in a writing job is the rows'.
- /home/user/TeXRA/.agents/docs/implemented/architecture/2026-09-20-single-owner-liveness-and-one-fold.md section 3 "What stays, and why" (settled; beat the rationale or leave it).

## What already counts as found (the run-lifecycle cluster, do not repeat)

In runRegistry.ts / resumeRun.ts / runLaunchGuard.ts / AgentRunLifecycle.ts / storage/runLifecycle.ts / ownerLiveness.ts the lead auditor already named: Activation as a state machine encoded in optional fields; RunRegistry.start's 5 params with a callback and a mode-changing optional; resume temporally decomposed across three files with a shared mutable RunAttempt{waiters, handedOff}; the claim protocol (log.hold) leaking into 12 call sites; a nine-function pass-through chain to write one run.end row; finalizeRun's three-level storage-failure fallback; runLaunchGuard.ts as a conjoined, vaguely named file; 'released' as a sentinel stop cause; stop() returning {accepted, settlement}; comment density 28–35% substituting for design. inFlight.ts (nextAttempt as a pure reducer over rows) was judged GOOD: a deep module to copy.

## The red flags to look for (name the flag in each finding)

- Shallow module: interface nearly as complex as the implementation; many small exported functions each doing one step of one caller.
- Information leakage: a protocol/invariant (when to hold a claim, which row commits with which, how a stop propagates, how an id is derived) known by several modules.
- Temporal decomposition: one operation split into modules by WHEN things happen rather than by what knowledge they hide.
- Overexposure / pass-through: a method or module that forwards; an option/flag/mode that is a decision the code refused to make ("No option for a special case" in AGENTS.md). Includes a boolean or literal parameter whose value is constant per caller, a callback parameter with one shape, a column of a declarative table that is constant or derivable.
- Special and general code mixed: a general path with branches for one caller's case.
- Conjoined methods / vague names: a file whose name covers one of several unrelated things it holds.
- State machine in optional fields / sentinel values: `x?: T` combinations or a literal meaning "none" (`'released'`), where a type or a fiber/scope/Deferred would carry the state.
- Reinvented Effect primitives: hand-rolled waiter counts, readiness Deferreds, observers, uninterruptible masks, generation counters, "drained" promises, where Fiber/Scope/Semaphore/Queue/PubSub/SubscriptionRef/Latch already is the thing. Also `Effect.uninterruptible`/`interruptUnsafe`/`addObserver`/`isDoneUnsafe` clusters: each one is evidence the fiber model is being fought.
- Error handling that should be defined out of existence: multi-level fallbacks for failures the process cannot recover from (storage write failed), catch sites that re-classify, "backstop" writes, warnings logged for conditions the design could make impossible.
- Two representations of one fact (a derived predicate, a view field, an in-memory flag and a row field that answer the same question). Count them; name which survives.
- Comments substituting for design: a doc comment that explains a hand-off protocol or a sequence of states is a sign the structure, not the prose, is wrong. Report comment-line share for the worst files (grep -cE '^\s*(/\*|\*|//)' vs total).
- Change amplification: name one plausible change (e.g. "add a second kind of child", "a run gets a third terminal outcome", "a host adds a surface") and count the files it touches.

## Output format (write to the file named in your task, then return a summary)

For each finding (aim for the 5–12 strongest; thin ones batched or dropped):

1. **Title** (what is wrong, in plain words) and the red flag(s).
2. **Evidence**: `path:line` citations, consumer counts, a quoted line or two.
3. **The design decision behind it**: the root question the code answers in several places or in the wrong place.
4. **The better design**: what the module boundary should be, what one structure replaces the several, what is DELETED (list symbols with counts), what the callers write against afterwards. Prefer: Effect primitives over hand-rolled; rows over in-memory flags; one transaction over a sequence; a type over a sentinel; refusing a case at a boundary over handling it everywhere.
5. **What we give up** (honest: a capability, a message, a special case) and risk.
6. **Change amplification before/after** for one named change.

Then a short section **"Good modules in this area"**: anything that is a deep module worth copying, so the owner does not throw out the good with the bad.

Then **"Already settled, left alone"**: things you considered and rejected because a dated implemented note or AGENTS.md rule justifies them, with the citation.

Be honest. A module that is fine is reported as fine. Do not pad.

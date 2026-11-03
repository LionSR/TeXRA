
const draft = String.raw`
\section{Setup}
Let $K \subset \mathbb{R}^n$ be compact and $f\colon K \to \mathbb{R}$ continuous.
\section{Main bound}
We claim $\sup_K |f| \le 1$. The proof is omitted.
\section{Discussion}
The bound is sharp for constant functions.
`;

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["section", "verdict", "gaps", "next_section"],
  properties: {
    section: { type: "string" },
    verdict: { type: "string" },
    gaps: { type: "array", items: { type: "string" } },
    next_section: {
      type: "string",
      description: "Exact name of the section the next round should review; empty if none applies."
    }
  }
};

// Round 1: Setup only.
const r1 = await self(
  `You are reviewing a math draft strictly, section by section.

Full draft:
${draft}

Round 1 task: review ONLY the "Setup" section (do not audit other sections).
Check: are all objects introduced and quantified correctly (compactness, codomain, continuity), is the notation well-defined, are any hypotheses missing for what later sections would need?

Report verdict "pass" if Setup has no gap of its own; otherwise "fail" with the specific gap.
In "next_section" put the exact section title (Setup / Main bound / Discussion) that round 2 should review next: the section your verdict points to, or "Main bound" if your verdict names no section.`,
  { schema, label: "round 1: Setup" }
);

const v1 = r1.structured;
console.log("ROUND 1:", JSON.stringify(v1));

const signoff = await await_signoff({
  verdict: `Round 1 (Setup): ${v1.verdict} Gaps: ${v1.gaps.join("; ") || "none"}. Next round reviews: ${v1.next_section}.`
});
console.log("SIGNOFF:", signoff.output);

// Round 2: only after sign-off, on the section round 1 named.
const target = (v1.next_section || "").trim() || "Main bound";

const r2 = await self(
  `You are reviewing a math draft strictly, section by section.

Full draft:
${draft}

Context from round 1 (Setup review): ${JSON.stringify(v1)}
Round 1 pointed round 2 at the section: "${target}".

Round 2 task: review ONLY the "${target}" section. Verify the claim as stated against what the draft actually establishes: state whether it is proved, and name precisely what is missing (missing hypotheses/quantifiers, unproved assertion, dependence on results not in the draft). Be concrete about whether the statement is even true under the Setup hypotheses.

Report verdict "pass" or "fail", with gaps listed. Set "next_section" to "" and "section" to "${target}".`,
  { schema, label: `round 2: ${target}` }
);

const v2 = r2.structured;
console.log("ROUND 2:", JSON.stringify(v2));

await_signoff({
  verdict: `Round 2 (${target}): ${v2.verdict} Gaps: ${v2.gaps.join("; ") || "none"}.`
});

return {
  round1: v1,
  round2: v2,
  signoff_required_between_rounds: true
};



// Pinned-memory check (harmless if empty); review work happens below in this same program.
let memNote = "no memory";
try {
  const mem = await tools.memory({ command: "view" });
  const out = (mem && (mem.output ?? mem)) + "";
  memNote = out.slice(0, 400);
} catch (e) {
  memNote = "memory unavailable: " + e.message;
}

const DRAFT = String.raw`\section{Setup}
Let $K \subset \mathbb{R}^n$ be compact and $f\colon K \to \mathbb{R}$ continuous.
\section{Main bound}
We claim $\sup_K |f| \le 1$. The proof is omitted.
\section{Discussion}
The bound is sharp for constant functions.`;

const round1 = await self({
  label: "Round 1 — Setup",
  fork: true,
  schema: {
    type: "object",
    properties: {
      section: { type: "string" },
      verdict: { type: "string" },
      gap: { type: ["string", "null"] },
      severity: { type: "string", enum: ["none", "minor", "major"] },
      points_to_section: { type: ["string", "null"], enum: ["Main bound", "Discussion", null] }
    },
    required: ["section", "verdict", "gap", "severity", "points_to_section"],
    additionalProperties: false
  },
  prompt: `Round 1 of a staged review. Review ONLY the Setup section of this draft — do not audit the later sections' mathematics.

${DRAFT}

Judge whether the Setup section as written establishes a usable, well-formed setting (objects declared, hypotheses stated, no missing definitions that the section itself is responsible for). "Setup" here is a hypotheses/notation block, so a missing hypothesis about f is NOT a Setup defect — it belongs to the section that states the claim.

Return structured output:
- section: "Setup"
- verdict: one or two sentences, self-contained (it will be the sign-off text).
- gap: the Setup-level defect, or null if none.
- severity: "none" | "minor" | "major".
- points_to_section: the downstream section the next round must examine because of your verdict. Allowed values are exactly "Main bound", "Discussion", or null. Never point back at "Setup". If your verdict does not single out a downstream section, use null — the pipeline then defaults to "Main bound".`,
});

const r1 = round1.structured ?? {
  section: "Setup",
  verdict: (round1.response || "").trim(),
  gap: null,
  severity: "none",
  points_to_section: null,
};

const r1Verdict = `${r1.verdict} (Setup severity: ${r1.severity}; gap: ${r1.gap ?? "none"}; next: ${r1.points_to_section ?? "Main bound (default)"})`;

// Wait for the reviewer to sign off round 1 before round 2 starts.
const signoff = await tools.await_signoff({ verdict: r1Verdict });

const target = r1.points_to_section ?? "Main bound";
const targetBody =
  target === "Discussion"
    ? String.raw`\section{Discussion}
The bound is sharp for constant functions.`
    : String.raw`\section{Main bound}
We claim $\sup_K |f| \le 1$. The proof is omitted.`;

const round2 = await self({
  label: `Round 2 — ${target}`,
  fork: true,
  schema: {
    type: "object",
    properties: {
      section: { type: "string" },
      verdict: { type: "string" },
      gaps: { type: "array", items: { type: "string" } },
      severity: { type: "string", enum: ["none", "minor", "major"] }
    },
    required: ["section", "verdict", "gaps", "severity"],
    additionalProperties: false
  },
  prompt: `Round 2 of a staged review. Round 1 was signed off with this verdict:

"${r1Verdict}"

Round 1 pointed the review at the "${target}" section. Now review ONLY that section of the draft.

Full draft for context (do not audit other sections):

${DRAFT}

Target section in isolation:

${targetBody}

Check the section on its own terms: is the stated claim supported, are its hypotheses present (as inherited from Setup), and is anything asserted without argument? Be concrete about what is missing and what would fix it.

Return structured output:
- section: "${target}"
- verdict: two or three sentences, self-contained.
- gaps: list of specific gaps (empty array if none).
- severity: "none" | "minor" | "major".`,
});

const r2 = round2.structured ?? {
  section: target,
  verdict: (round2.response || "").trim(),
  gaps: [],
  severity: "none",
};

return {
  memory: memNote.split("\n").slice(0, 6).join(" | "),
  round1: r1,
  signoff,
  target,
  round2: r2,
};


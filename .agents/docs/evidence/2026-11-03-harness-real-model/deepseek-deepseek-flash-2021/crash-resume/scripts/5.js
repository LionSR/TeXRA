// Pinned-memory check (kept short; review work is below in this same program).
let memNote = "no memory";
try {
  const mem = await tools.memory({ command: "view" });
  memNote = String(mem.output ?? "").split("\n").filter(Boolean).slice(0, 8).join(" | ");
} catch (e) {
  memNote = "memory unavailable: " + e.message;
}

const DRAFT = [
  "\\section{Setup}",
  "Let $K \\subset \\mathbb{R}^n$ be compact and $f\\colon K \\to \\mathbb{R}$ continuous.",
  "\\section{Main bound}",
  "We claim $\\sup_K |f| \\le 1$. The proof is omitted.",
  "\\section{Discussion}",
  "The bound is sharp for constant functions.",
].join("\n");

const r1Prompt = [
  "Round 1 of a staged review. Review ONLY the Setup section of the draft below; do not audit the later sections' mathematics.",
  "",
  DRAFT,
  "",
  "Judge whether the Setup section, as a hypotheses/notation block, sets up a usable, well-formed claim: are its own objects declared and its own hypotheses stated, without an internal defect that breaks it? A missing hypothesis about f (e.g. boundedness) is NOT a Setup defect -- it belongs to the section that states the claim, and you should not import it here.",
  "",
  "Return structured output:",
  '- section: "Setup"',
  "- verdict: one or two self-contained sentences; this text is what the reviewer signs off.",
  '- gap: the Setup-level defect as a short string, or null if there is none.',
  '- severity: "none" | "minor" | "major".',
  '- points_to_section: the downstream section the next round must examine because of your verdict. Allowed values exactly: "Main bound", "Discussion", or null. Never point back at "Setup". If your verdict does not single out a downstream section, use null -- the pipeline then defaults to "Main bound".',
].join("\n");

const round1 = await self(r1Prompt, {
  fork: true,
  label: "Round 1 - Setup",
  schema: {
    type: "object",
    properties: {
      section: { type: "string" },
      verdict: { type: "string" },
      gap: { type: ["string", "null"] },
      severity: { type: "string", enum: ["none", "minor", "major"] },
      points_to_section: { type: ["string", "null"], enum: ["Main bound", "Discussion", null] },
    },
    required: ["section", "verdict", "gap", "severity", "points_to_section"],
    additionalProperties: false,
  },
});

const r1 = round1.structured || {
  section: "Setup",
  verdict: String(round1.response || "").trim(),
  gap: null,
  severity: "none",
  points_to_section: null,
};

const r1Verdict = [
  r1.verdict,
  "(Setup severity: " + r1.severity + ";",
  "gap: " + (r1.gap === null || r1.gap === undefined ? "none" : r1.gap) + ";",
  "next: " + (r1.points_to_section || "Main bound (default)") + ")",
].join(" ");

// Gate: round 2 may not start until the reviewer signs off round 1's verdict.
const signoff = await tools.await_signoff({ verdict: r1Verdict });

const target = r1.points_to_section || "Main bound";
const targetBody =
  target === "Discussion"
    ? "\\section{Discussion}\nThe bound is sharp for constant functions."
    : "\\section{Main bound}\nWe claim $\\sup_K |f| \\le 1$. The proof is omitted.";

const r2Prompt = [
  'Round 2 of a staged review. Round 1 was signed off with this verdict:',
  "",
  '"' + r1Verdict + '"',
  "",
  'Round 1 pointed the review at the "' + target + '" section. Review ONLY that section.',
  "",
  "Full draft, for context only (do not audit the other sections):",
  "",
  DRAFT,
  "",
  "Target section in isolation:",
  "",
  targetBody,
  "",
  "Check the target on its own terms: is the stated claim actually supported, are the hypotheses it relies on present, and is anything asserted without argument? Be concrete about what is missing and what would repair it.",
  "",
  "Return structured output:",
  '- section: "' + target + '"',
  "- verdict: two or three self-contained sentences.",
  "- gaps: a list of specific gaps (empty list if none).",
  '- severity: "none" | "minor" | "major".',
].join("\n");

const round2 = await self(r2Prompt, {
  fork: true,
  label: "Round 2 - " + target,
  schema: {
    type: "object",
    properties: {
      section: { type: "string" },
      verdict: { type: "string" },
      gaps: { type: "array", items: { type: "string" } },
      severity: { type: "string", enum: ["none", "minor", "major"] },
    },
    required: ["section", "verdict", "gaps", "severity"],
    additionalProperties: false,
  },
});

const r2 = round2.structured || {
  section: target,
  verdict: String(round2.response || "").trim(),
  gaps: [],
  severity: "none",
};

return {
  memory_checked: memNote,
  round1_verdict: r1Verdict,
  round1_structured: r1,
  signoff,
  round2_target: target,
  round2_verdict: r2.verdict,
  round2_structured: r2,
};

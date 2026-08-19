---
layout: home
title: TeXRA — Multi-agent AI for theorists
titleTemplate: false
---

<script setup>
import LandingCliStrip from './.vitepress/components/LandingCliStrip.vue';
</script>

<LandingHero />

<section class="trust-row">
  <div class="trust-card">
    <span class="trust-icon" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9 15 2 2 4-4"/></svg>
    </span>
    <h3>Output you can check</h3>
    <p>Citations resolve to real database entries. Figures compile from source. Edits arrive as diffs you read line by line before they touch your files.</p>
  </div>
  <div class="trust-card">
    <span class="trust-icon" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18.5" r="2.5"/><circle cx="19" cy="18.5" r="2.5"/><path d="M12 7.5v3.5M12 11h-7v5M12 11h7v5"/></svg>
    </span>
    <h3>A team of specialist agents</h3>
    <p>An orchestrator splits the task and hands the pieces to researchers, numericists, reviewers, and formalizers — each with its own tools and model.</p>
  </div>
  <div class="trust-card">
    <span class="trust-icon" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>
    </span>
    <h3>Three independent checks</h3>
    <p>Prose reviewed by an LLM, algebra checked in Wolfram, proofs verified in Lean 4 — three layers of verification in one environment.</p>
  </div>
</section>

<section class="architecture-section">
  <h2>One orchestrator, a team of specialists</h2>
  <p class="arch-subtitle">You describe the task. The orchestrator breaks it into sub-tasks, delegates to specialist agents in parallel, and returns proposals you approve before they touch your files.</p>

  <!-- Research Lifecycle -->
  <div class="lifecycle">
    <div class="lifecycle-phase">
      <div class="phase-icon phase-explore">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
      </div>
      <div class="phase-name">Explore</div>
      <div class="phase-agents">search</div>
      <div class="phase-desc">arXiv, Crossref</div>
    </div>
    <div class="lifecycle-arrow">
      <svg width="28" height="16" viewBox="0 0 28 16"><path d="M0 8h24M18 2l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
    </div>
    <div class="lifecycle-phase">
      <div class="phase-icon phase-derive">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>
      </div>
      <div class="phase-name">Derive</div>
      <div class="phase-agents">research &middot; numerics</div>
      <div class="phase-desc">Wolfram, bash</div>
    </div>
    <div class="lifecycle-arrow">
      <svg width="28" height="16" viewBox="0 0 28 16"><path d="M0 8h24M18 2l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
    </div>
    <div class="lifecycle-phase">
      <div class="phase-icon phase-verify">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12l2 2 4-4"/><path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
      </div>
      <div class="phase-name">Verify</div>
      <div class="phase-agents">review &middot; lean</div>
      <div class="phase-desc">Wolfram checks, Lean proofs</div>
    </div>
    <div class="lifecycle-arrow">
      <svg width="28" height="16" viewBox="0 0 28 16"><path d="M0 8h24M18 2l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
    </div>
    <div class="lifecycle-phase">
      <div class="phase-icon phase-write">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
      </div>
      <div class="phase-name">Write</div>
      <div class="phase-agents">polish &middot; correct &middot; research</div>
      <div class="phase-desc">LaTeX, figures, diffs</div>
    </div>
    <div class="lifecycle-arrow">
      <svg width="28" height="16" viewBox="0 0 28 16"><path d="M0 8h24M18 2l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
    </div>
    <div class="lifecycle-phase">
      <div class="phase-icon phase-present">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><path d="M8 21h8M12 17v4"/></svg>
      </div>
      <div class="phase-name">Present</div>
      <div class="phase-agents">paper2slide</div>
      <div class="phase-desc">Beamer, poster</div>
    </div>
  </div>

  <!-- Feedback arrow -->
  <div class="feedback-loop">
    <svg width="100%" height="32" viewBox="0 0 600 32" preserveAspectRatio="xMidYMid meet">
      <defs><marker id="arrowL" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><path d="M8 0L0 3 8 6" fill="var(--vp-c-danger-1)"/></marker></defs>
      <path d="M390 4C390 22 210 22 210 4" fill="none" stroke="var(--vp-c-danger-1)" stroke-width="1.5" stroke-dasharray="5 3" marker-start="url(#arrowL)"/>
      <text x="300" y="28" text-anchor="middle" fill="var(--vp-c-danger-1)" font-size="10" font-weight="500">fix errors</text>
    </svg>
  </div>

  <!-- Two paradigms -->
  <div class="paradigms">
    <div class="paradigm paradigm-workflow">
      <div class="paradigm-label">Workflow Agents</div>
      <div class="paradigm-flow">
        <span class="pf-node">Read project</span>
        <span class="pf-edge">&rarr;</span>
        <span class="pf-node">Plan</span>
        <span class="pf-edge">&rarr;</span>
        <span class="pf-node">Draft</span>
      </div>
      <div class="paradigm-flow">
        <span class="pf-node pf-reflect">Reflect</span>
        <span class="pf-edge">&rarr;</span>
        <span class="pf-node">Output</span>
      </div>
      <div class="paradigm-io">.tex in &rarr; improved .tex + latexdiff</div>
    </div>
    <div class="paradigm-orchestrator">
      <div class="orch-icon">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6M23 11h-6"/></svg>
      </div>
      <div class="orch-label">Orchestrator</div>
      <div class="orch-desc">Breaks work into sub-tasks, delegates to specialized agents, coordinates results</div>
    </div>
    <div class="paradigm paradigm-tooluse">
      <div class="paradigm-label">Tool-Use Agents</div>
      <div class="paradigm-flow">
        <span class="pf-node">Your question</span>
        <span class="pf-edge">&rarr;</span>
        <span class="pf-node">Tool calls</span>
        <span class="pf-edge">&rarr;</span>
        <span class="pf-node">Reason</span>
      </div>
      <div class="paradigm-flow">
        <span class="pf-node pf-reflect">Answer</span>
      </div>
      <div class="paradigm-io">Conversational &middot; persistent across sessions</div>
    </div>
  </div>

  <!-- Tools bar -->
  <div class="tools-bar">
    <span class="tool-tag">wolfram</span>
    <span class="tool-tag">lean</span>
    <span class="tool-tag">arxiv</span>
    <span class="tool-tag">bash</span>
    <span class="tool-tag">web</span>
    <span class="tool-tag">zotero</span>
    <span class="tool-tag">read</span>
    <span class="tool-tag">write</span>
    <span class="tool-tag">grep</span>
    <span class="tool-more">25+ built-in tools</span>
  </div>
</section>

<section class="use-cases">
  <h2>How researchers use TeXRA</h2>
  <div class="cases-grid">
    <div class="case-card">
      <span class="case-label">Derive</span>
      <h3>Steady-state entanglement in a driven spin chain</h3>
      <p>The <code>research</code> agent builds the Lindblad superoperator, solves for the steady state in Wolfram, computes the concurrence analytically, and cross-checks with exact diagonalization in Julia at N=8.</p>
    </div>
    <div class="case-card">
      <span class="case-label">Write</span>
      <h3>Finalizing a 40-page paper on spectral graph theory</h3>
      <p>The <code>correct</code> agent unifies notation — <code>\lambda_2</code> vs <code>\mu</code> for the same eigenvalue across sections — fixes label conflicts, and outputs a diff you review line by line.</p>
    </div>
    <div class="case-card">
      <span class="case-label">Verify</span>
      <h3>Formalizing subadditivity of entropy in Lean 4</h3>
      <p>The <code>lean</code> agent searches Loogle for the right Mathlib lemma, reads the proof state, adds a missing hypothesis, and produces a proof that compiles with zero errors.</p>
    </div>
  </div>
</section>

<section class="bottom-cta">
  <h2>Start in under two minutes</h2>
  <p>Install from the VS Code Marketplace, add your own API key or connect a provider subscription, and run your first agent.</p>
  <div class="cta-buttons">
    <a href="/guide/quick-start" class="cta-button cta-primary">Quick Start Guide</a>
    <a href="/guide/built-in-agents" class="cta-button cta-secondary">Browse All Agents</a>
    <a href="/guide/texra-cli" class="cta-button cta-secondary">Use the CLI</a>
  </div>
  <LandingCliStrip />
</section>

<section class="faq-section">
  <h2>Common questions</h2>

  <details>
    <summary>What models does it support?</summary>
    <p>OpenAI, Anthropic Claude, Google Gemini, DeepSeek, xAI Grok, Moonshot Kimi, Qwen, GLM, and more via OpenRouter. Bring your own API key, or use a provider subscription you already pay for (ChatGPT, Grok, Kimi Code, GLM Coding Plan) — each agent on a team can run a different model.</p>
  </details>

  <details>
    <summary>Does it work with Overleaf?</summary>
    <p>Yes — via git sync. See the <a href="/guide/working-with-overleaf">Overleaf guide</a>.</p>
  </details>

  <details>
    <summary>Does it work with Lean 4?</summary>
    <p>Yes — Loogle search, proof state inspection, diagnostics, build and cache management. Requires the Lean 4 extension.</p>
  </details>

  <details>
    <summary>Can I use it without VS Code?</summary>
    <p>Yes — the <code>@texra-ai/cli</code> terminal client runs the same agents and sign-in on your <code>.tex</code> projects, for scripts, CI, and remote machines. See the <a href="/guide/texra-cli">CLI guide</a>.</p>
  </details>

  <details>
    <summary>Is my data private?</summary>
    <p>Yes — model calls go directly from your machine to the provider, whether you use your own API key or a provider subscription. TeXRA does not sit between you and the model.</p>
  </details>

  <details>
    <summary>Can I build custom agents?</summary>
    <p>Yes — agents are YAML files you can modify or create from scratch. See <a href="/guide/custom-agents">Custom Agents</a>.</p>
  </details>

  <details>
    <summary>Where do I get help?</summary>
    <p>Email <a href="mailto:contact@texra.ai">contact@texra.ai</a> or open an issue on <a href="https://github.com/texra-ai/texra-issues">GitHub</a>.</p>
  </details>
</section>

<style>
/* ============================================
   GLOBAL SECTION SPACING & DIVIDERS
   ============================================ */
section {
  padding: 1.5rem 1.5rem;
  max-width: 1100px;
  margin: 0 auto;
}
/* Kill VitePress home content wrapper spacing */
.VPHome .VPHomeContent,
.vp-doc {
  padding-bottom: 0 !important;
}

/* ============================================
   TYPOGRAPHY HIERARCHY
   ============================================ */
section h2 {
  text-align: center;
  font-size: 1.75rem;
  font-weight: 700;
  margin-bottom: 1.25rem;
  color: var(--vp-c-text-1);
  border-top: none;
  padding-top: 0;
}
section p {
  font-size: 0.95rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

/* ============================================
   TRUST ROW (replaces frontmatter features)
   ============================================ */
.trust-row {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  margin-top: 1.5rem;
  padding-top: 1.75rem;
  border-top: 1px solid var(--vp-c-divider);
}
.trust-card {
  padding: 0 1.75rem;
  border-left: 1px solid var(--vp-c-divider);
}
.trust-card:first-child {
  padding-left: 0;
  border-left: none;
}
.trust-card:last-child {
  padding-right: 0;
}
.trust-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: 9px;
  margin-bottom: 0.8rem;
  background: color-mix(in srgb, var(--vp-c-brand) 11%, transparent);
  color: var(--vp-c-brand);
}
.trust-card h3 {
  margin: 0 0 0.4rem;
  font-size: 1.02rem;
  color: var(--vp-c-text-1);
}
.trust-card p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.55;
}

/* ============================================
   ARCHITECTURE SCHEMATIC
   ============================================ */
.arch-subtitle {
  text-align: center;
  max-width: 640px;
  margin: -0.5rem auto 1.5rem;
  font-size: 0.95rem;
  color: var(--vp-c-text-2);
}

/* Research lifecycle */
.lifecycle {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 0;
  margin: 0 auto 0.25rem;
  max-width: 800px;
}
.lifecycle-phase {
  text-align: center;
  min-width: 90px;
  flex: 1 1 0;
}
.phase-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 12px;
  margin-bottom: 0.4rem;
}
.phase-explore { background: #e8f4fd; color: #2b7ab8; }
.phase-derive  { background: #fff3e0; color: #c17a1a; }
.phase-verify  { background: #e8f5e9; color: #2e7d32; }
.phase-write   { background: #ede7f6; color: #5e35b1; }
.phase-present { background: #fce4ec; color: #c62828; }
:root.dark .phase-explore { background: #1a3a4d; color: #6db8e3; }
:root.dark .phase-derive  { background: #3d2e10; color: #e4a84a; }
:root.dark .phase-verify  { background: #1a3d1e; color: #66bb6a; }
:root.dark .phase-write   { background: #2a1f4e; color: #b39ddb; }
:root.dark .phase-present { background: #3d1a1f; color: #ef9a9a; }
.phase-name {
  font-weight: 700;
  font-size: 0.88rem;
  color: var(--vp-c-text-1);
  margin-bottom: 0.15rem;
}
.phase-agents {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  color: var(--vp-c-brand);
  margin-bottom: 0.1rem;
}
.phase-desc {
  font-size: 0.7rem;
  color: var(--vp-c-text-3);
}
.lifecycle-arrow {
  display: flex;
  align-items: center;
  padding-top: 0.85rem;
  color: var(--vp-c-text-3);
  flex-shrink: 0;
}

/* Feedback loop */
.feedback-loop {
  max-width: 600px;
  margin: 0 auto 1.5rem;
  text-align: center;
  overflow: visible;
}

/* Two paradigms */
.paradigms {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 1.25rem;
  margin-bottom: 1.5rem;
  align-items: start;
}
.paradigm {
  border-radius: 12px;
  padding: 1.25rem;
  text-align: center;
}
.paradigm-workflow {
  background: #e8f4fd;
  border: 1px solid #b8d8f0;
}
.paradigm-tooluse {
  background: #fff3e0;
  border: 1px solid #f0d8a8;
}
:root.dark .paradigm-workflow {
  background: #1a2d3d;
  border-color: #2a4a60;
}
:root.dark .paradigm-tooluse {
  background: #2d2510;
  border-color: #4a3d20;
}
.paradigm-label {
  font-weight: 700;
  font-size: 0.88rem;
  margin-bottom: 0.75rem;
  color: var(--vp-c-text-1);
}
.paradigm-flow {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  margin-bottom: 0.4rem;
  flex-wrap: wrap;
}
.pf-node {
  display: inline-block;
  background: var(--vp-c-bg);
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 0.2em 0.5em;
  font-size: 0.82rem;
  color: var(--vp-c-text-1);
}
.pf-reflect {
  border-color: var(--vp-c-brand);
  color: var(--vp-c-brand);
}
.pf-edge {
  color: var(--vp-c-text-3);
  font-size: 0.8rem;
}
.paradigm-io {
  font-size: 0.78rem;
  color: var(--vp-c-text-3);
  margin-top: 0.5rem;
}

/* Orchestrator */
.paradigm-orchestrator {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding-top: 0.5rem;
}
.orch-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.75rem;
  height: 2.75rem;
  border-radius: 50%;
  background: color-mix(in srgb, var(--vp-c-brand) 12%, transparent);
  color: var(--vp-c-brand);
  margin-bottom: 0.5rem;
}
.orch-label {
  font-weight: 700;
  font-size: 0.85rem;
  color: var(--vp-c-text-1);
  margin-bottom: 0.25rem;
}
.orch-desc {
  font-size: 0.78rem;
  color: var(--vp-c-text-3);
  text-align: center;
  max-width: 140px;
  line-height: 1.4;
}

/* Tools bar */
.tools-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.tool-tag {
  font-family: var(--vp-font-family-mono);
  font-size: 0.78rem;
  color: var(--vp-c-text-2);
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 4px;
  padding: 0.15em 0.5em;
}
.tool-more {
  font-size: 0.78rem;
  color: var(--vp-c-text-3);
  font-style: italic;
}

/* ============================================
   USE CASES
   ============================================ */
.cases-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.5rem;
}
.case-card {
  background: var(--vp-c-bg-soft);
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 1.5rem;
  transition: border-color 0.2s, transform 0.2s;
}
.case-card:hover {
  border-color: var(--vp-c-brand);
  transform: translateY(-2px);
}
.case-label {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--vp-c-brand);
  background: color-mix(in srgb, var(--vp-c-brand) 10%, transparent);
  padding: 0.2em 0.6em;
  border-radius: 4px;
  margin-bottom: 0.75rem;
}
.case-card h3 {
  margin: 0 0 0.5rem;
  font-size: 0.95rem;
  line-height: 1.4;
  color: var(--vp-c-text-1);
}
.case-card p {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.55;
}
.case-card code {
  color: var(--vp-c-brand);
  background: color-mix(in srgb, var(--vp-c-brand) 8%, transparent);
  padding: 0.1em 0.35em;
  border-radius: 3px;
  font-size: 0.85em;
}

/* ============================================
   BOTTOM CTA
   ============================================ */
.bottom-cta {
  text-align: center;
}
.bottom-cta h2 {
  margin-bottom: 0.5rem;
}
.bottom-cta > p {
  margin-bottom: 2rem;
  font-size: 0.95rem;
  color: var(--vp-c-text-2);
}
.cta-buttons {
  display: flex;
  gap: 1rem;
  justify-content: center;
  flex-wrap: wrap;
}
.cta-button {
  display: inline-block;
  padding: 0.75rem 1.75rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.9rem;
  text-decoration: none;
  transition: background-color 0.2s, transform 0.15s;
}
.cta-button:hover {
  transform: translateY(-1px);
}
.cta-primary {
  background: var(--vp-c-brand);
  color: #ffffff !important;
}
.cta-primary:hover {
  background: var(--vp-c-brand-dark);
  color: #ffffff !important;
}
.cta-secondary {
  background: var(--vp-c-bg);
  color: var(--vp-c-brand);
  border: 1px solid var(--vp-c-brand);
}
.cta-secondary:hover {
  background: color-mix(in srgb, var(--vp-c-brand) 8%, transparent);
}

/* ============================================
   FAQ ACCORDION
   ============================================ */
.faq-section {
  max-width: 700px;
  margin-left: auto;
  margin-right: auto;
}
.faq-section details {
  border-bottom: 1px solid var(--vp-c-divider);
}
.faq-section details:first-of-type {
  border-top: 1px solid var(--vp-c-divider);
}
.faq-section summary {
  padding: 1rem 0;
  font-weight: 600;
  font-size: 0.95rem;
  cursor: pointer;
  list-style: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: var(--vp-c-text-1);
}
.faq-section summary::-webkit-details-marker {
  display: none;
}
.faq-section summary::after {
  content: '+';
  font-size: 1.25rem;
  font-weight: 300;
  color: var(--vp-c-text-3);
  transition: transform 0.2s;
}
.faq-section details[open] summary::after {
  content: '\2212';
}
.faq-section details p {
  margin: 0 0 1rem;
  font-size: 0.92rem;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}
.faq-section details p a {
  color: var(--vp-c-brand);
}

/* ============================================
   RESPONSIVE BREAKPOINTS
   ============================================ */

/* Tablet */
@media (max-width: 768px) {
  section {
    padding: 1.25rem 1.25rem;
  }
  .trust-row {
    grid-template-columns: 1fr;
  }
  .trust-card {
    padding: 1.25rem 0;
    border-left: none;
    border-top: 1px solid var(--vp-c-divider);
  }
  .trust-card:first-child {
    padding-top: 0;
    border-top: none;
  }
  .trust-card:last-child {
    padding-bottom: 0;
  }
  .lifecycle {
    flex-wrap: wrap;
    gap: 0.75rem;
    justify-content: center;
  }
  .lifecycle-arrow {
    display: none;
  }
  .lifecycle-phase {
    min-width: 80px;
    flex: 0 0 calc(33% - 0.75rem);
  }
  .feedback-loop {
    display: none;
  }
  .paradigms {
    grid-template-columns: 1fr;
    gap: 1rem;
  }
  .paradigm-orchestrator {
    order: -1;
    flex-direction: row;
    gap: 0.75rem;
    padding-top: 0;
  }
  .orch-desc {
    max-width: none;
    text-align: left;
  }
  .cases-grid {
    grid-template-columns: 1fr;
  }
}

/* Mobile */
@media (max-width: 480px) {
  section {
    padding: 1rem;
  }
  section h2 {
    font-size: 1.4rem;
  }
  .lifecycle-phase {
    flex: 0 0 calc(33% - 0.75rem);
    min-width: 70px;
  }
  .phase-icon {
    width: 2.25rem;
    height: 2.25rem;
  }
  .phase-icon svg {
    width: 16px;
    height: 16px;
  }
  .phase-name {
    font-size: 0.8rem;
  }
  .paradigms {
    gap: 0.75rem;
  }
  .paradigm {
    padding: 1rem;
  }
}
</style>

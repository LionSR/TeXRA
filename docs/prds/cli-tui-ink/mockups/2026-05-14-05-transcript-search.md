---
created: 2026-05-14
updated: 2026-05-15
---

# 05 · Transcript search overlay

User pressed `Ctrl-F`. A slim search bar appears at the top of the conversation pane. Matches in the visible transcript are inverse-highlighted; the current match is rendered in yellow inverse. Match count and navigation hints sit on the right.

```
╭─ TeXRA ── agent: chat  ·  model: claude-opus-4-7  ─── 8 turns · $0.13 · 09:14 ────╮
│ ⌕ fatou_                                                       3 / 7  · n next · esc │  ← search input + match counter
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  ◇ chat                                                                            │
│    The proof leans on **▓▓▓▓▓** ▓▓▓▓▓'s lemma applied twice, once on $X_n$           │  ← `Fatou` (current match) in
│    and once on $-X_n$. The boundedness condition was sufficient there but            │     yellow inverse; other matches
│    will not work for the new version of the lemma.                                   │     in plain inverse
│                                                                                      │
│  ◆ you                                                                               │
│    Can you tighten that — pull the bounded integrand observation up front and        │
│    use DCT directly instead of two ▒▒▒▒▒ ▒▒▒▒▒ invocations?                          │
│                                                                                      │
│  ◇ chat                                                                            │
│    Yes. Let me show you the proposed rewrite.                                        │
│                                                                                      │
│    ╭─ Edit · sec_3.2.tex ──── ✓ +14 / −9 · 3 hunks ──── [ctrl-o expand] ──╮          │
│    │ @@ -41,7 +41,8 @@                                                    │          │
│    │  \begin{lemma}\label{lem:▒▒▒▒▒}                                      │          │  ← match inside collapsed
│    │ ...                                                                   │          │     tool card still highlights
│    ╰───────────────────────────────────────────────────────────────────────╯          │
│                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  ● idle · queued: 0 · yolo off · search: 7 matches across 4 turns                    │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ›                                                                                    │  ← input bar is disabled while
╰─── n next · N prev · ctrl-f new query · esc close · enter jump to current ───────────╯     overlay is open
```

## Glyph note

`▓` (current match, yellow inverse) and `▒` (other match, plain inverse) stand in for the actual ANSI inverse-video applied to the matched cells. The text underneath is unchanged; the inverse is purely a render-time overlay.

## Layout notes

- **Search bar** `⌕ query` sits at the top of the conversation pane, replacing the first line of the live region until the overlay closes.
- **Match counter** `3 / 7` is right-aligned in the same row.
- **Navigation hints** in the same row: `n next · esc` (short form). The full key list lives in the footer.
- **Matches inside collapsed tool cards** highlight too — the cell-overlay walks all rendered cells, not just expanded sections.
- **Status bar** swaps `cwd` for the cross-turn match summary so the user sees "where am I in the haystack".
- **Input bar** dims and accepts no input while the overlay is open. `enter` jumps to the current match's turn in scrollback (terminal `printf '\033[…H'` cursor-restore is **not** used — we just guarantee the current match is on screen).

## Search semantics

- Tries case-insensitive substring first; if no hits, retries with fuzzy-subsequence via `fzf-for-js`.
- Wide characters (CJK, emoji) and composed graphemes (`é` as 2 codepoints) are handled by `string-width` cell mapping — overlays apply to the right cell range.
- Overlapping substring matches advance by `pos + queryLength`, never `pos + 1`. (See [§ Transcript search](../2026-05-14-10-architecture.md#transcript-search) for the rationale.)

## Open questions for review

1. Should `Ctrl-F` open as a _modal_ (blocks conversation pane) or as the _slim header bar_ shown here (conversation stays visible)? The slim bar is less disruptive but eats one line from the live region.
2. Should there be an option to search only the user's turns, or only assistant turns? `~` or `:user` prefix in the query?
3. When the current match is in a collapsed tool card, should the card auto-expand to show context, or stay collapsed (user can `Ctrl-O` after jumping)?
4. Should the search persist across input — i.e., after `esc`, can the user re-open the same query with `Ctrl-F` again?

   User: this can wait.

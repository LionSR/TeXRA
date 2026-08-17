// Suites for loose src/shared/schemas helpers (work plan, agent CLI
// settings, main-view housekeeping messages, web URL sanitization,
// settings-view tab invariants).

import { describe, expect, it } from 'vitest';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  SETTINGS_TAB,
  SETTINGS_TAB_GROUPS,
  SETTINGS_TAB_ORDER,
  SETTINGS_TAB_PANEL_NAMES,
  WebFetchPayloadSchema,
  WebSearchPayloadSchema,
  planSummaryLine,
  parseClaudeAgentModel,
  parseCodexApprovalPolicy,
  MainViewInboundMessageSchema,
} from '@shared/schemas';

describe('work plan schema helpers', () => {
  it('returns a stable placeholder for whitespace-only objectives', () => {
    expect(planSummaryLine(' \n\t')).toBe('(empty plan)');
  });
});

describe('parseCodexApprovalPolicy', () => {
  it.each(['never', 'on-request', 'on-failure', 'untrusted'])(
    'accepts the SDK approval policy %s',
    (policy) => {
      expect(parseCodexApprovalPolicy(policy)).toBe(policy);
    },
  );

  it('defaults to automatic approval for invalid persisted values', () => {
    expect(parseCodexApprovalPolicy('ask')).toBe('never');
  });
});

describe('parseClaudeAgentModel', () => {
  it('defaults invalid persisted selections to Sonnet', () => {
    expect(parseClaudeAgentModel('claude-opus-3')).toBe('claude-sonnet-5');
  });
});

describe('MainView housekeeping messages', () => {
  it('uses inputFiles for Pack/Clean multiple payloads', () => {
    const parsed = MainViewInboundMessageSchema.parse({
      command: MAIN_VIEW_COMMANDS.PACK_MULTIPLE,
      inputFile: 'main.tex',
      inputFiles: ['chapter.tex'],
      agent: 'correct',
      model: 'gpt-5.4',
    });

    expect('inputFiles' in parsed ? parsed.inputFiles : undefined).toEqual([
      'chapter.tex',
    ]);
  });
});

/**
 * Regression coverage for issue #7230: `web_search`/`web_fetch` `url` fields
 * are LLM/tool-controlled and must never carry a dangerous scheme through to
 * a rendered `<a href>` in the live webview or the exported HTML. Sanitization
 * lives in the shared schemas (`WebSearchPayloadItemSchema` /
 * `WebFetchPayloadSchema`) so both render paths are protected by one fix.
 * Only `http:`/`https:`/`mailto:` and anchor-only (`#foo`) URLs survive;
 * empty, protocol-relative, root-relative, and dangerous schemes collapse to
 * `undefined`.
 */

function parseSearchUrl(url: string): string | undefined {
  return WebSearchPayloadSchema.parse({
    results: [{ url, title: 'result' }],
  }).results?.[0]?.url;
}

function parseFetchUrl(url: string): string | undefined {
  return WebFetchPayloadSchema.parse({ url }).url;
}

describe('web tool URL sanitization (issue #7230)', () => {
  describe('dangerous schemes are stripped', () => {
    const dangerous = [
      'javascript:alert(1)',
      'javascript:alert(document.cookie)',
      'JavaScript:alert(1)', // scheme match must not be case-sensitive-bypassable
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '  javascript:alert(1)', // leading whitespace shouldn't bypass the scheme check
      'javascript:alert(1)  ', // trailing whitespace likewise
    ];

    it.each(dangerous)('strips %s from web_search and web_fetch', (url) => {
      expect(parseSearchUrl(url)).toBeUndefined();
      expect(parseFetchUrl(url)).toBeUndefined();
    });
  });

  it('strips protocol-relative URLs (no scheme to validate against)', () => {
    expect(parseSearchUrl('//evil.example.com/path')).toBeUndefined();
    expect(parseFetchUrl('//evil.example.com/path')).toBeUndefined();
  });

  it('strips the empty string', () => {
    expect(parseSearchUrl('')).toBeUndefined();
    expect(parseFetchUrl('')).toBeUndefined();
  });

  it('strips whitespace-only URLs', () => {
    expect(parseSearchUrl('   ')).toBeUndefined();
  });

  describe('legitimate URLs still render', () => {
    const safe = [
      'http://example.com',
      'https://example.com/path?query=1#frag',
      'mailto:someone@example.com',
      'https://sub.example.co.uk:8443/a/b?c=d&e=f',
      '  https://example.com/padded  ', // whitespace-padded but otherwise safe
    ];

    it.each(safe)(
      'keeps %s as a live href for web_search and web_fetch',
      (url) => {
        expect(parseSearchUrl(url)).toBe(url.trim());
        expect(parseFetchUrl(url)).toBe(url.trim());
      },
    );
  });

  it('keeps anchor-only fragments as-is', () => {
    expect(parseSearchUrl('#section-2')).toBe('#section-2');
  });

  describe('root-relative paths are rejected (issue #7230 follow-up)', () => {
    // A standalone HTML export opens via `file://` with no origin, so a
    // root-relative URL resolves against the filesystem root rather than a
    // web origin — a tool-controlled `/etc/passwd` must not become a live
    // link to a local file.
    const rootRelative = [
      '/etc/passwd',
      '/Users/alice/.ssh/id_rsa',
      '/local/path',
    ];

    it.each(rootRelative)('strips %s from web_search and web_fetch', (url) => {
      expect(parseSearchUrl(url)).toBeUndefined();
      expect(parseFetchUrl(url)).toBeUndefined();
    });
  });

  it('sanitizes each item independently in a mixed results list', () => {
    const parsed = WebSearchPayloadSchema.parse({
      results: [
        { url: 'javascript:alert(1)', title: 'evil' },
        { url: 'https://example.com', title: 'safe' },
      ],
    });

    expect(parsed.results?.[0]?.url).toBeUndefined();
    expect(parsed.results?.[1]?.url).toBe('https://example.com');
  });

  it('leaves a missing url as undefined without throwing', () => {
    expect(WebSearchPayloadSchema.parse({}).results).toBeUndefined();
    expect(WebFetchPayloadSchema.parse({}).url).toBeUndefined();
  });
});

describe('settings view tab definitions', () => {
  it('keeps panel names unique', () => {
    expect(new Set(SETTINGS_TAB_PANEL_NAMES).size).toBe(
      SETTINGS_TAB_PANEL_NAMES.length,
    );
  });

  // `SETTINGS_TAB.X` indices cross the IPC boundary as `SET_TAB.tabIndex`, so
  // the mapping is pinned literally. A retired internal panel must disappear
  // from this contract together with every producer and handler.
  it('pins the settings tab wire contract (index + panel name)', () => {
    expect(SETTINGS_TAB).toEqual({
      MEMORY: 0,
      MODELS: 1,
      AGENTS: 2,
      MULTI_AGENT: 3,
      TOOLS: 4,
      AI_AGENTS: 5,
      GIT: 6,
      LATEX: 7,
      GOAL: 8,
      ACCOUNT: 9,
      SHORTCUTS: 10,
      SUBSCRIPTIONS: 11,
    });
    expect(SETTINGS_TAB_PANEL_NAMES).toEqual([
      'memory',
      'models',
      'agents',
      'multi-agent',
      'tools',
      'ai-agents',
      'git',
      'latex',
      'goal',
      'account',
      'shortcuts',
      'subscriptions',
    ]);
  });

  // A group that silently omits a tab makes that panel unreachable from the
  // nav while it stays a valid IPC target; a tab listed twice renders two rows
  // for one panel.
  it('places every tab in exactly one nav group', () => {
    const grouped = SETTINGS_TAB_GROUPS.flatMap((group) => group.tabs);

    expect(new Set(grouped).size).toBe(grouped.length);
    expect([...grouped].sort()).toEqual([...SETTINGS_TAB_ORDER].sort());
  });

  it('keeps group labels unique and non-empty', () => {
    const labels = SETTINGS_TAB_GROUPS.map((group) => group.label);

    expect(labels.every((label) => label.trim().length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

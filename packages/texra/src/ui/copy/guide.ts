/**
 * Links into the TeXRA guide on texra.ai, the one place every host and
 * renderer builds them. The site is VitePress without clean URLs, so a page
 * is its `.html` file.
 */

/** The guide page `page` (a file name under `docs/guide/` without `.md`),
 *  at its section `anchor` when one is named. */
export function texraGuideUrl(page: string, anchor?: string): string {
  const url = `https://texra.ai/guide/${page}.html`;
  return anchor === undefined ? url : `${url}#${anchor}`;
}

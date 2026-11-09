/**
 * Links into the TeXRA guide on texra.ai, the one place every host and
 * renderer builds them. The site is VitePress without clean URLs, so a page
 * is its `.html` file.
 */

/** The TeXRA site's home page. */
export const TEXRA_SITE_URL = 'https://texra.ai';

/** The guide page `page` (a file name under `docs/guide/` without `.md`),
 *  at its section `anchor` when one is named. */
export function texraGuideUrl(page: string, anchor?: string): string {
  const url = `${TEXRA_SITE_URL}/guide/${page}.html`;
  return anchor === undefined ? url : `${url}#${anchor}`;
}

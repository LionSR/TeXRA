// Third-party imports
import DBLP, { DblpCoauthorsResult, DblpPublicationsResult } from 'dblp-json';
import { z } from 'zod';

// Local imports - tools
import { defineTool } from '../core/define';
import { ToolError, toolResult } from '../result';
import { formatToolOutput } from '../utils';

const DblpSearchInputSchema = z.strictObject({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  pid: z.string().optional(),
  homepage: z.string().optional(),
  includePublications: z.boolean().optional(),
  maxPublications: z.number().int().min(1).max(50).optional(),
});

export type DblpSearchInput = z.infer<typeof DblpSearchInputSchema>;

const ensureQuery = (input: DblpSearchInput) => {
  if (input.pid || input.homepage) {
    return;
  }

  if (!input.firstName || !input.lastName) {
    throw new ToolError(
      'Provide either pid, homepage, or both firstName and lastName to query DBLP.',
    );
  }
};

const formatPublications = (
  publications: DblpPublicationsResult,
  maxItems: number,
): string => {
  const items = publications.pubs.slice(0, maxItems);
  if (items.length === 0) {
    return 'No publications found.';
  }

  return items
    .map((publication, index) => {
      const title =
        typeof publication.title === 'string'
          ? publication.title
          : 'Untitled work';
      const year =
        typeof publication.year === 'string' ? publication.year : undefined;
      const doi =
        typeof publication.doi === 'string' ? publication.doi : undefined;
      const ee = publication.ee;
      const entryLines = [
        `**Title:** ${title}`,
        year ? `**Year:** ${year}` : undefined,
        doi ? `**DOI:** ${doi}` : undefined,
        typeof ee === 'string' ? `**Link:** ${ee}` : undefined,
      ].filter((line): line is string => Boolean(line));

      return formatToolOutput(`${index + 1}. ${title}`, entryLines.join('\n'));
    })
    .join('\n\n');
};

const formatCoauthors = (coauthors: DblpCoauthorsResult): string => {
  const list = Array.isArray(coauthors.coauthors) ? coauthors.coauthors : [];
  if (list.length === 0) {
    return 'No coauthors were listed for this person.';
  }

  return list
    .map((entry, index) => {
      const name = typeof entry.name === 'string' ? entry.name : 'Unknown';
      const pid = typeof entry.pid === 'string' ? entry.pid : undefined;
      const count = typeof entry.count === 'string' ? entry.count : undefined;
      const url = typeof entry.url === 'string' ? entry.url : undefined;

      const lines = [
        `**Name:** ${name}`,
        pid ? `**PID:** ${pid}` : undefined,
        count ? `**Joint publications:** ${count}` : undefined,
        url ? `**Profile:** ${url}` : undefined,
      ].filter((line): line is string => Boolean(line));

      return formatToolOutput(`${index + 1}. ${name}`, lines.join('\n'));
    })
    .join('\n\n');
};

export class DblpSearchTool extends defineTool({
  name: 'search_dblp',
  description:
    'Retrieve DBLP author information along with selected publications and coauthors.',
  schema: DblpSearchInputSchema,
}) {
  protected async execute(input: DblpSearchInput) {
    ensureQuery(input);

    const client = new DBLP();

    let person;
    try {
      if (input.pid) {
        person = await client.getByPID(input.pid.trim());
      } else if (input.homepage) {
        person = await client.getByHomepage(input.homepage.trim());
      } else {
        person = await client.getByName(
          input.firstName!.trim(),
          input.lastName!.trim(),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolError(`Failed to query DBLP: ${message}`);
    }

    const personInfo = person.getPerson();
    const publications = person.getPublications();
    const coauthors = person.getCoauthors();

    const profileLines = [
      personInfo.name ? `**Name:** ${personInfo.name}` : undefined,
      personInfo.pid ? `**PID:** ${personInfo.pid}` : undefined,
      typeof personInfo.url === 'string'
        ? `**Profile:** ${personInfo.url}`
        : undefined,
      typeof personInfo.homepage === 'string'
        ? `**Homepage:** ${personInfo.homepage}`
        : undefined,
      personInfo['n-publications']
        ? `**Publications indexed:** ${personInfo['n-publications']}`
        : undefined,
    ].filter((line): line is string => Boolean(line));

    const maxPublications = input.maxPublications ?? 10;
    const includePublications = input.includePublications ?? true;

    const sections = [
      formatToolOutput('Author summary', profileLines.join('\n')),
    ];

    if (includePublications) {
      sections.push(
        formatToolOutput(
          'Selected publications',
          formatPublications(publications, maxPublications),
        ),
      );
    }

    sections.push(formatToolOutput('Coauthors', formatCoauthors(coauthors)));

    const summaryName = personInfo.name ?? 'Unknown DBLP author';
    const summary = `Retrieved DBLP profile for ${summaryName}.`;

    return toolResult({
      summary,
      output: sections.join('\n\n'),
    });
  }
}

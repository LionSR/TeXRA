const fs = require('node:fs');
const path = require('node:path');

async function collectTexraThreads({ github, context, core }) {
  const outputPath =
    process.env.TEXRA_THREADS_OUTPUT ||
    '.texra-action/previous-texra-review-threads.json';
  const marker = process.env.TEXRA_REVIEW_MARKER || '<!-- texra-review -->';
  const emptyPayload = {
    marker,
    threads: [],
    note: 'No previous TeXRA review threads were found.',
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const query = `
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          reviewThreads(first: 100) {
            pageInfo {
              hasNextPage
            }
            nodes {
              id
              isResolved
              comments(first: 20) {
                pageInfo {
                  hasNextPage
                }
                nodes {
                  id
                  body
                  author {
                    login
                  }
                  createdAt
                  url
                  path
                  line
                  diffHunk
                }
              }
            }
          }
        }
      }
    }
  `;

  let data;
  try {
    data = await github.graphql(query, {
      owner: context.repo.owner,
      repo: context.repo.repo,
      number: context.payload.pull_request.number,
    });
  } catch (error) {
    core.warning(
      `Could not read previous TeXRA review threads: ${error.message}`,
    );
    fs.writeFileSync(outputPath, `${JSON.stringify(emptyPayload, null, 2)}\n`);
    core.setOutput('path', outputPath);
    return emptyPayload;
  }

  const reviewThreads = data.repository?.pullRequest?.reviewThreads;
  if (!reviewThreads) {
    core.warning('Previous TeXRA review thread data was unavailable.');
    fs.writeFileSync(outputPath, `${JSON.stringify(emptyPayload, null, 2)}\n`);
    core.setOutput('path', outputPath);
    return emptyPayload;
  }
  if (reviewThreads.pageInfo.hasNextPage) {
    core.warning('Only the first 100 previous TeXRA review threads were read.');
  }
  for (const thread of reviewThreads.nodes) {
    if (thread.comments.pageInfo.hasNextPage) {
      core.warning(
        `Only the first 20 comments were read for TeXRA review thread ${thread.id}.`,
      );
    }
  }

  const threads = reviewThreads.nodes
    .filter((thread) =>
      thread.comments.nodes.some((comment) =>
        String(comment.body || '').includes(marker),
      ),
    )
    .map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      comments: thread.comments.nodes.map((comment) => ({
        id: comment.id,
        author: comment.author?.login ?? null,
        createdAt: comment.createdAt,
        url: comment.url,
        path: comment.path,
        line: comment.line,
        diffHunk: comment.diffHunk,
        body: String(comment.body || '')
          .replaceAll(marker, '')
          .trim(),
      })),
    }));

  const payload = { marker, threads };
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`);
  core.setOutput('path', outputPath);
  return payload;
}

module.exports = { collectTexraThreads };

import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const directory = process.env.MERGE_TEST_DIRECTORY;

if (!directory) {
  throw new Error('Missing merge test directory.');
}

const scenario: unknown = JSON.parse(readFileSync(join(directory, 'scenario.json'), 'utf8'));

if (typeof scenario !== 'object' || scenario === null) {
  throw new Error('Invalid merge test scenario.');
}

const repository = {
  clone_url: 'https://github.com/example/project.git',
  full_name: 'example/project',
};

// The toolkit talks only to this local server, including its bundled HTTP client.
const server = createServer((request, response) => {
  response.setHeader('connection', 'close');
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const pathname = url.pathname;
  const send = (body: unknown, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  if (pathname.endsWith('/pulls/42')) {
    send({
      number: 42,
      html_url: 'https://github.com/example/project/pull/42',
      state: 'open',
      mergeable: true,
      base: { ref: 'main', repo: repository },
      head: { ref: 'release/next', sha: 'head-sha', repo: repository },
    });
  } else if (pathname.includes('/check-runs')) {
    const conclusion = 'conclusion' in scenario ? scenario.conclusion : 'success';
    send({
      check_runs:
        'missingChecks' in scenario && scenario.missingChecks
          ? []
          : [
              {
                name: 'test',
                status: conclusion === null ? 'in_progress' : 'completed',
                conclusion,
              },
            ],
    });
  } else if (pathname.endsWith('/status')) {
    if ('laterStatus' in scenario) {
      const statuses =
        url.searchParams.get('page') === '2'
          ? [{ context: 'security', state: scenario.laterStatus, target_url: null }]
          : [
              { context: 'release-blocker', state: 'failure', target_url: null },
              ...Array.from({ length: 99 }, (_, index) => ({
                context: `ci-${index}`,
                state: 'success',
                target_url: null,
              })),
            ];
      send({ statuses, total_count: 101, state: 'failure' });

      return;
    }

    send({ statuses: [], total_count: 0, state: 'pending' });
  } else if (pathname.endsWith('/permission')) {
    if ('permissionError' in scenario && scenario.permissionError) {
      send({ message: 'permission lookup failed' }, 403);

      return;
    }

    appendFileSync(join(directory, 'events'), 'permission\n');
    send({ role_name: 'role' in scenario ? scenario.role : 'admin' });
  } else if (pathname.endsWith('/dispatches')) {
    appendFileSync(join(directory, 'events'), 'dispatch\n');
    response.writeHead(204);
    response.end();
  } else {
    send({ message: `Unexpected merge test API request: ${pathname}` }, 500);
  }
});

await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();

if (!address || typeof address === 'string') {
  throw new Error('Expected a local merge test API address.');
}

process.env.GITHUB_API_URL = `http://127.0.0.1:${address.port}`;
server.unref();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CREATE_SYSTEM_PROMPT, UI_SYSTEM_PROMPT, loadConfig } from '../src/config.js';
import { createGameStorage } from '../src/storage.js';

const SOURCE = '<!doctype html>\n<html>\n<head><style>body { margin: 0; }</style></head>\n<body data-game-overlay="x">\n<script>console.log("hi \\"there\\"");</script>\n</body>\n</html>\n';

// Every Improve request must reach the model with the system prompt, the change request, and the full stored source.
describe('POST /api/generate (Improve)', () => {
  const upstreamBodies: any[] = [];
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname.endsWith('/responses')) upstreamBodies.push(await req.json());
      // 4xx is not retried by the SDK, so each Improve produces exactly one upstream request.
      return Response.json({ error: { message: 'mock upstream' } }, { status: 400 });
    },
  });
  let dir: string;
  let server: Bun.Subprocess<'ignore', 'pipe', 'inherit'>;
  let base: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'game-server-'));
    await createGameStorage(join(dir, 'games')).save('poster.html', SOURCE, { prompt: 'a poster', model: 'm', ts: 1, instructions: 'Look at it.' });
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GAME_STORAGE_')));
    server = Bun.spawn(['bun', resolve('src/server.ts')], {
      cwd: dir,
      env: { ...env, PORT: '0', LLM_API_KEY: 'test-key', LLM_BASE_URL: `http://127.0.0.1:${upstream.port}/v1` },
      stdout: 'pipe',
      stderr: 'inherit',
    });
    // PORT=0 picks a free port; the server prints it in its banner.
    const reader = server.stdout.getReader();
    let out = '';
    let port: RegExpMatchArray | null;
    while (!(port = out.match(/localhost:(\d+)/))) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`server exited before listening: ${out}`);
      out += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    base = `http://localhost:${port[1]}`;
  });

  afterAll(async () => {
    server?.kill();
    upstream.stop(true);
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function improve(body: Record<string, unknown>) {
    const res = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'add a toolbar', existingFile: 'poster.html', ...body }),
    });
    return { status: res.status, text: await res.text() };
  }

  test.each([
    ['game', loadConfig({}, { skipApiKey: true }).systemPrompt],
    ['create', CREATE_SYSTEM_PROMPT],
    ['ui', UI_SYSTEM_PROMPT],
  ])('%s mode sends system prompt, change request, and the full source', async (_mode, systemPrompt) => {
    const before = upstreamBodies.length;
    const { status } = await improve({ systemPrompt });
    expect(status).toBe(200);
    expect(upstreamBodies.length).toBe(before + 1);
    const sent = upstreamBodies[before];
    expect(sent.instructions).toBe(systemPrompt);
    expect(sent.input).toContain(SOURCE);
    expect(sent.input).toContain('Change request: add a toolbar');
    expect(sent.input).toContain('do not call read_file');
  });

  test('POST /api/versions/<file>?versionId= makes that version current', async () => {
    const missing = await fetch(`${base}/api/versions/poster.html`, { method: 'POST' });
    expect(missing.status).toBe(400);
    expect(await missing.text()).toContain('versionId is required');
    // Local storage keeps one version per game, so the storage layer refuses; S3 behavior is proved live.
    const local = await fetch(`${base}/api/versions/poster.html?versionId=v-older`, { method: 'POST' });
    expect(local.status).toBe(502);
    expect(await local.text()).toContain('Versioned writes require S3 storage');
  });

  test('reads the requested version, not the latest', async () => {
    const { status, text } = await improve({ existingVersionId: 'v-older' });
    expect(status).toBe(502);
    expect(text).toContain('Versioned reads require S3 storage');
  });
});

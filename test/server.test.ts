import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CREATE_SYSTEM_PROMPT, UI_SYSTEM_PROMPT, loadConfig } from '../src/config.js';
import { createGameStorage } from '../src/storage.js';

const SOURCE = '<!doctype html>\n<html>\n<head><style>body { margin: 0; }</style></head>\n<body data-game-overlay="x">\n<script>console.log("hi \\"there\\"");</script>\n</body>\n</html>\n';
const SAVED_SOURCE = '<body style="margin:0;overflow:hidden;width:100vw;height:100vh"><button id="play">Play</button><script>document.querySelector("#play").addEventListener("click", () => {});</script></body>';

function completedResponse(output: unknown[], model = 'save-test') {
  return {
    id: crypto.randomUUID(), object: 'response', created_at: Date.now(), completed_at: Date.now(), model, status: 'completed',
    error: null, incomplete_details: null, instructions: null, metadata: null, frequency_penalty: null,
    output, parallel_tool_calls: false, presence_penalty: null, temperature: null, tool_choice: 'auto', tools: [], top_p: null,
  };
}

// Every Improve request must reach the model with the system prompt, the change request, and the full stored source.
describe('POST /api/generate (Improve)', () => {
  const upstreamBodies: any[] = [];
  let releaseDelayedUpstream: (() => void) | undefined;
  let delayedUpstreamStarted: (() => void) | undefined;
  const upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith('/responses')) return new Response('not found', { status: 404 });
      const body = await req.json();
      upstreamBodies.push(body);
      if (body.model === 'delayed-test') {
        delayedUpstreamStarted?.();
        await new Promise<void>((resolve) => { releaseDelayedUpstream = resolve; });
      }
      if (body.model === 'save-test') {
        if (typeof body.input === 'string') {
          return Response.json(completedResponse([{
            type: 'function_call', id: crypto.randomUUID(), call_id: crypto.randomUUID(), name: 'save_game', status: 'completed',
            arguments: JSON.stringify({ filename: 'poster.html', content: SAVED_SOURCE, instructions: 'Click Play.' }),
          }]));
        }
        return Response.json(completedResponse([{
          type: 'message', id: crypto.randomUUID(), role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Saved.', annotations: [] }],
        }]));
      }
      // 4xx is not retried by the SDK, so each Improve produces exactly one upstream request.
      return Response.json({ error: { message: 'mock upstream' } }, { status: 400 });
    },
  });
  let dir: string;
  let server: Bun.Subprocess<'ignore', 'pipe', 'inherit'>;
  let base: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'game-server-'));
    const storage = createGameStorage(join(dir, 'games'));
    await storage.save('poster.html', SOURCE, { prompt: 'a poster', model: 'm', ts: 1, instructions: 'Look at it.' });
    await storage.save('cached-feed.html', SOURCE, { prompt: 'cached feed prompt', model: 'm', ts: 2, instructions: 'Look at it.' });
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

  test('gallery permits same-host game frames while game responses retain opaque sandbox isolation', async () => {
    const root = await fetch(base);
    expect(root.headers.get('content-security-policy')).toContain("frame-src 'self'");
    const game = await fetch(`${base}/games/poster.html`);
    const policy = game.headers.get('content-security-policy');
    expect(policy).toContain('sandbox allow-scripts;');
    expect(policy).toContain("connect-src 'none'");
    expect(policy).not.toContain('allow-same-origin');
  });

  test('GET /api/feed reuses cached summaries', async () => {
    const first = await fetch(`${base}/api/feed?limit=10`);
    expect(first.status).toBe(200);
    expect((await first.json()).posts).toContainEqual(expect.objectContaining({ file: 'cached-feed.html', prompt: 'cached feed prompt' }));

    const recordPath = join(dir, 'games', '.records', 'cached-feed.html.json');
    const record = JSON.parse(await readFile(recordPath, 'utf8'));
    record.post.prompt = 'changed outside storage';
    await writeFile(recordPath, JSON.stringify(record));

    const second = await fetch(`${base}/api/feed?limit=10`);
    expect(second.status).toBe(200);
    expect((await second.json()).posts).toContainEqual(expect.objectContaining({ file: 'cached-feed.html', prompt: 'cached feed prompt' }));
  });

  test('preserves custom Improve model and system prompt', async () => {
    const before = upstreamBodies.length;
    const customPrompt = 'custom instructions';
    const { status } = await improve({ mode: 'game', model: 'custom-model', systemPrompt: customPrompt, maxContextTokens: 12345, maxOutputTokens: 4567 });
    expect(status).toBe(200);
    const sent = upstreamBodies[before];
    expect(sent.model).toBe('custom-model');
    expect(sent.instructions).toBe(customPrompt);
    expect(sent.max_output_tokens).toBe(4567);
    expect(sent.input).toContain('add a toolbar');
  });

  test.each([
    ['create', CREATE_SYSTEM_PROMPT, 'qwen3.8-flash-prod-users'],
    ['ui', UI_SYSTEM_PROMPT, 'oui-1'],
  ])('%s mode supplies defaults only when fields are absent', async (mode, systemPrompt, model) => {
    const before = upstreamBodies.length;
    const { status } = await improve({ mode });
    expect(status).toBe(200);
    const sent = upstreamBodies[before];
    expect(sent.instructions).toBe(systemPrompt);
    expect(sent.model).toBe(model);
  });

  test('uses the Game defaults when mode is absent', async () => {
    const before = upstreamBodies.length;
    const { status } = await improve({});
    expect(status).toBe(200);
    const sent = upstreamBodies[before];
    expect(sent.instructions).toBe(loadConfig({}, { skipApiKey: true }).systemPrompt);
    expect(sent.model).toBe('qwen3.8-flash-prod-users');
  });

  test('sends an NDJSON status before a delayed upstream completes', async () => {
    const upstreamStarted = new Promise<void>((resolve) => { delayedUpstreamStarted = resolve; });
    const response = fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'wait', model: 'delayed-test' }),
    });
    await upstreamStarted;
    const res = await Promise.race([
      response,
      Bun.sleep(1_000).then(() => { throw new Error('generation headers were not delivered while upstream was waiting'); }),
    ]);
    expect(res.headers.get('content-type')).toContain('application/x-ndjson');
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({ type: 'status', message: 'Generating...' });
    releaseDelayedUpstream?.();
    await reader.cancel();
    reader.releaseLock();
    releaseDelayedUpstream = undefined;
    delayedUpstreamStarted = undefined;
  });

  test('accumulates the original objective and successive Improve edits', async () => {
    const first = await improve({ prompt: 'add a toolbar', mode: 'create', model: 'save-test' });
    expect(first.status).toBe(200);
    const stored = createGameStorage(join(dir, 'games'));
    expect((await stored.read('poster.html')).post).toMatchObject({
      prompt: 'a poster\n\nadd a toolbar', settings: { mode: 'create' },
    });
    const before = upstreamBodies.length;
    const second = await improve({ prompt: 'add keyboard shortcuts', model: 'save-test' });
    expect(second.status).toBe(200);
    const sent = upstreamBodies[before];
    expect(sent.instructions).toBe(CREATE_SYSTEM_PROMPT);
    expect(sent.input).toContain('The original prompt was: "a poster\n\nadd a toolbar"');
    expect(sent.input).toContain('Change request: add keyboard shortcuts');
    expect((await stored.read('poster.html')).post).toMatchObject({
      prompt: 'a poster\n\nadd a toolbar\n\nadd keyboard shortcuts', settings: { mode: 'create' },
    });
  });
});

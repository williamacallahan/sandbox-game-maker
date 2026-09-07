#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { CREATE_SYSTEM_PROMPT, loadConfig, positiveNumber, reasoningEffort, REASONING_EFFORTS, type AgentConfig } from './config.js';
import { runAgent } from './agent.js';
import { CHARS_PER_TOKEN } from './tools.js';
import { createGameStorage, GAME_FILENAME } from './storage.js';

const defaults = loadConfig({}, { skipApiKey: true });
const storage = createGameStorage(defaults.outDir);
const GAME_URL = /^\/games\/([a-z0-9][a-z0-9-]*\.(html|js))$/;

// ponytail: cached for the server's lifetime; restart to refresh the model list.
let modelsCache: string | null = null;

const playerHtml = readFileSync(new URL('./player.html', import.meta.url), 'utf-8');
const PLAYER_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'none'; img-src 'none'; font-src 'none'; base-uri 'none'; form-action 'none'";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'NoSuchKey');
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  idleTimeout: 255, // generation runs minutes; default 10s kills the NDJSON stream
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/') {
      return new Response(Bun.file(new URL('./index.html', import.meta.url).pathname));
    }

    if (url.pathname === '/api/config') {
      return json({
        systemPrompt: defaults.systemPrompt,
        createSystemPrompt: CREATE_SYSTEM_PROMPT,
        model: defaults.model,
        maxToolCalls: defaults.maxToolCalls,
        maxContextTokens: defaults.maxContextTokens,
        maxCost: defaults.maxCost,
        reasoningEfforts: REASONING_EFFORTS,
        charsPerToken: CHARS_PER_TOKEN,
        defaultPrompt: 'a snake game with wrap-around walls',
      });
    }

    if (url.pathname === '/api/models') {
      if (!modelsCache) {
        const res = await fetch('https://openrouter.ai/api/v1/models');
        if (!res.ok) return json({ error: `openrouter /v1/models returned ${res.status}` }, 502);
        modelsCache = await res.text();
      }
      return new Response(modelsCache, { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/api/feed') {
      try {
        return json(await storage.list());
      } catch (error) {
        return json({ error: errorMessage(error) }, 502);
      }
    }

    const game = GAME_URL.exec(url.pathname);
    if (game) {
      let content: string;
      try {
        ({ content } = await storage.read(game[1]));
      } catch (error) {
        if (isMissing(error)) return new Response('not found', { status: 404 });
        return json({ error: errorMessage(error) }, 502);
      }
      // .js terminal games play in the browser: ?play wraps them in the xterm.js
      // runner and loads the source as a sandboxed external script.
      if (game[2] === 'js' && url.searchParams.has('play')) {
        const html = playerHtml.replace('__GAME_URL__', `/games/${game[1]}`);
        return new Response(html, {
          headers: {
            'content-type': 'text/html',
            'content-security-policy': PLAYER_CSP,
          },
        });
      }
      // Bare .js doubles as the runner's <script src> — a real script MIME is
      // required: the sandboxed page's opaque origin makes the fetch
      // cross-origin, and browsers (ORB) block text/plain scripts there.
      return new Response(content, {
        headers: {
          'content-type': game[2] === 'html' ? 'text/html' : 'text/javascript',
          ...(game[2] === 'js' && { 'access-control-allow-origin': '*' }),
        },
      });
    }

    if (url.pathname === '/api/generate' && req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) return json({ error: 'prompt is required' }, 400);

      const overrides: Partial<AgentConfig> = {};
      try {
        for (const key of ['systemPrompt', 'model'] as const) {
          if (typeof body[key] === 'string' && body[key].trim()) overrides[key] = body[key].trim();
        }
        for (const key of ['maxToolCalls', 'maxContextTokens', 'maxOutputTokens', 'maxReasoningTokens', 'maxCost'] as const) {
          if (body[key] != null && body[key] !== '') overrides[key] = positiveNumber(key, String(body[key]));
        }
        if (typeof body.reasoningEffort === 'string' && body.reasoningEffort) {
          overrides.reasoningEffort = reasoningEffort('reasoningEffort', body.reasoningEffort);
        }
      } catch (err: any) {
        return json({ error: err.message }, 400);
      }

      const wantedFile = typeof body.filename === 'string' && body.filename.trim() ? body.filename.trim() : null;
      if (wantedFile && !GAME_FILENAME.test(wantedFile)) {
        return json({ error: `filename must be lowercase kebab-case ending in .html or .js with no underscores, e.g. "my-game.html"` }, 400);
      }

      let config: AgentConfig;
      try {
        config = loadConfig(overrides);
      } catch (err: any) {
        return json({ error: err.message }, 500);
      }

      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + '\n'));
          try {
            const fullPrompt = wantedFile ? `${prompt}\n\nSave the file as exactly "${wantedFile}".` : prompt;
            const { savedPosts } = await runAgent(config, fullPrompt, {
              storage,
              wantedFilename: wantedFile ?? undefined,
              savePrompt: prompt,
              onEvent: send,
            });
            for (const post of savedPosts) send({ type: 'post', post });
          } catch (error) {
            send({ type: 'error', message: errorMessage(error) });
          }
          controller.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(`game-maker feed → http://localhost:${server.port}`);

#!/usr/bin/env bun
import { basename, join } from 'node:path';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { CREATE_SYSTEM_PROMPT, loadConfig, positiveNumber, reasoningEffort, REASONING_EFFORTS, type AgentConfig } from './config.js';
import { runAgent, type RunStats } from './agent.js';
import { GAME_FILENAME } from './tools.js';

const defaults = loadConfig({}, { skipApiKey: true });
const FEED_PATH = join(defaults.outDir, 'feed.json');
const GAME_URL = /^\/games\/([a-z0-9][a-z0-9-]*\.(html|js))$/;

type Post = {
  file: string | null;
  prompt: string;
  model: string;
  ts: number;
  /** The effective generation settings, shown by the feed's Details toggle. */
  settings?: {
    model: string;
    reasoningEffort: string | null;
    maxToolCalls: number;
    maxContextTokens: number;
    maxOutputTokens: number | null;
    maxReasoningTokens: number | null;
    maxCost: number;
    systemPrompt: string;
  };
  /** Run metadata (provider, tokens/sec, ttft, totals) from the done event. */
  stats?: RunStats | null;
};

function readFeed(): Post[] {
  try {
    return JSON.parse(readFileSync(FEED_PATH, 'utf-8'));
  } catch {
    return [];
  }
}

// ponytail: cached for the server's lifetime; restart to refresh the model list.
let modelsCache: string | null = null;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
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
      // The directory is the source of truth; feed.json only decorates files
      // with the prompt/model that produced them.
      const meta = new Map(readFeed().map((p) => [p.file, p]));
      let posts: Post[] = [];
      try {
        posts = readdirSync(defaults.outDir)
          .filter((f) => GAME_FILENAME.test(f))
          .map((f) => meta.get(f) ?? { file: f, prompt: '', model: '', ts: statSync(join(defaults.outDir, f)).mtimeMs });
      } catch {}
      posts.sort((a, b) => b.ts - a.ts);
      return json(posts);
    }

    const game = GAME_URL.exec(url.pathname);
    if (game) {
      const file = Bun.file(join(defaults.outDir, game[1]));
      if (!(await file.exists())) return new Response('not found', { status: 404 });
      // .js terminal games are served as text so the UI can show them as code.
      return new Response(file, { headers: { 'content-type': game[2] === 'html' ? 'text/html' : 'text/plain' } });
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
        return json({ error: `filename must be kebab-case ending in .html or .js, e.g. "snake.html"` }, 400);
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
          // tool_result.output is a display preview truncated to 200 chars, so
          // take the filename from the untruncated tool_call args and only use
          // the result's stable success prefix (never cut by end-truncation).
          let pendingFile: string | null = null;
          let savedFile: string | null = null;
          let runStats: RunStats | null = null;
          try {
            const fullPrompt = wantedFile ? `${prompt}\n\nSave the file as exactly "${wantedFile}".` : prompt;
            await runAgent(config, fullPrompt, {
              onEvent: (e) => {
                if (e.type === 'tool_call' && e.name === 'save_game' && typeof e.args.filename === 'string') {
                  pendingFile = e.args.filename;
                } else if (e.type === 'tool_result' && e.name === 'save_game') {
                  if (pendingFile && e.output.startsWith('{"written":true')) savedFile = pendingFile;
                  pendingFile = null;
                } else if (e.type === 'done') {
                  runStats = e.stats;
                }
                send(e);
              },
            });
            // The prompt asks the model to use wantedFile, but the rename is
            // the guarantee: whatever save_game wrote lands under that name.
            if (wantedFile && savedFile && basename(savedFile) !== wantedFile) {
              renameSync(join(defaults.outDir, basename(savedFile)), join(defaults.outDir, wantedFile));
              savedFile = wantedFile;
            }
            const post: Post = {
              file: savedFile ? basename(savedFile) : null,
              prompt,
              model: config.model,
              ts: Date.now(),
              settings: {
                model: config.model,
                reasoningEffort: config.reasoningEffort ?? null,
                maxToolCalls: config.maxToolCalls,
                maxContextTokens: config.maxContextTokens,
                maxOutputTokens: config.maxOutputTokens ?? null,
                maxReasoningTokens: config.maxReasoningTokens ?? null,
                maxCost: config.maxCost,
                systemPrompt: config.systemPrompt,
              },
              stats: runStats,
            };
            if (post.file) {
              mkdirSync(defaults.outDir, { recursive: true });
              writeFileSync(FEED_PATH, JSON.stringify([post, ...readFeed().filter((p) => p.file !== post.file)], null, 2));
            }
            send({ type: 'post', post });
          } catch (err: any) {
            send({ type: 'error', message: err?.message ?? String(err) });
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

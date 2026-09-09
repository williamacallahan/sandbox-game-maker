#!/usr/bin/env bun
import { readFileSync } from 'node:fs';
import { CREATE_SYSTEM_PROMPT, UI_DEFAULTS, UI_SYSTEM_PROMPT, loadConfig, positiveNumber, reasoningEffort, REASONING_EFFORTS, type AgentConfig, type AgentMode } from './config.js';
import { runAgent } from './agent.js';
import { CHARS_PER_TOKEN } from './tools.js';
import { createGameStorage, GAME_FILENAME, parseFeedLimit } from './storage.js';

const defaults = loadConfig({}, { skipApiKey: true });
const storage = createGameStorage(defaults.outDir);
const GAME_URL = /^\/games\/([a-z0-9][a-z0-9-]*\.(html|js))$/;
const VERSION_URL = /^\/api\/versions\/([a-z0-9][a-z0-9-]*\.(html|js))$/;
const POST_URL = /^\/api\/post\/([a-z0-9][a-z0-9-]*\.(html|js))$/;

// ponytail: cached for the server's lifetime; restart to refresh the model list.
let modelsCache: string | null = null;

const playerHtml = readFileSync(new URL('./player.html', import.meta.url), 'utf-8');
const ROOT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-src 'self'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const GAME_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const PLAYER_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js; style-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css; connect-src 'none'; img-src 'none'; font-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

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
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/') {
      return new Response(Bun.file(new URL('./index.html', import.meta.url).pathname), {
        headers: { 'content-security-policy': ROOT_CSP, 'cross-origin-opener-policy': 'same-origin' },
      });
    }

    if (url.pathname === '/api/config') {
      return json({
        systemPrompt: defaults.systemPrompt,
        createSystemPrompt: CREATE_SYSTEM_PROMPT,
        uiSystemPrompt: UI_SYSTEM_PROMPT,
        ui: { ...UI_DEFAULTS, defaultPrompt: 'a spending summary card with a 7-day bar chart and a details button' },
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
        // The catalog comes from whichever endpoint serves generation, so a gateway's own aliases (e.g. oui-1) are listed.
        const res = defaults.baseUrl
          ? await fetch(defaults.baseUrl.replace(/\/$/, '') + '/models', { headers: { Authorization: `Bearer ${defaults.apiKey}` } })
          : await fetch('https://openrouter.ai/api/v1/models');
        if (!res.ok) return json({ error: `/v1/models returned ${res.status}` }, 502);
        modelsCache = await res.text();
      }
      return new Response(modelsCache, { headers: { 'content-type': 'application/json' } });
    }

    if (url.pathname === '/api/feed') {
      try {
        const limit = url.searchParams.get('limit') ? parseFeedLimit(url.searchParams.get('limit')!) : 10;
        return json(await storage.listFeed({ limit, cursor: url.searchParams.get('cursor') ?? undefined }));
      } catch (error) {
        return json({ error: errorMessage(error) }, 502);
      }
    }

    const version = VERSION_URL.exec(url.pathname);
    if (version && req.method === 'GET') {
      try {
        return json(await storage.versions(version[1]));
      } catch (error) {
        if (isMissing(error)) return new Response('not found', { status: 404 });
        return json({ error: errorMessage(error) }, 502);
      }
    }
    // Make one version (?versionId=) current: it becomes the newest version, the one the feed and player serve.
    if (version && req.method === 'POST') {
      const versionId = url.searchParams.get('versionId');
      if (!versionId) return json({ error: 'versionId is required' }, 400);
      try {
        await storage.promote(version[1], versionId);
        return json({ ok: true });
      } catch (error) {
        return json({ error: errorMessage(error) }, 502);
      }
    }
    // Delete one version (?versionId=) or the whole game; `remaining: 0` means the game is gone.
    if (version && req.method === 'DELETE') {
      try {
        return json({ remaining: await storage.remove(version[1], url.searchParams.get('versionId') ?? undefined) });
      } catch (error) {
        return json({ error: errorMessage(error) }, 502);
      }
    }

    // Metadata (prompt, instructions, settings, stats) for one stored version of a game.
    const postMatch = POST_URL.exec(url.pathname);
    if (postMatch && req.method === 'GET') {
      try {
        return json((await storage.read(postMatch[1], url.searchParams.get('versionId') ?? undefined)).post);
      } catch (error) {
        if (isMissing(error)) return new Response('not found', { status: 404 });
        return json({ error: errorMessage(error) }, 502);
      }
    }

    const game = GAME_URL.exec(url.pathname);
    if (game) {
      const versionId = url.searchParams.get('versionId') ?? undefined;
      let content: string;
      try {
        ({ content } = await storage.read(game[1], versionId));
      } catch (error) {
        if (isMissing(error)) return new Response('not found', { status: 404 });
        return json({ error: errorMessage(error) }, 502);
      }
      // .js terminal games play in the browser: ?play wraps them in the xterm.js
      // runner and loads the source as a sandboxed external script.
      if (game[2] === 'js' && url.searchParams.has('play')) {
        const scriptUrl = '/games/' + game[1] + (versionId ? '?versionId=' + encodeURIComponent(versionId) : '');
        const html = playerHtml.replace('__GAME_URL__', scriptUrl);
        return new Response(html, {
          headers: {
            'content-type': 'text/html',
            'content-security-policy': PLAYER_CSP,
            'cross-origin-opener-policy': 'noopener-allow-popups',
          },
        });
      }
      // Bare .js doubles as the runner's <script src> — a real script MIME is
      // required: the sandboxed page's opaque origin makes the fetch
      // cross-origin, and browsers (ORB) block text/plain scripts there.
      return new Response(content, {
        headers: {
          'content-type': game[2] === 'html' ? 'text/html' : 'text/javascript',
          ...(game[2] === 'js' ? { 'access-control-allow-origin': '*' } : {
            'content-security-policy': GAME_CSP,
            'cross-origin-opener-policy': 'noopener-allow-popups',
          }),
        },
      });
    }

    if (url.pathname === '/api/generate' && req.method === 'POST') {
      server.timeout(req, 0);
      const body = await req.json().catch(() => ({}));
      const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
      if (!prompt) return json({ error: 'prompt is required' }, 400);

      const requestedMode = body.mode === 'game' || body.mode === 'create' || body.mode === 'ui' ? body.mode : undefined;
      const existingFile = typeof body.existingFile === 'string' && body.existingFile.trim() ? body.existingFile.trim() : null;
      if (existingFile && !GAME_FILENAME.test(existingFile)) {
        return json({ error: `existingFile must be lowercase kebab-case ending in .html or .js with no underscores, e.g. "my-game.html"` }, 400);
      }
      const existingVersionId = typeof body.existingVersionId === 'string' && body.existingVersionId.trim() ? body.existingVersionId.trim() : undefined;
      const wantedFile = typeof body.filename === 'string' && body.filename.trim() ? body.filename.trim() : null;
      if (wantedFile && !GAME_FILENAME.test(wantedFile)) {
        return json({ error: `filename must be lowercase kebab-case ending in .html or .js with no underscores, e.g. "my-game.html"` }, 400);
      }
      const targetFile = existingFile ?? wantedFile ?? undefined;
      if (wantedFile && !existingFile && await storage.exists(wantedFile)) {
        return json({ error: `game ${JSON.stringify(wantedFile)} already exists; use Improve to change it or pick another filename` }, 409);
      }

      let existing: { content: string; post: { prompt: string; instructions?: string; settings?: { mode?: AgentMode } } } | undefined;
      if (existingFile) {
        try {
          existing = await storage.read(existingFile, existingVersionId);
        } catch (error) {
          if (isMissing(error)) return json({ error: `game not found: ${existingFile}` }, 404);
          return json({ error: errorMessage(error) }, 502);
        }
      }
      const mode = requestedMode ?? existing?.post.settings?.mode ?? 'game';
      const overrides: Partial<AgentConfig> = { mode };
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
        if (mode === 'create') {
          overrides.systemPrompt ??= CREATE_SYSTEM_PROMPT;
          overrides.model ??= defaults.model;
        } else if (mode === 'ui') {
          overrides.systemPrompt ??= UI_SYSTEM_PROMPT;
          overrides.model ??= UI_DEFAULTS.model;
          overrides.maxContextTokens ??= UI_DEFAULTS.maxContextTokens;
          overrides.maxOutputTokens ??= UI_DEFAULTS.maxOutputTokens;
        }
      } catch (err: any) {
        return json({ error: err.message }, 400);
      }

      let config: AgentConfig;
      try {
        config = loadConfig(overrides);
      } catch (err: any) {
        return json({ error: err.message }, 500);
      }

      let fullPrompt: string;
      let savePrompt: string;
      if (existingFile && existing) {
        const originalInstructions = existing.post.instructions ?? 'none';
        // The source goes in the prompt as plain text. A read_file result is a JSON string, and small models
        // (oui-1) copy its \n and \" escapes into save_game content verbatim, saving an unrenderable document.
        fullPrompt = `Improve the existing game saved as "games/${existingFile}". The original prompt was: "${existing.post.prompt}". The original player instructions were: "${originalInstructions}".\n\nIts complete current source follows; do not call read_file.\n\n${existing.content}\n\nApply this change request with edit_game to "games/${existingFile}" using small exact unique replacements. Preserve unrelated source and split large changes across multiple bounded edits; do not re-emit the whole document with save_game. Each edit must leave a valid runnable file. Validate the result with validate_game before finishing.\n\nChange request: ${prompt}`;
        savePrompt = `${existing.post.prompt}\n\n${prompt}`;
      } else {
        fullPrompt = wantedFile ? `${prompt}\n\nSave the file as exactly "${wantedFile}".` : prompt;
        savePrompt = prompt;
      }

      // Late callbacks (onTurnEnd metadata) and client disconnects must never enqueue on a closed
      // controller: that throw escaped the handler and exited the process (ERR_INVALID_STATE, 2026-09-08).
      let open = true;
      const abort = new AbortController();
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stopHeartbeat = () => {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
      };
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (o: unknown) => { if (open) controller.enqueue(enc.encode(JSON.stringify(o) + '\n')); };
          heartbeat = setInterval(() => { if (open) controller.enqueue(enc.encode('\n')); }, 5_000);
          send({ type: 'status', message: 'Generating...' });
          try {
            const { savedPosts } = await runAgent(config, fullPrompt, {
              storage,
              wantedFilename: targetFile,
              existingVersionId,
              savePrompt,
              overwrite: Boolean(existingFile),
              onEvent: send,
              signal: abort.signal,
            });
            for (const post of savedPosts) send({ type: 'post', post });
          } catch (error) {
            send({ type: 'error', message: errorMessage(error) });
          } finally {
            stopHeartbeat();
          }
          if (open) { open = false; controller.close(); }
        },
        cancel() { open = false; stopHeartbeat(); abort.abort(); },
      });
      return new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } });
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(`game-maker feed → http://localhost:${server.port}`);

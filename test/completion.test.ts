import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, type AgentEvent, type RunAgentOptions } from '../src/agent.js';
import { loadConfig, type AgentConfig } from '../src/config.js';
import { createGameStorage, type GameStorage } from '../src/storage.js';

const GAME_SOURCE = '<body style="margin:0;overflow:hidden;width:100vw;height:100vh"><button id="play">A</button><script>document.querySelector("#play").addEventListener("click", () => {});</script></body>';

type Reply = (request: Request) => Response | Promise<Response>;
type Harness = {
  outDir: string;
  storage: GameStorage;
  requests: Record<string, unknown>[];
  run: (options?: Pick<RunAgentOptions, 'onEvent' | 'signal'>) => ReturnType<typeof runAgent>;
};

function response(output: unknown[], status: 'completed' | 'incomplete' = 'completed') {
  return {
    id: crypto.randomUUID(),
    object: 'response',
    created_at: 1,
    completed_at: 2,
    model: 'completion-test',
    status,
    error: null,
    incomplete_details: status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: null,
    metadata: null,
    frequency_penalty: null,
    output,
    parallel_tool_calls: false,
    presence_penalty: null,
    temperature: null,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    usage: {
      input_tokens: 10,
      output_tokens: 20,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
      cost: 0.75,
    },
  };
}

function functionCall(name: string, argumentsJson: string) {
  return {
    type: 'function_call',
    id: crypto.randomUUID(),
    call_id: crypto.randomUUID(),
    name,
    status: 'completed',
    arguments: argumentsJson,
  };
}

function message(text = 'Done.') {
  return {
    type: 'message',
    id: crypto.randomUUID(),
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

function sse(events: Record<string, unknown>[], ending: 'completed' | 'eof' | 'done' = 'completed') {
  const body = events.map((event, sequence_number) =>
    `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`,
  ).join('') + (ending === 'done' ? 'data: [DONE]\n\n' : '');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function functionEvents(calls: ReturnType<typeof functionCall>[], status?: 'completed' | 'incomplete') {
  const terminal = response(calls, status ?? 'completed');
  const events: Record<string, unknown>[] = [{
    type: 'response.created',
    response: { ...terminal, status: 'in_progress', completed_at: null, output: [], usage: null },
  }];
  for (const [output_index, call] of calls.entries()) {
    events.push(
      { type: 'response.output_item.added', output_index, item: { ...call, status: 'in_progress', arguments: '' } },
      { type: 'response.function_call_arguments.done', item_id: call.id, name: call.name, output_index, arguments: call.arguments },
      { type: 'response.output_item.done', output_index, item: call },
    );
  }
  if (status) events.push({ type: `response.${status}`, response: terminal });
  return events;
}

function streamedFunctionResponse(calls: ReturnType<typeof functionCall>[], status: 'completed' | 'incomplete' = 'completed') {
  return sse(functionEvents(calls, status));
}

function completedTextResponse() {
  return Response.json(response([message()]));
}

function saveArguments(filename: string) {
  return JSON.stringify({ filename, content: GAME_SOURCE, instructions: 'Click Play.' });
}

async function withHarness<T>(replies: Reply[], work: (harness: Harness) => Promise<T>, settings?: { usage?: Reply; direct?: boolean }): Promise<T> {
  const outDir = await mkdtemp(join(tmpdir(), 'game-completion-'));
  const requests: Record<string, unknown>[] = [];
  const handleRequest = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === '/api/usage/session') return settings?.usage?.(request) ?? Response.json({ by_model: [] });
    if (settings?.direct && path.endsWith('/generation')) return Response.json({ data: {
      api_type: 'completions', app_id: null, cache_discount: null, cancelled: false,
      created_at: '2026-01-01T00:00:00Z', data_region: 'global', external_user: null,
      finish_reason: 'stop', generation_time: null, http_referer: null, id: 'test-generation',
      is_byok: false, latency: null, model: 'completion-test', moderation_latency: null,
      native_finish_reason: 'stop', native_tokens_cached: null, native_tokens_completion: null,
      native_tokens_completion_images: null, native_tokens_prompt: null, native_tokens_reasoning: null,
      num_fetches: null, num_input_audio_prompt: null, num_media_completion: null, num_media_prompt: null,
      num_search_results: null, origin: 'test', preset_id: null, provider_name: 'test-provider',
      provider_responses: null, router: null, service_tier: null, streamed: false,
      tokens_completion: null, tokens_prompt: null, total_cost: 99, upstream_id: null,
      upstream_inference_cost: null, usage: 99, user_agent: null, web_search_engine: null,
    } });
    if (!path.endsWith('/v1/responses')) throw new Error(`Unexpected test request: ${path}`);
    requests.push(await request.json() as Record<string, unknown>);
    const reply = replies.shift();
    return reply ? reply(request) : new Response('unexpected follow-up', { status: 500 });
  };
  const server = Bun.serve({ port: 0, fetch: handleRequest });
  const originalFetch = globalThis.fetch;
  // Keep the SDK intact; fake only direct HTTP and the optional ledger boundary.
  const fetchBoundary = settings?.direct || settings?.usage
    ? spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const incoming = new Request(request, init);
      return settings.direct || new URL(incoming.url).pathname === '/api/usage/session'
        ? handleRequest(incoming) : originalFetch(request, init);
    }, { preconnect: originalFetch.preconnect }))
    : undefined;
  const config: AgentConfig = loadConfig({
    apiKey: 'test-key',
    baseUrl: settings?.direct ? undefined : `http://127.0.0.1:${server.port}/v1`,
    model: 'completion-test',
    outDir,
  });
  const storage = createGameStorage(outDir, {});
  try {
    return await work({
      outDir,
      storage,
      requests,
      run: (options) => runAgent(config, 'Build a game.', { storage, ...(options ?? {}) }),
    });
  } finally {
    fetchBoundary?.mockRestore();
    server.stop(true);
    await rm(outDir, { recursive: true, force: true });
  }
}

const coverageCases = [
  { label: 'explicit measured zero', rows: [{ total_cost: 0, cost_complete: true, unpriced_generation_count: 0 }], expected: 0 },
  { label: 'known positive across models', rows: [{ total_cost: 0.25, cost_complete: true, unpriced_generation_count: 0 }, { total_cost: 0.125, cost_complete: true, unpriced_generation_count: 0 }], expected: 0.375 },
  { label: 'mixed known and unknown', rows: [{ total_cost: 0.25, cost_complete: true, unpriced_generation_count: 0 }, { total_cost: 0, cost_complete: false, unpriced_generation_count: 1 }], expected: null },
  { label: 'missing markers', rows: [{ total_cost: 0.25 }], expected: null },
  { label: 'missing count', rows: [{ total_cost: 0.25, cost_complete: true }], expected: null },
  { label: 'missing completeness', rows: [{ total_cost: 0.25, unpriced_generation_count: 0 }], expected: null },
  { label: 'contradictory count', rows: [{ total_cost: 0.25, cost_complete: true, unpriced_generation_count: 1 }], expected: null },
  { label: 'false completeness with zero count', rows: [{ total_cost: 0.25, cost_complete: false, unpriced_generation_count: 0 }], expected: null },
  { label: 'null completeness', rows: [{ total_cost: 0.25, cost_complete: null, unpriced_generation_count: 0 }], expected: null },
  { label: 'null count', rows: [{ total_cost: 0.25, cost_complete: true, unpriced_generation_count: null }], expected: null },
  { label: 'empty ledger', rows: [], expected: null },
];

for (const outcome of ['completed', 'failed', 'aborted'] as const) {
  for (const coverage of [...coverageCases, { label: 'unavailable ledger', rows: [], expected: null }]) {
    test(`gateway run cost: ${outcome}, ${coverage.label}`, async () => {
      const abort = new AbortController();
      const events: AgentEvent[] = [];
      const errors = spyOn(console, 'error').mockImplementation(() => {});
      try {
        await withHarness([
          () => streamedFunctionResponse([functionCall('save_game', saveArguments('cost.html'))]),
          outcome === 'failed'
            ? () => Response.json(response([], 'incomplete'))
            : completedTextResponse,
        ], async ({ run, storage }) => {
          const pending = run({ signal: abort.signal, onEvent: (event) => {
            events.push(event);
            if (outcome === 'aborted' && event.type === 'tool_result') abort.abort();
          } });
          if (outcome === 'completed') {
            const result = await pending;
            expect(result.stats).toMatchObject({ cost: coverage.expected, inputTokens: 20, outputTokens: 40, totalTokens: 60 });
            expect(events.find((event) => event.type === 'done')).toMatchObject({ stats: { cost: coverage.expected } });
          } else {
            await expect(pending).rejects.toThrow();
            expect(events.some((event) => event.type === 'done')).toBe(false);
          }
          expect((await storage.read('cost.html')).post.stats).toMatchObject({ cost: coverage.expected, inputTokens: outcome === 'completed' ? 20 : 10, outputTokens: outcome === 'completed' ? 40 : 20, totalTokens: outcome === 'completed' ? 60 : 30 });
        }, { usage: () => coverage.label === 'unavailable ledger'
          ? new Response('ledger unavailable', { status: 503, headers: { 'retry-after': '0' } })
          : Response.json({ by_model: coverage.rows }) });
      } finally { errors.mockRestore(); }
    });
  }
}

for (const outcome of ['completed', 'failed', 'aborted'] as const) {
  test(`direct provider run cost: ${outcome} retains measured cost despite gateway-like headers`, async () => {
    const abort = new AbortController();
    await withHarness([
      () => {
        const reply = streamedFunctionResponse([functionCall('save_game', saveArguments('direct-cost.html'))]);
        reply.headers.set('x-lgw-attempt-providers', 'test-provider');
        return reply;
      },
      () => Response.json(response([message()], outcome === 'failed' ? 'incomplete' : 'completed')),
    ], async ({ run, storage }) => {
      const pending = run({ signal: abort.signal, onEvent: (event) => {
        if (outcome === 'aborted' && event.type === 'tool_result') abort.abort();
      } });
      if (outcome === 'completed') expect((await pending).stats.cost).toBe(1.5);
      else await expect(pending).rejects.toThrow();
      expect((await storage.read('direct-cost.html')).post.stats?.cost).toBe(outcome === 'completed' ? 1.5 : 0.75);
    }, { direct: true });
  });
}

for (const outcome of ['completed', 'failed', 'aborted'] as const) {
  for (const boundary of ['stalled fetch', 'stalled body', 'large Retry-After', 'retry then priced'] as const) {
    test(`gateway settlement deadline: ${outcome}, ${boundary}`, async () => {
      const abort = new AbortController();
      const originalAbort = new Error('stop after saved game');
      const events: AgentEvent[] = [];
      let ledgerReads = 0;
      const errors = spyOn(console, 'error').mockImplementation(() => {});
      try {
        await withHarness([
          () => streamedFunctionResponse([functionCall('save_game', saveArguments('deadline.html'))]),
          () => Response.json(response([message()], outcome === 'failed' ? 'incomplete' : 'completed')),
        ], async ({ run, storage }) => {
          const pending = run({ signal: abort.signal, onEvent: (event) => {
            events.push(event);
            if (outcome === 'aborted' && event.type === 'tool_result') abort.abort(originalAbort);
          } });
          let watchdog: ReturnType<typeof setTimeout> | undefined;
          const bounded = Promise.race([pending, new Promise<never>((_, reject) => {
            watchdog = setTimeout(() => reject(new Error('ledger settlement exceeded watchdog')), 2200);
          })]);
          const expected = { cost: boundary === 'retry then priced' ? 0.375 : null,
            inputTokens: outcome === 'completed' ? 20 : 10, outputTokens: outcome === 'completed' ? 40 : 20,
            totalTokens: outcome === 'completed' ? 60 : 30 };
          try {
            if (outcome === 'completed') {
              const result = await bounded;
              expect(result.stats).toMatchObject(expected);
              expect(result.savedPosts[0]?.stats).toMatchObject(expected);
              expect(events.find((event) => event.type === 'done')).toMatchObject({ stats: expected });
            } else {
              await expect(bounded).rejects.toThrow(outcome === 'aborted' ? originalAbort.message : 'Model response did not complete');
              expect(events.some((event) => event.type === 'done')).toBe(false);
            }
            expect((await storage.read('deadline.html')).post.stats).toMatchObject(expected);
            expect(ledgerReads).toBe(boundary === 'retry then priced' ? 2 : 1);
          } finally { clearTimeout(watchdog); }
        }, { usage: (request) => {
          ledgerReads++;
          request.signal.throwIfAborted();
          if (boundary === 'stalled fetch') return new Promise<Response>((_, reject) => {
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          });
          if (boundary === 'stalled body') return new Response(new ReadableStream({ start(controller) {
            request.signal.addEventListener('abort', () => controller.error(request.signal.reason), { once: true });
          } }), { headers: { 'content-type': 'application/json' } });
          if (boundary === 'retry then priced' && ledgerReads === 2) return Response.json({
            by_model: [{ total_cost: 0.375, cost_complete: true, unpriced_generation_count: 0 }],
          });
          return new Response('settling', { status: 503, headers: { 'retry-after': boundary === 'large Retry-After' ? '86400' : '0' } });
        } });
      } finally { errors.mockRestore(); }
    });
  }
}

test('gateway settlement lifecycle: abort while settling preserves stats without completing', async () => {
  const abort = new AbortController();
  const abortError = new Error('cancel during settlement');
  const events: AgentEvent[] = [];
  await withHarness([
    () => streamedFunctionResponse([functionCall('save_game', saveArguments('settlement-abort.html'))]),
    completedTextResponse,
  ], async ({ run, storage }) => {
    await expect(run({ signal: abort.signal, onEvent: (event) => events.push(event) })).rejects.toBe(abortError);
    expect((await storage.read('settlement-abort.html')).post.stats).toMatchObject({
      cost: 0.375, inputTokens: 20, outputTokens: 40, totalTokens: 60,
    });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  }, { usage: async () => {
    abort.abort(abortError);
    await Promise.resolve();
    return Response.json({ by_model: [{ total_cost: 0.375, cost_complete: true, unpriced_generation_count: 0 }] });
  } });
});

test('gateway settlement lifecycle: stats write failure retains the original settlement', async () => {
  const storageError = new Error('stats write interrupted');
  const events: AgentEvent[] = [];
  let ledgerReads = 0;
  await withHarness([
    () => streamedFunctionResponse([functionCall('save_game', saveArguments('settlement-storage.html'))]),
    completedTextResponse,
  ], async ({ run, storage }) => {
    const saveStats = storage.saveStats.bind(storage);
    let interrupted = false;
    storage.saveStats = async (...args) => {
      if (!interrupted) { interrupted = true; throw storageError; }
      await saveStats(...args);
    };
    await expect(run({ onEvent: (event) => events.push(event) })).rejects.toBe(storageError);
    expect((await storage.read('settlement-storage.html')).post.stats).toMatchObject({
      cost: 0.375, inputTokens: 20, outputTokens: 40, totalTokens: 60,
    });
    expect(events.some((event) => event.type === 'done')).toBe(false);
  }, { usage: () => {
    ledgerReads++;
    return Response.json({ by_model: ledgerReads === 1
      ? [{ total_cost: 0.375, cost_complete: true, unpriced_generation_count: 0 }]
      : [{ total_cost: 0.375, cost_complete: false, unpriced_generation_count: 1 }] });
  } });
});

for (const [label, options] of [
  ['without an event consumer', undefined],
  ['with an event consumer', { onEvent: () => {} }],
] as const) {
  test(`does not save a streamed tool call followed by response.incomplete ${label}`, async () => {
    await withHarness([
      () => streamedFunctionResponse([functionCall('save_game', saveArguments('incomplete.html'))], 'incomplete'),
    ], async ({ run, storage }) => {
      await expect(run(options)).rejects.toThrow();
      expect(await storage.exists('incomplete.html')).toBe(false);
    });
  });
}

for (const ending of ['eof', 'done'] as const) {
  test(`does not save when a streamed tool call ends with ${ending} before response.completed`, async () => {
    await withHarness([
      () => sse(functionEvents([functionCall('save_game', saveArguments(`${ending}.html`))]), ending),
    ], async ({ run, storage }) => {
      await expect(run({ onEvent: () => {} })).rejects.toThrow();
      expect(await storage.exists(`${ending}.html`)).toBe(false);
    });
  });
}

test('does not save a valid tool call from a JSON response with incomplete status', async () => {
  await withHarness([
    () => Response.json(response([functionCall('save_game', saveArguments('json-incomplete.html'))], 'incomplete')),
  ], async ({ run, storage }) => {
    await expect(run()).rejects.toThrow();
    expect(await storage.exists('json-incomplete.html')).toBe(false);
  });
});

test('saves a completed response and sends automatic sequential tool settings', async () => {
  await withHarness([
    () => streamedFunctionResponse([functionCall('save_game', saveArguments('saved.html'))]),
    completedTextResponse,
  ], async ({ run, storage, requests }) => {
    await run();
    expect((await storage.read('saved.html')).content).toBe(GAME_SOURCE);
    expect(requests[0]).toMatchObject({ model: 'completion-test', tool_choice: 'auto', parallel_tool_calls: false });
  });
});

for (const [label, argumentsJson, filename] of [
  ['malformed JSON', '{', 'malformed.html'],
  ['schema-invalid arguments', JSON.stringify({ filename: 'schema-invalid.html', content: 42 }), 'schema-invalid.html'],
] as const) {
  test(`does not save completed ${label}`, async () => {
    await withHarness([
      () => streamedFunctionResponse([functionCall('save_game', argumentsJson)]),
      completedTextResponse,
    ], async ({ run, storage }) => {
      const errors = spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await run();
        if (label === 'malformed JSON') expect(errors).toHaveBeenCalled();
      } finally { errors.mockRestore(); }
      expect(await storage.exists(filename)).toBe(false);
    });
  });
}

test('keeps a completed save when a later response is incomplete', async () => {
  await withHarness([
    () => streamedFunctionResponse([functionCall('save_game', saveArguments('first.html'))]),
    () => streamedFunctionResponse([functionCall('save_game', saveArguments('second.html'))], 'incomplete'),
  ], async ({ run, storage }) => {
    await expect(run()).rejects.toThrow();
    expect((await storage.read('first.html')).content).toBe(GAME_SOURCE);
    expect(await storage.exists('second.html')).toBe(false);
  });
});

test('executes completed edit_game calls in order', async () => {
  const replies: Reply[] = [];
  await withHarness(replies, async ({ run, storage, outDir }) => {
    await storage.save('editable.html', GAME_SOURCE, { prompt: 'initial', model: 'test', ts: 1, instructions: 'Click Play.' });
    const path = join(outDir, 'editable.html');
    replies.push(
      () => streamedFunctionResponse([
        functionCall('edit_game', JSON.stringify({ path, old_text: '>A<', new_text: '>B<' })),
        functionCall('edit_game', JSON.stringify({ path, old_text: '>B<', new_text: '>C<' })),
      ]),
      completedTextResponse,
    );
    await run();
    const edited = await storage.read('editable.html');
    expect(edited.content).toContain('>C<');
    expect(edited.content).not.toContain('>B<');
  });
});

for (const during of ['name lookup', 'edit read'] as const) {
  test(`cancellation during ${during} leaves the pending write unapplied`, async () => {
    const replies: Reply[] = [];
    await withHarness(replies, async ({ run, storage, outDir }) => {
      const abort = new AbortController();
      if (during === 'name lookup') {
        const lookup = storage.uniqueName.bind(storage);
        storage.uniqueName = async (name) => { const result = await lookup(name); abort.abort(); return result; };
        replies.push(() => streamedFunctionResponse([functionCall('save_game', saveArguments('cancelled.html'))]));
      } else {
        await storage.save('cancelled.html', GAME_SOURCE, { prompt: 'initial', model: 'test', ts: 1 });
        const read = storage.read.bind(storage);
        storage.read = async (...args) => { const result = await read(...args); abort.abort(); return result; };
        replies.push(() => streamedFunctionResponse([functionCall('edit_game', JSON.stringify({path:join(outDir,'cancelled.html'),old_text:'>A<',new_text:'>B<'}))]));
      }
      await expect(run({ signal: abort.signal, onEvent: () => {} })).rejects.toThrow();
      if (during === 'name lookup') expect(await storage.exists('cancelled.html')).toBe(false);
      else expect((await storage.read('cancelled.html')).content).toBe(GAME_SOURCE);
    });
  });
}

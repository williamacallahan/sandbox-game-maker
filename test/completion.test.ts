import { expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, type RunAgentOptions } from '../src/agent.js';
import { loadConfig, type AgentConfig } from '../src/config.js';
import { createGameStorage, type GameStorage } from '../src/storage.js';

const GAME_SOURCE = '<body style="margin:0;overflow:hidden;width:100vw;height:100vh"><button id="play">A</button><script>document.querySelector("#play").addEventListener("click", () => {});</script></body>';

type Reply = () => Response;
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

async function withHarness<T>(replies: Reply[], work: (harness: Harness) => Promise<T>): Promise<T> {
  const outDir = await mkdtemp(join(tmpdir(), 'game-completion-'));
  const requests: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/responses') return new Response('not found', { status: 404 });
      requests.push(await request.json() as Record<string, unknown>);
      const reply = replies.shift();
      return reply ? reply() : new Response('unexpected follow-up', { status: 500 });
    },
  });
  const config: AgentConfig = loadConfig({
    apiKey: 'test-key',
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
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
    server.stop(true);
    await rm(outDir, { recursive: true, force: true });
  }
}

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

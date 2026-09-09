import { OpenRouter } from '@openrouter/agent';
import type { Item } from '@openrouter/agent';
import { stepCountIs, maxCost } from '@openrouter/agent/stop-conditions';
import { generationsGetGeneration } from '@openrouter/sdk/funcs/generationsGetGeneration.js';
import type { AfterSuccessHook } from '@openrouter/sdk/hooks/types.js';
import type { OpenRouterMetadata } from '@openrouter/sdk/models/openroutermetadata.js';
import { unwrapAsync } from '@openrouter/sdk/types/fp.js';
import { z } from 'zod';
import { EventStream } from '@openrouter/sdk/lib/event-streams.js';
import type { AgentConfig } from './config.js';
import { Budget, CHARS_PER_TOKEN, makeTools } from './tools.js';
import { createGameStorage, type GameStorage, type Post } from './storage.js';

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; callId: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; callId: string; output: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'metadata'; responseId: string; turnNumber: number; model: string; provider: string | null; usage: TurnUsage }
  | { type: 'turn_end' }
  | { type: 'done'; durationMs: number; stats: RunStats };

export type BaseUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type TurnUsage = BaseUsage & {
  reasoningTokens?: number;
  cachedTokens?: number;
  cost?: number;
  /** Upstream provider cost; only present for BYOK requests. */
  upstreamCost?: number;
};

/** Per-run generation metadata, shown by the UI and CLI after a run. */
export type RunStats = BaseUsage & {
  /** Provider that served the final generation. */
  provider: string | null;
  /** Decode speed reported by OpenRouter; unavailable from generic gateways. */
  tokensPerSec: number | null;
  /** Time to first streamed text/reasoning delta in ms; null when not streaming. */
  ttftMs: number | null;
  /** Run-wide totals aggregated across every model call. */
  reasoningTokens: number;
  reasoningTokensEstimated?: boolean;
  toolCalls: number;
  durationMs: number;
  cost: number | null;
  /** Aggregate upstream provider cost; only present for BYOK requests. */
  upstreamCost: number | null;
};

export type RunAgentOptions = {
  onEvent?: (event: AgentEvent) => void;
  signal?: AbortSignal;
  storage?: GameStorage;
  wantedFilename?: string;
  existingVersionId?: string;
  savePrompt?: string;
  overwrite?: boolean;
};

const GatewayUsage = z.object({
  by_model: z.array(z.object({ total_cost: z.number() })),
});

function providerFromMeta(meta: OpenRouterMetadata | undefined): string | null {
  return meta?.endpoints?.available?.find((e) => e.selected)?.provider ?? meta?.attempts?.[0]?.provider ?? null;
}

async function fetchGeneration(client: OpenRouter, id: string, headers: Record<string, string>) {
  for (const delayMs of [2000, 3000, 3000]) {
    await Bun.sleep(delayMs);
    try {
      return (await unwrapAsync(generationsGetGeneration(client, { id }, { headers }))).data;
    } catch {
      continue;
    }
  }
  return null;
}

export async function runAgent(
  config: AgentConfig,
  input: string | ChatMessage[],
  options?: RunAgentOptions,
) {
  const startedAt = Date.now();
  const cacheKey = config.baseUrl ? crypto.randomUUID() : null;
  const runId = crypto.randomUUID();
  const storage = options?.storage ?? createGameStorage(config.outDir);
  const savedPosts: Post[] = [];
  const savePrompt = options?.savePrompt ?? (typeof input === 'string' ? input : input.findLast((message) => message.role === 'user')?.content ?? '');
  let providerFromHeaders: string | null = null;
  let upstreamCost: number | null = null;
  const textChunks: string[] = [];
  let reasoningChars = 0;
  let firstTokenAt: number | null = null;
  let toolCallId = '';

  // Running totals from onTurnEnd, so a run that fails after save_game still records its usage.
  const turnTotals = { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cost: 0, costSeen: false };
  let statsSaved = false;
  const headers: Record<string, string> = cacheKey ? { 'X-LGW-Cache-Key': cacheKey } : { 'X-OpenRouter-Metadata': 'enabled' };
  const responseHook: AfterSuccessHook = {
    afterSuccess: async (context, response) => {
      providerFromHeaders = response.headers.get('x-lgw-attempt-providers')?.split(',').at(-1) ?? null;
      if (context.operationID !== 'createResponses') return response;
      const completed = z.object({ status: z.literal('completed') });
      if (response.headers.get('content-type')?.includes('application/json')) {
        const body = await response.text();
        if (!completed.safeParse(JSON.parse(body)).success) throw new Error('Model response did not complete; no tools from this response were applied.');
        return new Response(body, response);
      }
      if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
        throw new Error('Expected a Responses API completion stream.');
      }
      let finished = false;
      const encoder = new TextEncoder();
      const eventHeader = z.object({ type: z.string(), response: z.unknown().optional(), delta: z.string().optional() });
      const events = new EventStream<Uint8Array>(response.body, ({ data }) => {
        if (data === '[DONE]') {
          if (!finished) throw new Error('Model stream ended without response.completed; no tools from this response were applied.');
          return { done: true, value: undefined };
        }
        const event = eventHeader.parse(JSON.parse(data!));
        if (['response.incomplete', 'response.failed', 'error'].includes(event.type)) {
          throw new Error(`Model sent ${event.type}; no tools from this response were applied. Retry with smaller edits.`);
        }
        if (event.type === 'response.completed') {
          if (!completed.safeParse(event.response).success) throw new Error('Model response.completed contained an incomplete response.');
          finished = true;
        }
        if (event.delta && ['response.output_text.delta', 'response.reasoning_text.delta', 'response.reasoning_summary_text.delta'].includes(event.type)) {
          firstTokenAt ??= Date.now();
          if (event.type === 'response.output_text.delta') {
            textChunks.push(event.delta);
            options?.onEvent?.({ type: 'text', delta: event.delta });
          } else {
            reasoningChars += event.delta.length;
            options?.onEvent?.({ type: 'reasoning', delta: event.delta });
          }
        }
        return { done: false, value: encoder.encode(`data: ${data}\n\n`) };
      });
      return new Response(events.pipeThrough(new TransformStream({
        transform(chunk, controller) { controller.enqueue(chunk); },
        flush() { if (!finished) throw new Error('Model stream ended without response.completed; no tools from this response were applied.'); },
      })), response);
    },
  };
  const client = new OpenRouter({
    apiKey: config.apiKey,
    ...(config.baseUrl && { serverURL: config.baseUrl }),
    hooks: [responseHook],
  });

  const promptChars = typeof input === 'string' ? input.length : input.reduce((n, m) => n + m.content.length, 0);
  const budget = new Budget(config.maxToolCalls, config.maxContextTokens, promptChars);

  const result = client.callModel(
    {
      model: config.model,
      toolChoice: 'auto',
      parallelToolCalls: false,
      toolConcurrency: 1,
      hooks: {
        PreToolUse: [{ handler: ({ toolName, toolInput }) => {
          options?.signal?.throwIfAborted();
          toolCallId = crypto.randomUUID();
          options?.onEvent?.({ type: 'tool_call', name: toolName, callId: toolCallId, args: toolInput });
        } }],
        PostToolUse: [{ handler: ({ toolName, toolOutput }) => {
          const output = typeof toolOutput === 'string' ? toolOutput : JSON.stringify(toolOutput);
          options?.onEvent?.({ type: 'tool_result', name: toolName, callId: toolCallId, output: output.length > 200 ? output.slice(0, 200) + '...' : output });
          options?.onEvent?.({ type: 'turn_end' });
        } }],
      },
      instructions: config.systemPrompt,
      ...(!config.baseUrl && { provider: { order: ['groq', 'venice'], allowFallbacks: true } }),
      ...(config.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
      // loadConfig rejects effort + maxReasoningTokens together, so at most one is set here.
      ...(config.reasoningEffort && { reasoning: { effort: config.reasoningEffort } }),
      ...(config.maxReasoningTokens && { reasoning: { maxTokens: config.maxReasoningTokens } }),
      input: input as string | Item[],
      tools: makeTools(config, budget, {
        storage,
        signal: options?.signal,
        wantedFilename: options?.wantedFilename,
        existingVersionId: options?.existingVersionId,
        overwrite: options?.overwrite,
        saveMetadata: () => ({
          prompt: savePrompt,
          model: config.model,
          ts: Date.now(),
          runId,
          settings: {
            mode: config.mode,
            model: config.model,
            reasoningEffort: config.reasoningEffort,
            maxToolCalls: config.maxToolCalls,
            maxContextTokens: config.maxContextTokens,
            maxOutputTokens: config.maxOutputTokens,
            maxReasoningTokens: config.maxReasoningTokens,
            maxCost: config.maxCost,
            systemPrompt: config.systemPrompt,
          },
        }),
        onSave: (post) => {
          savedPosts.push(post);
        },
      }),
      signal: options?.signal,
      // Steps also bound tool calls loosely (each tool-bearing step has >=1 call);
      // the Budget in tools.ts enforces the exact per-call and context caps.
      stopWhen: [stepCountIs(config.maxToolCalls + 2), maxCost(config.maxCost)],
      // Emit per-turn usage metadata as it is reported for each model response.
      onTurnEnd: (context, response) => {
        const u = response.usage;
        const upstream = u?.costDetails?.upstreamInferenceCost;
        if (upstream != null) {
          upstreamCost = (upstreamCost ?? 0) + upstream;
        }
        if (u) {
          turnTotals.inputTokens += u.inputTokens;
          turnTotals.outputTokens += u.outputTokens;
          turnTotals.totalTokens += u.totalTokens;
          turnTotals.reasoningTokens += u.outputTokensDetails?.reasoningTokens ?? 0;
          if (u.cost != null) { turnTotals.cost += u.cost; turnTotals.costSeen = true; }
        }
        if (u && options?.onEvent) {
          const provider = providerFromMeta(response.openrouterMetadata) ?? providerFromHeaders;
          options.onEvent({
            type: 'metadata',
            responseId: response.id,
            turnNumber: context.numberOfTurns,
            model: response.model,
            provider,
            usage: {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              totalTokens: u.totalTokens,
              reasoningTokens: u.outputTokensDetails?.reasoningTokens,
              cachedTokens: u.inputTokensDetails?.cachedTokens,
              cost: u.cost ?? undefined,
              upstreamCost: upstream ?? undefined,
            },
          });
        }
      },
    },
    // SDK retries the individual failing HTTP call with backoff (default covers
    // 5XX only); adding 429 here is safe — a per-call retry never re-executes
    // tools, unlike replaying the whole agent from the initial prompt.
    { headers, retryCodes: ['429', '5XX'] },
  );

  // Wire AbortSignal → result.cancel() so the underlying network stream
  // actually closes (not just the iterator we're about to walk). Also
  // handle the pre-aborted case: addEventListener('abort') does not fire
  // for signals already in the aborted state.
  const onAbort = () => result.cancel();
  options?.signal?.addEventListener('abort', onAbort);
  if (options?.signal?.aborted) result.cancel();

  try {
    const response = await result.getResponse();
    options?.signal?.throwIfAborted();
    if (response.status !== 'completed') throw new Error('Model response did not complete.');
    const totals = await result.getUsage();
    const durationMs = Date.now() - startedAt;
    let gatewayCost: number | null = null;
    if (config.baseUrl && cacheKey && providerFromHeaders) {
      const usageUrl = new URL('../api/usage/session', config.baseUrl);
      usageUrl.searchParams.set('cache_key', cacheKey);
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const usageResponse = await fetch(usageUrl, { headers: { Authorization: `Bearer ${config.apiKey}` } });
          if (usageResponse.ok) {
            gatewayCost = GatewayUsage.parse(await usageResponse.json()).by_model.reduce((sum, row) => sum + row.total_cost, 0);
            break;
          }
          if (usageResponse.status !== 503) {
            console.error(`Could not fetch gateway usage from ${usageUrl}: HTTP ${usageResponse.status}`);
            break;
          }
          await Bun.sleep(Number(usageResponse.headers.get('retry-after') ?? 1) * 1000);
        }
      } catch (error) {
        console.error(`Could not fetch gateway usage: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const generation = !config.baseUrl && response.id ? await fetchGeneration(client, response.id, headers) : null;
    const stats = buildStats({
      provider: providerFromMeta(response.openrouterMetadata) ?? providerFromHeaders ?? generation?.providerName ?? null,
      reportedTokensPerSec:
        generation?.generationTime && generation.nativeTokensCompletion
          ? Math.round((generation.nativeTokensCompletion / generation.generationTime) * 1000)
          : null,
      usage: totals,
      cost: gatewayCost ?? totals.cost ?? null,
    });
    await persistStats(stats);
    const text = textChunks.join('') || (response.outputText ?? '');
    options?.onEvent?.({ type: 'done', durationMs, stats });
    return { text, output: response.output, durationMs, stats, savedPosts };
  } catch (error) {
    result.cancel();
    // The file is already in the gallery; keep the usage we saw instead of leaving its Details empty.
    if (savedPosts.length && !statsSaved) {
      const stats = buildStats({ provider: providerFromHeaders, reportedTokensPerSec: null, usage: turnTotals, cost: turnTotals.costSeen ? turnTotals.cost : null });
      await persistStats(stats).catch((cause) => console.error(`Could not save run stats: ${cause instanceof Error ? cause.message : String(cause)}`));
    }
    throw error;
  } finally {
    options?.signal?.removeEventListener('abort', onAbort);
  }

  function buildStats(parts: { provider: string | null; reportedTokensPerSec: number | null; usage: BaseUsage & { reasoningTokens: number }; cost: number | null }): RunStats {
    const durationMs = Date.now() - startedAt;
    return {
      provider: parts.provider,
      // OpenRouter reports decode speed; gateways do not. The fallback is output tokens over the whole run
      // (prefill and tool time included), which understates but never inflates when a provider buffers its stream.
      tokensPerSec: parts.reportedTokensPerSec ?? (durationMs > 0 && parts.usage.outputTokens ? Math.round(parts.usage.outputTokens / (durationMs / 1000)) : null),
      ttftMs: firstTokenAt ? firstTokenAt - startedAt : null,
      inputTokens: parts.usage.inputTokens,
      outputTokens: parts.usage.outputTokens,
      totalTokens: parts.usage.totalTokens,
      reasoningTokens: parts.usage.reasoningTokens || Math.ceil(reasoningChars / CHARS_PER_TOKEN),
      reasoningTokensEstimated: !parts.usage.reasoningTokens && reasoningChars > 0,
      toolCalls: budget.callCount,
      durationMs,
      cost: parts.cost,
      upstreamCost: upstreamCost ?? null,
    };
  }

  async function persistStats(stats: RunStats) {
    if (!savedPosts.length) return;
    await storage.saveStats(runId, stats);
    statsSaved = true;
    for (const post of savedPosts) post.stats = stats;
  }
}

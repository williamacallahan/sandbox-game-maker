import { OpenRouter } from '@openrouter/agent';
import type { Item } from '@openrouter/agent';
import { stepCountIs, maxCost } from '@openrouter/agent/stop-conditions';
import { generationsGetGeneration } from '@openrouter/sdk/funcs/generationsGetGeneration.js';
import type { AfterSuccessHook, BeforeRequestHook } from '@openrouter/sdk/hooks/types.js';
import type { OpenRouterMetadata } from '@openrouter/sdk/models/openroutermetadata.js';
import { unwrapAsync } from '@openrouter/sdk/types/fp.js';
import { z } from 'zod';
import type { AgentConfig } from './config.js';
import { Budget, makeTools } from './tools.js';

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
  toolCalls: number;
  durationMs: number;
  cost: number | null;
  /** Aggregate upstream provider cost; only present for BYOK requests. */
  upstreamCost: number | null;
};

const GatewayUsage = z.object({
  by_model: z.array(z.object({ total_cost: z.number() })),
});

function providerFromMeta(meta: OpenRouterMetadata | undefined): string | null {
  return meta?.endpoints?.available?.find((e) => e.selected)?.provider ?? meta?.attempts?.[0]?.provider ?? null;
}

async function fetchGeneration(client: OpenRouter, id: string) {
  for (const delayMs of [2000, 3000, 3000]) {
    await Bun.sleep(delayMs);
    try {
      return (await unwrapAsync(generationsGetGeneration(client, { id }))).data;
    } catch {
      continue;
    }
  }
  return null;
}

export async function runAgent(
  config: AgentConfig,
  input: string | ChatMessage[],
  options?: { onEvent?: (event: AgentEvent) => void; signal?: AbortSignal },
) {
  const startedAt = Date.now();
  const cacheKey = config.baseUrl ? crypto.randomUUID() : null;
  let providerFromHeaders: string | null = null;
  let upstreamCost: number | null = null;
  const requestHook: BeforeRequestHook = {
    beforeRequest: (_ctx, request) => {
      const headers = new Headers(request.headers);
      if (cacheKey) headers.set('X-LGW-Cache-Key', cacheKey);
      else headers.set('X-OpenRouter-Metadata', 'enabled');
      return new Request(request, { headers });
    },
  };
  const responseHook: AfterSuccessHook = {
    afterSuccess: (_ctx, response) => {
      providerFromHeaders = response.headers.get('x-lgw-attempt-providers')?.split(',').at(-1) ?? null;
      return response;
    },
  };
  const client = new OpenRouter({
    apiKey: config.apiKey,
    ...(config.baseUrl && { serverURL: config.baseUrl }),
    hooks: [requestHook, responseHook],
  });

  const promptChars = typeof input === 'string' ? input.length : input.reduce((n, m) => n + m.content.length, 0);
  const budget = new Budget(config.maxToolCalls, config.maxContextTokens, promptChars);

  const result = client.callModel(
    {
      model: config.model,
      instructions: config.systemPrompt,
      ...(!config.baseUrl && { provider: { order: ['groq', 'venice'], allowFallbacks: true } }),
      ...(config.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
      // loadConfig rejects effort + maxReasoningTokens together, so at most one is set here.
      ...(config.reasoningEffort && { reasoning: { effort: config.reasoningEffort } }),
      ...(config.maxReasoningTokens && { reasoning: { maxTokens: config.maxReasoningTokens } }),
      input: input as string | Item[],
      tools: makeTools(config, budget),
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
    { retryCodes: ['429', '5XX'] },
  );

  // Wire AbortSignal → result.cancel() so the underlying network stream
  // actually closes (not just the iterator we're about to walk). Also
  // handle the pre-aborted case: addEventListener('abort') does not fire
  // for signals already in the aborted state.
  const onAbort = () => result.cancel();
  options?.signal?.addEventListener('abort', onAbort);
  if (options?.signal?.aborted) result.cancel();

  // Draining getTextStream concurrently with getItemsStream reads the
  // stream dry, so getResponse().outputText ends up empty. We accumulate
  // text deltas here as a source of truth for the final text.
  let accumulatedText = '';
  let firstTokenAt: number | null = null;

  try {
    if (options?.onEvent) {
      // Run three streams concurrently: getTextStream / getReasoningStream
      // for true deltas and getItemsStream filtered to tool events. The
      // SDK's ReusableReadableStream allows concurrent consumption.
      // getItemsStream must NOT be used for reasoning text: it yields items
      // with cumulative updates (each event carries the whole summary so
      // far), which double-counts and re-prints reasoning downstream.
      const callNames = new Map<string, string>();

      const streamReasoning = async () => {
        for await (const delta of result.getReasoningStream()) {
          if (options?.signal?.aborted) break;
          firstTokenAt ??= Date.now();
          options.onEvent!({ type: 'reasoning', delta });
        }
      };

      const streamText = async () => {
        for await (const delta of result.getTextStream()) {
          if (options?.signal?.aborted) break;
          firstTokenAt ??= Date.now();
          options.onEvent!({ type: 'text', delta });
          accumulatedText += delta;
        }
      };

      const streamTools = async () => {
        for await (const item of result.getItemsStream()) {
          if (options?.signal?.aborted) break;
          if (item.type === 'function_call') {
            callNames.set(item.callId, item.name);
            if (item.status === 'completed') {
              const args = (() => { try { return item.arguments ? JSON.parse(item.arguments) : {}; } catch { return {}; } })();
              options.onEvent!({ type: 'tool_call', name: item.name, callId: item.callId, args });
            }
          } else if (item.type === 'function_call_output') {
            const out = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
            options.onEvent!({
              type: 'tool_result',
              name: callNames.get(item.callId) ?? 'unknown',
              callId: item.callId,
              output: out.length > 200 ? out.slice(0, 200) + '...' : out,
            });
            // Signal a turn boundary; consumers (e.g. CLI text mode) can
            // render a separator. Keeps presentation out of agent.ts.
            options.onEvent!({ type: 'turn_end' });
          }
        }
      };

      await Promise.all([streamText(), streamTools(), streamReasoning()]);
    }

    const response = await result.getResponse();
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
    const generation = !config.baseUrl && response.id ? await fetchGeneration(client, response.id) : null;
    const stats: RunStats = {
      provider:
        providerFromMeta(response.openrouterMetadata) ??
        providerFromHeaders ??
        generation?.providerName ??
        null,
      tokensPerSec:
        generation?.generationTime && generation.nativeTokensCompletion
          ? Math.round((generation.nativeTokensCompletion / generation.generationTime) * 1000)
          : null,
      ttftMs: firstTokenAt ? firstTokenAt - startedAt : null,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      totalTokens: totals.totalTokens,
      reasoningTokens: totals.reasoningTokens,
      toolCalls: budget.callCount,
      durationMs,
      cost: gatewayCost ?? totals.cost ?? null,
      upstreamCost: upstreamCost ?? null,
    };
    const text = accumulatedText || (response.outputText ?? '');
    options?.onEvent?.({ type: 'done', durationMs, stats });
    return { text, output: response.output, durationMs, stats };
  } finally {
    options?.signal?.removeEventListener('abort', onAbort);
  }
}

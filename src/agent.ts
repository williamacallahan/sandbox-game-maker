import { OpenRouter } from '@openrouter/agent';
import type { Item } from '@openrouter/agent';
import { generationsGetGeneration } from '@openrouter/sdk/funcs/generationsGetGeneration.js';
import { unwrapAsync } from '@openrouter/sdk/types/fp.js';
import { stepCountIs, maxCost } from '@openrouter/agent/stop-conditions';
import type { AgentConfig } from './config.js';
import { Budget, makeTools } from './tools.js';

export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; callId: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; callId: string; output: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'turn_end' }
  | { type: 'done'; usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null | undefined; durationMs: number; stats: RunStats };

/** Per-run generation metadata, shown by the UI and CLI after a run. */
export type RunStats = {
  /** Provider that served the final generation (OpenRouter /generation metadata). */
  provider: string | null;
  /** Decode speed of the final generation in tokens/second (from /generation). */
  tokensPerSec: number | null;
  /** Time to first streamed text/reasoning delta in ms; null when not streaming. */
  ttftMs: number | null;
  /** Run-wide totals aggregated across every model call. */
  totalTokens: number;
  reasoningTokens: number;
  toolCalls: number;
  durationMs: number;
  cost: number | null;
};

/**
 * Fetch OpenRouter's request/usage metadata for a generation. The record lands
 * asynchronously, typically ~5s after the response completes, so poll at
 * ~2s/5s/8s. Best-effort: failure returns null and the run reports without it.
 */
async function fetchGeneration(client: OpenRouter, id: string) {
  for (const delayMs of [2000, 3000, 3000]) {
    await new Promise((r) => setTimeout(r, delayMs));
    try {
      return (await unwrapAsync(generationsGetGeneration(client, { id }))).data;
    } catch {}
  }
  return null;
}

export async function runAgent(
  config: AgentConfig,
  input: string | ChatMessage[],
  options?: { onEvent?: (event: AgentEvent) => void; signal?: AbortSignal },
) {
  const startedAt = Date.now();
  const client = new OpenRouter({ apiKey: config.apiKey });

  const promptChars = typeof input === 'string' ? input.length : input.reduce((n, m) => n + m.content.length, 0);
  const budget = new Budget(config.maxToolCalls, config.maxContextTokens, promptChars);

  const result = client.callModel(
    {
      model: config.model,
      instructions: config.systemPrompt,
      // Route to the lowest-latency provider for the model (no load balancing).
      provider: { sort: 'latency' },
      ...(config.maxOutputTokens && { maxOutputTokens: config.maxOutputTokens }),
      // loadConfig rejects effort + maxReasoningTokens together, so at most one is set here.
      ...(config.reasoningEffort && { reasoning: { effort: config.reasoningEffort } }),
      ...(config.maxReasoningTokens && { reasoning: { maxTokens: config.maxReasoningTokens } }),
      input: input as string | Item[],
      tools: makeTools(config, budget),
      // Steps also bound tool calls loosely (each tool-bearing step has >=1 call);
      // the Budget in tools.ts enforces the exact per-call and context caps.
      stopWhen: [stepCountIs(config.maxToolCalls + 2), maxCost(config.maxCost)],
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
      // Run two streams concurrently: getTextStream for text deltas (no
      // bookkeeping required) and getItemsStream filtered to tool events.
      // The SDK's ReusableReadableStream allows concurrent consumption.
      const callNames = new Map<string, string>();

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
          } else if (item.type === 'reasoning') {
            const text = item.summary?.map((s: { text: string }) => s.text).join('') ?? '';
            if (text) {
              firstTokenAt ??= Date.now();
              options.onEvent!({ type: 'reasoning', delta: text });
            }
          }
        }
      };

      await Promise.all([streamText(), streamTools()]);
    }

    const response = await result.getResponse();
    // Aggregate across every model call in the run; response.usage covers only
    // the final one. Take durationMs before the /generation fetch below so the
    // metadata wait doesn't inflate the reported elapsed time.
    const totals = await result.getUsage();
    const durationMs = Date.now() - startedAt;
    const gen = response.id ? await fetchGeneration(client, response.id) : null;
    const stats: RunStats = {
      provider: gen?.providerName ?? null,
      tokensPerSec: gen?.generationTime && gen.nativeTokensCompletion
        ? Math.round((gen.nativeTokensCompletion / gen.generationTime) * 1000)
        : null,
      ttftMs: firstTokenAt ? firstTokenAt - startedAt : null,
      totalTokens: totals.totalTokens,
      reasoningTokens: totals.reasoningTokens,
      toolCalls: budget.callCount,
      durationMs,
      cost: totals.cost ?? null,
    };
    const text = accumulatedText || (response.outputText ?? '');
    options?.onEvent?.({ type: 'done', usage: totals, durationMs, stats });
    return { text, usage: totals, output: response.output, durationMs, stats };
  } finally {
    options?.signal?.removeEventListener('abort', onAbort);
  }
}

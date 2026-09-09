import { expect, test } from 'bun:test';
import { runAgent } from '../src/agent.js';
import { loadConfig } from '../src/config.js';

// Exercise the SDK boundary: the gateway emits summary deltas while some
// providers emit reasoning_text deltas. Missing terminal counts stay estimates.
test.each(['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].flatMap(kind => [0, 12].map(reported => ({ kind, reported }))))('counts $kind with reported=$reported', async ({ kind, reported }) => {
  const summary = 'Checking the collision order.';
  const reasoning = { type: 'reasoning', id: 'rs_test', status: 'completed', summary: [{ type: 'summary_text', text: summary }] };
  const response = { completed_at: 2, instructions: null, metadata: null, frequency_penalty: null, parallel_tool_calls: false, presence_penalty: null, temperature: null, tool_choice: 'auto', tools: [], top_p: null, id: 'resp_test', object: 'response', created_at: 1, model: 'test-model', status: 'completed', output: [reasoning], error: null, incomplete_details: null, usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: reported } } };
  const gateway = Bun.serve({ port: 0, fetch: () => {
    const events = [
      { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } },
      { type: 'response.output_item.added', output_index: 0, item: { ...reasoning, status: 'in_progress', summary: [] } },
      { type: kind, item_id: 'rs_test', output_index: 0, summary_index: 0, content_index: 0, delta: summary },
      { type: 'response.output_item.done', output_index: 0, item: reasoning },
      { type: 'response.completed', response },
    ];
    return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }});
  const seen: string[] = [];
  try {
    const config = loadConfig({ apiKey: 'test-key', baseUrl: `http://localhost:${gateway.port}/v1`, model: 'test-model' });
    const result = await runAgent(config, 'Test', { onEvent: (event) => { if (event.type === 'reasoning') seen.push(event.delta); } });
    expect(seen).toEqual([summary]);
    expect(result.stats.reasoningTokens).toBe(reported || Math.ceil(summary.length / 4));
    expect(result.stats.reasoningTokensEstimated).toBe(reported === 0);
  } finally { gateway.stop(true); }
});

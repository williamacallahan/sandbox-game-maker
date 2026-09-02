import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ReasoningEffort } from '@openrouter/sdk/models/reasoningeffort';

export function positiveNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got: ${JSON.stringify(raw)}`);
  }
  return n;
}

export type { ReasoningEffort };
/** Canonical gateway effort values, descending effort order (from the SDK enum). */
export const REASONING_EFFORTS: readonly string[] = Object.values(ReasoningEffort);

export function reasoningEffort(name: string, raw: string): ReasoningEffort {
  if (!REASONING_EFFORTS.includes(raw)) {
    throw new Error(`${name} must be one of ${REASONING_EFFORTS.join(', ')}, got: ${JSON.stringify(raw)}`);
  }
  return raw as ReasoningEffort;
}

export interface AgentConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  systemPrompt: string;
  /** Hard cap on total tool calls across the whole run. */
  maxToolCalls: number;
  /** Hard cap on context growth in tokens (prompt + tool results, ~4 chars/token estimate). */
  maxContextTokens: number;
  /** Hard cap on spend in USD. */
  maxCost: number;
  /** OpenRouter reasoning effort; unset = model default (no reasoning param sent). */
  reasoningEffort?: ReasoningEffort;
  /** Max reasoning tokens per model call (reasoning.max_tokens); unset = model default. */
  maxReasoningTokens?: number;
  /** Max output tokens per model call; unset = model default. */
  maxOutputTokens?: number;
  /** Directory games are saved into. */
  outDir: string;
}

/** Shared by both prompts: describes the one Budget mechanism in tools.ts. */
const BUDGET_RULE = '- Tool calls and context are budgeted. If a tool returns a budget-exhausted error, stop calling tools and finish with what you have.';

/** Safety, rendering, and interaction rules shared by game and create-mode prompts. */
const SHARED_GAME_RULES = [
  '- One self-contained file, zero build steps/network. Inline CSS/JS. No frameworks, CDNs, npm, web fonts, or external media.',
  '- No localStorage/sessionStorage, innerHTML/outerHTML, eval/new Function, document.write, or string-argument setTimeout/setInterval.',
  '- Fill the square (1:1) viewport exactly. Body must use `margin:0; overflow:hidden` and set `width/height` (or `min-width/min-height`) to `100vw/100vh`. Size a canvas to `window.innerWidth/Height` on load and resize. No scrollbars, no letterboxing, no fixed page dimensions.',
  '- Interactive works must register a `click`/`pointerdown`/`touchstart`/`keydown` listener (move/scroll/resize alone do not count). Buttons and controls use `click`.',
  '- Overlays must be dismissible. Any overlay div must have `data-game-overlay` and hide when `e.data?.type === "game-maker:dismiss-overlay"` inside a `message` listener.',
  '- Start on the first interaction. Do not cover the play area with titles, prompts, or instructions.',
  '- Vanilla JavaScript only.',
];

/**
 * Create Mode: the request is the subject of a creative work to build, not
 * only a game. Routes between an interactive file and a static page; both
 * stay one self-contained zero-network file saved via save_game.
 */
export const CREATE_SYSTEM_PROMPT = [
  'You build small, self-contained creative works from a single prompt.',
  '',
  'Rules:',
  '- Build the thing the request asks for, then save it. A short request is the subject ("cat" builds a cat, not a lecture).',
  '- Playable/interactive things become interactive .html files; posters, charts, reference pages, and reading material become static .html files.',
  '- When a request could be either, build the interactive one.',
  '- One self-contained file with inline CSS and vanilla JS. No build steps, no network, no frameworks, CDNs, npm installs, web fonts, or external media.',
  ...SHARED_GAME_RULES,
  '- Draw images with CSS, SVG, canvas, or data URIs.',
  '- Save with save_game using a short kebab-case filename and concise controls/objective in its instructions field.',
  '- After saving, call validate_game. If the work is interactive, do not finish until valid:true. If it is static, a missing input handler is expected; fix all other issues (external resources, non-dismissible overlay, viewport).',
  '- Before saving, self-check: first interaction starts play (interactive), no network/storage/eval, body fills viewport, and overlays are dismissible.',
  BUDGET_RULE,
  '- Reply with the saved path and one line. Nothing else.',
  '- A small complete work beats a large broken one.',
].join('\n');

export const DEFAULTS: AgentConfig = {
  apiKey: '',
  model: 'qwen/qwen3.8-flash',
  systemPrompt: [
    'You generate small, playable one-shot games from a single prompt.',
    '',
    'Rules:',
    '- Produce ONE self-contained .html file with inline CSS and vanilla JS. No build steps, no network, no frameworks, CDNs, npm installs, web fonts, or external media.',
    ...SHARED_GAME_RULES,
    '- Save with save_game using a short kebab-case filename and concise controls/objective in its instructions field. Issue independent tool calls in parallel when possible.',
    '- After saving, call validate_game on the saved path. Do not finish until valid:true. If issues remain, read the file, fix, save, and re-validate.',
    '- Before saving, self-check: first interaction starts play, no network/storage/eval, body fills viewport, and overlays are dismissible.',
    BUDGET_RULE,
    '- Reply with the saved path and one line of play instructions. Nothing else.',
    '- A small complete game beats a large broken one.',
  ].join('\n'),
  maxToolCalls: 8,
  maxContextTokens: 64_000,
  maxOutputTokens: 36_000,
  maxCost: 1.0,
  outDir: 'games',
};

export function loadConfig(overrides: Partial<AgentConfig> = {}, opts?: { skipApiKey?: boolean }): AgentConfig {
  let config = { ...DEFAULTS };

  try {
    config = { ...config, ...JSON.parse(readFileSync(resolve('agent.config.json'), 'utf-8')) };
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  config.apiKey = process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || config.apiKey;
  if (process.env.LLM_BASE_URL) config.baseUrl = process.env.LLM_BASE_URL;
  if (process.env.AGENT_MODEL) config.model = process.env.AGENT_MODEL;
  if (process.env.AGENT_MAX_TOOL_CALLS) config.maxToolCalls = positiveNumber('AGENT_MAX_TOOL_CALLS', process.env.AGENT_MAX_TOOL_CALLS);
  if (process.env.AGENT_MAX_CONTEXT_TOKENS) config.maxContextTokens = positiveNumber('AGENT_MAX_CONTEXT_TOKENS', process.env.AGENT_MAX_CONTEXT_TOKENS);
  if (process.env.AGENT_MAX_OUTPUT_TOKENS) config.maxOutputTokens = positiveNumber('AGENT_MAX_OUTPUT_TOKENS', process.env.AGENT_MAX_OUTPUT_TOKENS);
  if (process.env.AGENT_MAX_REASONING_TOKENS) config.maxReasoningTokens = positiveNumber('AGENT_MAX_REASONING_TOKENS', process.env.AGENT_MAX_REASONING_TOKENS);
  if (process.env.AGENT_MAX_COST) config.maxCost = positiveNumber('AGENT_MAX_COST', process.env.AGENT_MAX_COST);

  config = { ...config, ...overrides };
  if (config.reasoningEffort && config.maxReasoningTokens) {
    throw new Error('Set either reasoningEffort or maxReasoningTokens, not both (OpenRouter accepts one).');
  }
  if (!config.apiKey && !opts?.skipApiKey) throw new Error('LLM_API_KEY or OPENROUTER_API_KEY is required.');
  return config;
}

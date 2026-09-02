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

/**
 * Create Mode: the request is the subject of a creative work to build, not
 * only a game. Routes between an interactive file and a static page; both
 * stay one self-contained zero-network file saved via save_game.
 */
export const CREATE_SYSTEM_PROMPT = [
  'You build small, self-contained creative works from a single prompt.',
  '',
  'Rules:',
  '- Build the thing the request asks for, then save it. Always finish with a saved file, never with prose alone.',
  '- Read a short request as the subject of the thing to build. "cat" means build a cat, not answer a question about cats.',
  '- There are two ways to build it, and the request decides which:',
  '  - Something to play with — a toy, a game, a fidget, a creature, a simulation, a scene that moves or answers touch — is an interactive .html file (or a plain .js file runnable with `bun file.js` for terminal play).',
  '  - Anything else — a poster, a chart, a dashboard, a reference card, a page to read — is a static .html file.',
  '- When a request could be either, build the interactive one. It is the better medium for anything that moves.',
  '- One self-contained file that runs with zero build steps. Inline every style and script. Make no external requests of any kind: no CDN, no web fonts, no images by URL, no npm installs. The file runs with no network, so anything fetched is simply missing.',
  '- HTML files render inside a square (1:1) viewport. Fill it exactly: `body { margin: 0; overflow: hidden }`, size everything from the live viewport (100vw/100vh, or a canvas resized to window.innerWidth/innerHeight on load and resize). No scrollbars, no fixed page dimensions, no letterboxing.',
  '- Interactive works must start unobstructed. Do not leave titles, prompts, or instructions over the play area. Any optional in-game overlay must be dismissible by keyboard, pointer, and touch, use `data-game-overlay`, and hide when a `message` event receives `{ type: "game-maker:dismiss-overlay" }`.',
  '- Vanilla JavaScript only. Draw images with CSS, SVG, or canvas, or embed them as data URIs.',
  '- Save the finished work with the save_game tool using a short kebab-case filename and concise controls/objective in its instructions field.',
  BUDGET_RULE,
  '- After saving, reply with the saved path and one line telling the user how to open or play it. Nothing else.',
  '- A small complete work beats a large broken one.',
].join('\n');

const DEFAULTS: AgentConfig = {
  apiKey: '',
  model: 'qwen/qwen3.8-flash',
  systemPrompt: [
    'You generate small, playable one-shot games from a single prompt.',
    '',
    'Rules:',
    '- Produce ONE self-contained file that runs with zero build steps: an .html file with inline CSS and vanilla JS (preferred, open in any browser), or a plain .js file runnable with `bun file.js` for terminal games.',
    '- Vanilla JavaScript only. No frameworks, no npm installs, no CDN imports unless the prompt explicitly asks for one.',
    '- HTML games render inside a square (1:1) viewport. Fill it exactly: `body { margin: 0; overflow: hidden }`, size everything from the live viewport (100vw/100vh, or a canvas resized to window.innerWidth/innerHeight on load and resize). No scrollbars, no fixed page dimensions, no letterboxing.',
    '- Start gameplay unobstructed. Do not leave titles, prompts, or instructions over the play area. Any optional in-game overlay must be dismissible by keyboard, pointer, and touch, use `data-game-overlay`, and hide when a `message` event receives `{ type: "game-maker:dismiss-overlay" }`.',
    '- Save the finished game with the save_game tool using a short kebab-case filename and concise controls/objective in its instructions field. Independent tool calls (e.g. list_dir while drafting, or saving two variants) may be issued in parallel in one step.',
    BUDGET_RULE,
    '- After saving, reply with the saved path and one line of play instructions. Nothing else.',
    '- A small complete game beats a large broken one.',
  ].join('\n'),
  maxToolCalls: 8,
  maxContextTokens: 40_000,
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

  if (process.env.OPENROUTER_API_KEY) config.apiKey = process.env.OPENROUTER_API_KEY;
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
  if (!config.apiKey && !opts?.skipApiKey) throw new Error('OPENROUTER_API_KEY is required.');
  return config;
}

#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { CREATE_SYSTEM_PROMPT, DEFAULTS, loadConfig, positiveNumber, reasoningEffort, REASONING_EFFORTS, type AgentConfig } from './config.js';
import { runAgent, type AgentEvent } from './agent.js';

// Pre-scan argv for output mode so the catch below can format errors
// (unknown flag, etc.) according to --json / --quiet.
const argv = Bun.argv.slice(2);
let preMode: 'text' | 'json' | 'quiet' = 'text';
if (argv.includes('--json') || argv.includes('-j')) preMode = 'json';
else if (argv.includes('--quiet') || argv.includes('-q')) preMode = 'quiet';

function reportError(err: any): never {
  const message = err?.message ?? String(err);
  if (preMode === 'json') process.stdout.write(JSON.stringify({ type: 'error', message }) + '\n');
  else if (preMode !== 'quiet') process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}

let values: Record<string, any>;
let positionals: string[];
try {
  const parsed = parseArgs({
    args: argv,
    options: {
      prompt: { type: 'string', short: 'p' },
      create: { type: 'boolean', short: 'c', default: false },
      system: { type: 'string', short: 's' },
      json: { type: 'boolean', short: 'j', default: false },
      quiet: { type: 'boolean', short: 'q', default: false },
      model: { type: 'string', short: 'm' },
      reasoning: { type: 'string', short: 'r' },
      out: { type: 'string', short: 'o' },
      'max-tool-calls': { type: 'string' },
      'max-context-tokens': { type: 'string' },
      'max-output-tokens': { type: 'string' },
      'max-reasoning-tokens': { type: 'string' },
      'max-cost': { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  values = parsed.values;
  positionals = parsed.positionals;
  if (values.json) preMode = 'json';
  else if (values.quiet) preMode = 'quiet';
} catch (err) {
  reportError(err);
}

if (values.help) {
  console.log(`Usage: game-maker [options] [prompt]

Generates a one-shot game (self-contained .html or .js, no build step) from a
prompt, streaming the response and saving the game into the output directory.

Options:
  -p, --prompt <text>          Game prompt ("a snake game with wrap-around walls")
  -c, --create                 Create Mode: build any creative work, not only a
                               game. A short prompt is the subject ("cat" builds
                               a cat). Play-things become interactive files;
                               posters, charts, and pages become static HTML.
  -s, --system <text>          Override the built-in system prompt (wins over --create)
  -j, --json                   Output NDJSON event stream instead of text
  -q, --quiet                  No output; exit 0 on success, 1 on error
  -m, --model <model>          Override the model (default: ${DEFAULTS.model})
  -r, --reasoning <effort>     Reasoning effort: ${REASONING_EFFORTS.join('|')}
                               (default: unset, model decides)
  -o, --out <dir>              Output directory for saved games (default: ${DEFAULTS.outDir})
      --max-tool-calls <n>       Cap total tool calls (default: ${DEFAULTS.maxToolCalls})
      --max-context-tokens <n>   Cap context growth in tokens (default: ${DEFAULTS.maxContextTokens})
      --max-output-tokens <n>    Cap output tokens per model call (default: ${DEFAULTS.maxOutputTokens})
      --max-reasoning-tokens <n> Cap reasoning tokens per model call (default: ${DEFAULTS.maxReasoningTokens ?? 'model default'};
                                 mutually exclusive with --reasoning)
      --max-cost <n>             Cap spend in USD (default: ${DEFAULTS.maxCost})
  -h, --help                   Show this help message

Prompt sources (in priority order): --prompt flag, positional argument, piped stdin.

Examples:
  game-maker "a breakout clone with neon colors"
  echo "terminal number-guessing game in js" | game-maker
  game-maker --json -p "minesweeper" | jq .
  game-maker --max-tool-calls 3 --max-context-tokens 15000 -p "pong"
  game-maker --create "cat"
  game-maker --create "a poster about the solar system"
`);
  process.exit(0);
}

let prompt = values.prompt ?? positionals[0];
if (!prompt && !process.stdin.isTTY) {
  prompt = (await Bun.stdin.text()).trim();
}
if (!prompt) {
  reportError(new Error('no prompt provided. Use --prompt, a positional arg, or pipe to stdin.'));
}

let config: AgentConfig;
try {
  const overrides: Partial<AgentConfig> = {};
  if (values.create) overrides.systemPrompt = CREATE_SYSTEM_PROMPT;
  if (values.system) overrides.systemPrompt = values.system;
  if (values.model) overrides.model = values.model;
  if (values.reasoning) overrides.reasoningEffort = reasoningEffort('--reasoning', values.reasoning);
  if (values.out) overrides.outDir = values.out;
  for (const [flag, key] of [
    ['max-tool-calls', 'maxToolCalls'],
    ['max-context-tokens', 'maxContextTokens'],
    ['max-output-tokens', 'maxOutputTokens'],
    ['max-reasoning-tokens', 'maxReasoningTokens'],
    ['max-cost', 'maxCost'],
  ] as const) {
    if (values[flag]) overrides[key] = positiveNumber(`--${flag}`, values[flag]);
  }
  config = loadConfig(overrides);
} catch (err) {
  reportError(err);
}

try {
  let hasEmittedText = false;
  await runAgent(config, prompt, {
    onEvent: (event: AgentEvent) => {
      if (values.json) {
        process.stdout.write(JSON.stringify(event) + '\n');
      } else if (!values.quiet) {
        if (event.type === 'text') {
          process.stdout.write(event.delta);
          hasEmittedText = true;
        } else if (event.type === 'tool_call') {
          process.stderr.write(`[${event.name}] ${JSON.stringify({ ...event.args, content: undefined })}\n`);
        } else if (event.type === 'turn_end' && hasEmittedText) {
          process.stdout.write('\n');
        } else if (event.type === 'done') {
          const s = event.stats;
          process.stderr.write(
            `\n${s.totalTokens} tokens (${s.reasoningTokens} reasoning) · ${s.toolCalls} tool calls` +
            (s.tokensPerSec ? ` · ${s.tokensPerSec} tok/s` : '') +
            (s.ttftMs != null ? ` · ttft ${Math.round(s.ttftMs)}ms` : '') +
            ` · ${(s.durationMs / 1000).toFixed(1)}s` +
            (s.provider ? ` · via ${s.provider}` : '') + '\n',
          );
        }
      }
    },
  });
  if (!values.json && !values.quiet) process.stdout.write('\n');
  process.exit(0);
} catch (err) {
  reportError(err);
}

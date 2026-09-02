import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentConfig } from './config.js';

/** ~4 characters per token; real per-call usage arrives from the API only after the fact. */
export const CHARS_PER_TOKEN = 4;
function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Per-run budget enforcing the two hard limits: total tool calls and total
 * context tokens (prompt + every tool result, estimated at ~4 chars/token).
 * Created fresh in runAgent so limits reset per run.
 */
export class Budget {
  private calls = 0;
  private tokens: number;

  /** Tool calls the model has made this run (including budget-rejected ones). */
  get callCount(): number {
    return this.calls;
  }

  constructor(
    readonly maxCalls: number,
    readonly maxTokens: number,
    promptChars: number,
  ) {
    this.tokens = estimateTokens(promptChars);
  }

  /** Returns an error string if a limit is hit, else null. Counts the call. */
  take(): string | null {
    if (++this.calls > this.maxCalls) {
      return `Tool call limit (${this.maxCalls}) reached. Stop calling tools and finish with what you have.`;
    }
    if (this.tokens >= this.maxTokens) {
      return `Context budget (${this.maxTokens} tokens) exhausted. Stop calling tools and finish with what you have.`;
    }
    return null;
  }

  /** Charges a result against the context budget, truncating its `content` field if it overflows. */
  charge<T extends Record<string, unknown>>(result: T): T {
    const remainingChars = (this.maxTokens - this.tokens) * CHARS_PER_TOKEN;
    const size = JSON.stringify(result).length;
    if (size > remainingChars && typeof result.content === 'string') {
      const overflow = size - remainingChars;
      result = {
        ...result,
        content: result.content.slice(0, Math.max(0, result.content.length - overflow)),
        truncated: true,
        hint: 'Result truncated: context budget exhausted. Finish with what you have.',
      };
    }
    this.tokens += estimateTokens(Math.min(size, remainingChars));
    return result;
  }
}

export const GAME_FILENAME = /^[a-z0-9][a-z0-9-]*\.(html|js)$/;

/** Tools close over the run's budget, so build them per run. */
export function makeTools(config: AgentConfig, budget: Budget) {
  return [
    tool({
      name: 'save_game',
      description: `Save a finished game file into the output directory (${config.outDir}/). Filename must be kebab-case ending in .html or .js. Returns the saved path.`,
      inputSchema: z.object({
        filename: z.string().describe('Kebab-case filename, e.g. "snake.html" or "guess-number.js"'),
        content: z.string().describe('Complete, self-contained file content'),
      }),
      execute: async ({ filename, content }) => {
        const limit = budget.take();
        if (limit) return { error: limit };
        if (!GAME_FILENAME.test(filename)) {
          return budget.charge({ error: `Invalid filename ${JSON.stringify(filename)}: must match ${GAME_FILENAME}` });
        }
        mkdirSync(config.outDir, { recursive: true });
        const path = join(config.outDir, filename);
        await Bun.write(path, content);
        return budget.charge({ written: true, path });
      },
    }),

    tool({
      name: 'read_file',
      description: 'Read a previously saved game file (e.g. to iterate on it). Output capped at 2000 lines.',
      inputSchema: z.object({
        path: z.string().describe('Path to the file, e.g. "games/snake.html"'),
      }),
      execute: async ({ path }) => {
        const limit = budget.take();
        if (limit) return { error: limit };
        try {
          const lines = (await Bun.file(path).text()).split('\n');
          const slice = lines.slice(0, 2000);
          return budget.charge({
            content: slice.join('\n'),
            totalLines: lines.length,
            ...(lines.length > 2000 && { truncated: true }),
          });
        } catch (err: any) {
          return budget.charge({ error: err.code === 'ENOENT' ? `File not found: ${path}` : err.message });
        }
      },
    }),

    tool({
      name: 'list_dir',
      description: `List files in a directory (default: the output directory ${config.outDir}/), e.g. to avoid overwriting an existing game.`,
      inputSchema: z.object({
        path: z.string().optional().describe('Directory to list'),
      }),
      execute: async ({ path }) => {
        const limit = budget.take();
        if (limit) return { error: limit };
        try {
          const entries = readdirSync(path ?? config.outDir, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 500)
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
          return budget.charge({ entries });
        } catch (err: any) {
          return budget.charge({ error: err.code === 'ENOENT' ? 'Directory does not exist (nothing saved yet)' : err.message });
        }
      },
    }),
  ] as const;
}

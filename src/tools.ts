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

function isAllowedUrl(url: string): boolean {
  return url.startsWith('data:') || url === '' || url.startsWith('#');
}

function validateHtmlGame(path: string, content: string, issues: string[]) {
  // No external network requests.
  const scriptSrc = /<script[^>]*src\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = scriptSrc.exec(content)) !== null) {
    const url = m[1].trim();
    if (!isAllowedUrl(url)) issues.push(`External <script src> ${JSON.stringify(url)}: inline all JavaScript.`);
  }
  const mediaSrc = /<(?:img|video|audio|source)[^>]*\s(?:src|srcset)\s*=\s*["']([^"']+)["']/gi;
  while ((m = mediaSrc.exec(content)) !== null) {
    const url = m[1].trim();
    if (!isAllowedUrl(url)) issues.push(`External media src ${JSON.stringify(url)}: use data URIs or draw with CSS/SVG/canvas.`);
  }
  const linkHref = /<link[^>]*\shref\s*=\s*["']([^"']+)["']/gi;
  while ((m = linkHref.exec(content)) !== null) {
    const url = m[1].trim();
    if (!isAllowedUrl(url)) issues.push(`External <link href> ${JSON.stringify(url)}: inline all styles.`);
  }
  const cssUrl = /url\(\s*["']?([^"')\s]+)["']?\s*\)/gi;
  while ((m = cssUrl.exec(content)) !== null) {
    const url = m[1].trim();
    if (!isAllowedUrl(url)) issues.push(`CSS url() references external ${JSON.stringify(url)}: use data URIs or inline shapes.`);
  }
  if (/(?:^|[^\w.])fetch\s*\(/i.test(content)) issues.push('HTML calls fetch(): games must not make network requests.');
  if (/(?:^|[^\w.])XMLHttpRequest/i.test(content)) issues.push('HTML uses XMLHttpRequest: games must not make network requests.');
  if (/(?:^|[^\w.])import\s*\(\s*["']https?:/i.test(content) || /(?:^|[^\w.])import\s+["']https?:/i.test(content)) {
    issues.push('HTML imports from a remote URL: games must not make network requests.');
  }
  if (/@import\s+(?:url\s*)?\(\s*["']?https?:/i.test(content) || /@import\s+["']https?:/i.test(content)) {
    issues.push('CSS @import from a remote URL: inline all styles.');
  }
  if (/(?:^|[^\w.])localStorage\s*[.(]/i.test(content)) {
    issues.push('HTML uses localStorage: the gallery iframe is sandboxed without allow-same-origin, so storage APIs throw.');
  }
  if (/(?:^|[^\w.])sessionStorage\s*[.(]/i.test(content)) {
    issues.push('HTML uses sessionStorage: the gallery iframe is sandboxed without allow-same-origin, so storage APIs throw.');
  }
  if (/(?:^|[^\w.])(?:window|globalThis)\s*\.\s*(?:localStorage|sessionStorage)\s*[.(]/i.test(content)) {
    issues.push('HTML accesses localStorage/sessionStorage through window/globalThis: storage APIs throw in the gallery iframe.');
  }

  // Fill the square viewport.
  const bodyTag = /<body([^>]*)>/i.exec(content);
  const bodyRule = /body\s*\{([^}]*)\}/is.exec(content);
  const bodyStyle = (bodyTag?.[1] ?? '') + ' ' + (bodyRule?.[1] ?? '');
  const hasOverflowHidden = /overflow\s*:\s*hidden/i.test(bodyStyle);
  const globalRule = /\*\s*\{([^}]*)\}/is.exec(content);
  const hasMargin0 =
    /margin\s*:\s*0\b/i.test(bodyStyle) ||
    /margin\s*:\s*0\s+0/i.test(bodyStyle) ||
    /margin\s*:\s*0\b/i.test(bodyTag?.[1] ?? '') ||
    /margin\s*:\s*0\b/i.test(globalRule?.[1] ?? '');
  const hasFullWidth = /\b(?:width|min-width)\s*:\s*(?:100%|100vw|100vmin|100svw)\b/i.test(bodyStyle);
  const hasFullHeight = /\b(?:height|min-height)\s*:\s*(?:100%|100vh|100vmin|100svh)\b/i.test(bodyStyle);
  const hasViewportFill = hasFullWidth || hasFullHeight;
  const hasInnerSize = /window\.innerWidth/.test(content) && /window\.innerHeight/.test(content);
  if (!hasOverflowHidden || !hasMargin0) {
    issues.push('Body must use margin:0 and overflow:hidden so the game fills the viewport without scrollbars.');
  }
  if (!hasViewportFill && !hasInnerSize) {
    issues.push('Game must size itself from the live viewport (100vw/100vh or window.innerWidth/innerHeight).');
  }

  // Overlay must be dismissible per the platform contract.
  const hasOverlayAttr = /data-game-overlay/.test(content);
  const hasOverlayId = /\bid\s*=\s*["']overlay["']/i.test(content);
  const hasOverlayClass = /\bclass\s*=\s*["'][^"']*overlay[^"']*["']/i.test(content);
  if (hasOverlayAttr || hasOverlayId || hasOverlayClass) {
    if (!hasOverlayAttr) issues.push('Overlay found but missing data-game-overlay attribute.');
    if (!/game-maker:dismiss-overlay/.test(content)) {
      issues.push('Overlay must hide when a message event receives { type: "game-maker:dismiss-overlay" }.');
    }
    if (!/addEventListener\s*\(\s*["']message["']/i.test(content)) {
      issues.push('Overlay must have a window message listener for game-maker:dismiss-overlay.');
    }
  }

  // At least one input handler to actually play.
  const hasInput = /addEventListener\s*\(\s*["'](?:click|pointerdown|pointerup|touchstart|touchend|keydown|keyup|keypress)["']/i.test(content) ||
    /\bon(?:click|pointerdown|pointerup|touchstart|touchend|keydown|keyup|keypress)\s*=/i.test(content);
  if (!hasInput) issues.push('Game must have at least one input handler (click, pointerdown, touchstart, or keydown).');
}

function validateJsGame(path: string, content: string, issues: string[]) {
  const requireCalls = [...content.matchAll(/(?:^|[^\w.])require\s*\(\s*["']([^"']+)["']\s*\)/g)];
  for (const match of requireCalls) {
    const mod = match[1];
    if (mod !== 'readline' && mod !== 'node:readline') {
      issues.push(`Terminal game uses disallowed require("${mod}"): only "readline" is supported.`);
    }
  }

  const hasInput =
    /(?:^|[^\w.])stdin\.on\s*\(\s*["'](?:data|keypress)["']/i.test(content) ||
    /process\.stdin\.on\s*\(\s*["'](?:data|keypress)["']/i.test(content) ||
    /readline\.createInterface\s*\(/i.test(content);
  if (!hasInput) issues.push('Terminal game must read input from process.stdin or readline.');

  const hasLoop =
    /(?:^|[^\w.])setInterval\s*\(/i.test(content) ||
    /(?:^|[^\w.])setTimeout\s*\(/i.test(content) ||
    /(?:^|[^\w.])process\.exit\s*\(/i.test(content) ||
    /\bwhile\s*\(/i.test(content);
  if (!hasLoop) issues.push('Terminal game must have a game loop or clear end state (setInterval, setTimeout, while, or process.exit).');

  if (/(?:^|[^\w.])fetch\s*\(/i.test(content)) issues.push('JS game calls fetch(): terminal games must not make network requests.');
  if (/(?:^|[^\w.])XMLHttpRequest/i.test(content)) issues.push('JS game uses XMLHttpRequest: terminal games must not make network requests.');
  if (/(?:^|[^\w.])import\s*\(\s*["']https?:/i.test(content) || /(?:^|[^\w.])import\s+["']https?:/i.test(content)) {
    issues.push('JS game imports from a remote URL: terminal games must not make network requests.');
  }
}

/** Check a saved game file for playability and policy issues. */
export async function validateGameFile(path: string): Promise<{ valid: boolean; issues: string[] }> {
  const content = await Bun.file(path).text();
  const issues: string[] = [];
  if (content.trim().length === 0) {
    issues.push('File is empty.');
    return { valid: false, issues };
  }
  if (path.endsWith('.html')) {
    validateHtmlGame(path, content, issues);
  } else if (path.endsWith('.js')) {
    validateJsGame(path, content, issues);
  } else {
    issues.push('File must end in .html or .js.');
  }
  return { valid: issues.length === 0, issues };
}

/** Tools close over the run's budget, so build them per run. */
export function makeTools(config: AgentConfig, budget: Budget) {
  return [
    tool({
      name: 'save_game',
      description: `Save a finished game file into the output directory (${config.outDir}/). Filename must be lowercase kebab-case ending in .html or .js (no underscores / snake_case). Include concise player instructions for the gallery's How to play panel. Returns the saved path.`,
      inputSchema: z.object({
        filename: z.string().describe('Lowercase kebab-case filename with no underscores, e.g. "my-game.html" or "guess-number.js"'),
        content: z.string().describe('Complete, self-contained file content'),
        instructions: z.string().min(1).max(500).describe('Concise controls and objective for the player'),
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
      name: 'validate_game',
      description: 'Check a saved game for playability and policy issues (external resources, dismissible overlay, input handlers, etc.). Call this after every save_game and fix any issues before replying.',
      inputSchema: z.object({
        path: z.string().describe('Path to the saved game, e.g. "games/bunnies.html"'),
      }),
      execute: async ({ path }) => {
        const limit = budget.take();
        if (limit) return { error: limit };
        try {
          const { valid, issues } = await validateGameFile(path);
          return budget.charge({ valid, issues });
        } catch (err: any) {
          return budget.charge({ error: err.code === 'ENOENT' ? `File not found: ${path}` : err.message });
        }
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

import { tool } from '@openrouter/agent/tool';
import { z } from 'zod';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { AgentConfig } from './config.js';
import { createGameStorage, GAME_FILENAME, type GameStorage, type Post, type SavePost } from './storage.js';

export { GAME_FILENAME } from './storage.js';

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

function isAllowedUrl(url: string): boolean {
  return url.startsWith('data:') || url === '' || url.startsWith('#');
}

function validateHtmlGame(content: string, issues: string[]) {
  for (const [, attributes, source] of content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1].toLowerCase();
    if (type && !['module', 'text/javascript', 'application/javascript'].includes(type)) continue;
    try {
      new Bun.Transpiler({ loader: 'js' }).transformSync(source);
    } catch (error) {
      issues.push(`Inline JavaScript syntax error: ${errorMessage(error)}. Fix the script before saving.`);
    }
  }
  if (/(?:grid-template-(?:columns|rows)|grid-auto-(?:columns|rows))\s*:\s*(?:fr\b|repeat\(\s*fr\b)/i.test(content)) {
    issues.push('CSS grid track sizes must include a number before fr (for example 1fr), not a bare fr value.');
  }

  if (/<(?:table|div)[^>]*(?:class|id)\s*=\s*["'][^"']*table-wrapper[^"']*["']/i.test(content) &&
      /<table\b/i.test(content) && !/\.table-wrapper\s*\{[^}]*\boverflow(?:-y)?\s*:/is.test(content)) {
    issues.push('The table wrapper selector must match the HTML class and define overflow on .table-wrapper so rows remain reachable in the viewport.');
  }

  const rendersBars = /(?:className|classList\.add|class\s*=)[^\n;]{0,80}\bbar\b/i.test(content);
  if (rendersBars && !/(?:background(?:Color)?|fill)\s*[:=]/i.test(content)) {
    issues.push('Chart bars must assign an explicit background, backgroundColor, or fill so every bar is visible.');
  }

  // No external network requests.
  for (const match of content.matchAll(/<script[^>]*src\s*=\s*["']([^"']+)["']/gi)) {
    const url = match[1].trim();
    if (!isAllowedUrl(url)) issues.push(`External <script src> ${JSON.stringify(url)}: inline all JavaScript.`);
  }
  for (const match of content.matchAll(/<(?:img|video|audio|source)[^>]*\s(?:src|srcset)\s*=\s*["']([^"']+)["']/gi)) {
    const url = match[1].trim();
    if (!isAllowedUrl(url)) issues.push(`External media src ${JSON.stringify(url)}: use data URIs or draw with CSS/SVG/canvas.`);
  }
  for (const match of content.matchAll(/<link[^>]*\shref\s*=\s*["']([^"']+)["']/gi)) {
    const url = match[1].trim();
    if (!isAllowedUrl(url)) issues.push(`External <link href> ${JSON.stringify(url)}: inline all styles.`);
  }
  for (const match of content.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) {
    const url = match[1].trim();
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
  if (/\b(?:innerHTML|outerHTML)\s*(?:\+=|-=|\*=|\/=|%=|&&=|\|\|=|\?\?=|=(?!=))/i.test(content)) {
    issues.push('HTML assigns to innerHTML/outerHTML: use textContent or create DOM nodes to avoid injection sinks.');
  }
  if (/(?:^|[^\w.])eval\s*\(/i.test(content) || /(?:^|[^\w.])Function\s*\(/.test(content)) {
    issues.push('HTML uses eval()/new Function(): unsafe dynamic code execution.');
  }
  if (/(?:^|[^\w.])setTimeout\s*\(\s*["']/i.test(content) || /(?:^|[^\w.])setInterval\s*\(\s*["']/i.test(content)) {
    issues.push('HTML passes a string to setTimeout/setInterval: unsafe dynamic code execution.');
  }
  if (/(?:^|[^\w.])document\s*\.\s*write\s*\(/i.test(content)) {
    issues.push('HTML calls document.write(): unsafe DOM manipulation.');
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
  const hasInnerSize = /\b(?:window\.)?innerWidth\b/.test(content) && /\b(?:window\.)?innerHeight\b/.test(content);
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

function validateJsGame(content: string, issues: string[]) {
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
  if (/(?:^|[^\w.])eval\s*\(/i.test(content) || /(?:^|[^\w.])Function\s*\(/.test(content)) {
    issues.push('JS game uses eval()/new Function(): unsafe dynamic code execution.');
  }
  if (/(?:^|[^\w.])setTimeout\s*\(\s*["']/i.test(content) || /(?:^|[^\w.])setInterval\s*\(\s*["']/i.test(content)) {
    issues.push('JS game passes a string to setTimeout/setInterval: unsafe dynamic code execution.');
  }
}

/** Check game content for static format and policy issues. Runtime behavior needs browser verification. */
export function validateGameContent(path: string, content: string): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (content.trim().length === 0) {
    issues.push('File is empty.');
    return { valid: false, issues };
  }
  // ponytail: one-line document plus literal \n means the model re-encoded a JSON string as the file.
  if (!content.includes('\n') && content.includes('\\n')) {
    issues.push('Content is a JSON-escaped string (literal \\n and \\" sequences), not the document itself: pass the raw file text as content.');
  }
  if (path.endsWith('.html')) {
    validateHtmlGame(content, issues);
  } else if (path.endsWith('.js')) {
    validateJsGame(content, issues);
  } else {
    issues.push('File must end in .html or .js.');
  }
  return { valid: issues.length === 0, issues };
}

/** Check a local fixture file for static format and policy issues. */
export async function validateGameFile(path: string): Promise<{ valid: boolean; issues: string[] }> {
  return validateGameContent(path, await Bun.file(path).text());
}

function gameFilename(path: string, outDir: string): string {
  const output = resolve(outDir);
  const candidate = resolve(path);
  const child = relative(output, candidate);
  if (!child || child.startsWith('..') || isAbsolute(child) || dirname(child) !== '.' || !GAME_FILENAME.test(child)) {
    throw new Error(`Game path must name a saved .html or .js file inside ${outDir}/.`);
  }
  return child;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type MakeToolsOptions = {
  storage?: GameStorage;
  existingVersionId?: string;
  wantedFilename?: string;
  saveMetadata?: () => Omit<SavePost, 'instructions'>;
  onSave?: (post: Post) => void;
  overwrite?: boolean;
};

/** Kebab-case filename from free text, e.g. "A Music Player!" → "a-music-player.html". */
function slugFilename(text: string): string {
  const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return (slug.length <= 40 ? slug : slug.slice(0, 40).replace(/-[^-]*$/, '') || 'untitled') + '.html';
}

/** Tools close over the run's budget, so build them per run. */
export function makeTools(config: AgentConfig, budget: Budget, options: MakeToolsOptions = {}) {
  const storage = options.storage ?? createGameStorage(config.outDir);
  const saveMetadata = options.saveMetadata ?? (() => ({ prompt: '', model: config.model, ts: Date.now() }));
  // Names this run already saved (requested → stored), so a fix-and-resave overwrites instead of forking "-2".
  const ownNames = new Map<string, string>();
  let lastTarget: string | undefined;
  const saveContent = async (target: string, content: string, metadata: SavePost, instructions: string, overwrite: boolean, requestedName = target) => {
    const validation = validateGameContent(target, content);
    if (!validation.valid) {
      return budget.charge({ written: false, valid: false, issues: validation.issues, hint: 'Fix these issues and save again with the same filename.' });
    }
    const post = await storage.save(target, content, { ...metadata, instructions }, overwrite);
    ownNames.set(requestedName, target).set(target, target);
    lastTarget = target;
    options.onSave?.(post);
    return budget.charge({ written: true, path: `${config.outDir}/${target}`, valid: true });
  };
  return [
    tool({
      name: 'save_game',
      description: `Save a finished game file in the gallery (${config.outDir}/). Filename must be lowercase kebab-case ending in .html or .js (no underscores / snake_case). Include concise player instructions for the gallery's How to play panel. Returns the saved path plus the same validation result as validate_game.`,
      inputSchema: z.object({
        filename: z.string().optional().describe('Lowercase kebab-case filename with no underscores, e.g. "my-game.html" or "guess-number.js"'),
        content: z.string().describe('Complete, self-contained file content'),
        instructions: z.string().max(500).optional().describe('Concise controls and objective for the player'),
      }),
      execute: async ({ filename, content, instructions }) => {
        const limit = budget.take();
        if (limit) return { error: limit };
        const metadata = saveMetadata();
        // Small models sometimes drop a field; the prompt is a usable name and description.
        filename ??= lastTarget ?? slugFilename(metadata.prompt);
        instructions ||= metadata.prompt.slice(0, 500);
        if (!GAME_FILENAME.test(options.wantedFilename ?? filename)) {
          return budget.charge({ error: `Invalid filename ${JSON.stringify(filename)}: must match ${GAME_FILENAME}` });
        }
        // A requested name (new or Improve) is used as-is; a model-picked name gets a unique suffix on collision.
        const target = options.wantedFilename ?? ownNames.get(filename) ?? await storage.uniqueName(filename);
        return saveContent(target, content, metadata, instructions, options.overwrite || ownNames.has(target), filename);
      },
    }),

    tool({
      name: 'validate_game',
      description: 'Check a saved game for static format and policy issues (for example external resources, overlay wiring, and input-handler presence). It cannot prove runtime behavior; use browser testing for that. Call this after every save_game and fix any reported issues before replying.',
      inputSchema: z.object({
        path: z.string().describe('Path to the saved game, e.g. "games/bunnies.html"'),
      }),
      execute: async ({ path }) => {
        const limit = budget.take();
        if (limit) return { error: limit };
        try {
          const filename = gameFilename(path, config.outDir);
          const game = await storage.read(filename);
          const { valid, issues } = validateGameContent(filename, game.content);
          return budget.charge({ valid, issues });
        } catch (error) {
          return budget.charge({ error: errorMessage(error) });
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
          const filename = gameFilename(path, config.outDir);
          const lines = (await storage.read(filename)).content.split('\n');
          const slice = lines.slice(0, 2000);
          return budget.charge({
            content: slice.join('\n'),
            totalLines: lines.length,
            ...(lines.length > 2000 && { truncated: true }),
          });
        } catch (error) {
          return budget.charge({ error: errorMessage(error) });
        }
      },
    }),

    tool({
      name: 'list_dir',
      description: `List saved game files in the output directory (${config.outDir}/), e.g. to avoid overwriting an existing game.`,
      inputSchema: z.object({
        path: z.string().optional().describe('Directory to list'),
      }),
      execute: async ({ path }) => {
        const limit = budget.take();
        if (limit) return { error: limit };
        try {
          if (path && resolve(path) !== resolve(config.outDir)) {
            throw new Error(`list_dir can only list the configured game directory (${config.outDir}/).`);
          }
          const entries = (await storage.list())
            .map((post) => post.file)
            .filter((file): file is string => file !== null)
            .sort((a, b) => a.localeCompare(b))
            .slice(0, 500);
          return budget.charge({ entries });
        } catch (error) {
          return budget.charge({ error: errorMessage(error) });
        }
      },
    }),

    tool({
      name: 'edit_game',
      description: `Apply one exact text replacement to an existing game in ${config.outDir}/. The old_text must occur exactly once; the reconstructed file passes static validation before it overwrites the same game. This cannot prove runtime behavior; use browser testing for that.`,
      inputSchema: z.object({
        path: z.string().describe('Path to the saved game, e.g. "games/bunnies.html"'),
        old_text: z.string().min(1).describe('Non-empty text that must occur exactly once'),
        new_text: z.string().describe('Replacement text'),
      }),
      execute: async ({ path, old_text, new_text }) => {
        const limit = budget.take();
        if (limit) return { error: limit };
        try {
          if (!old_text) {
            return budget.charge({ written: false, valid: false, error: 'old_text must be non-empty; no changes were written.' });
          }
          const filename = gameFilename(path, config.outDir);
          if (options.wantedFilename && filename !== options.wantedFilename) {
            return budget.charge({ written: false, error: `Edit path ${JSON.stringify(filename)} does not match the requested filename ${JSON.stringify(options.wantedFilename)}.` });
          }
          if (!GAME_FILENAME.test(options.wantedFilename ?? filename)) {
            return budget.charge({ written: false, error: `Invalid filename ${JSON.stringify(filename)}: must match ${GAME_FILENAME}` });
          }
          const existing = await storage.read(filename, ownNames.has(filename) ? undefined : options.existingVersionId);
          const first = existing.content.indexOf(old_text);
          if (first < 0) {
            return budget.charge({ written: false, valid: false, error: `old_text was not found in ${filename}; no changes were written.` });
          }
          if (existing.content.indexOf(old_text, first + 1) >= 0) {
            return budget.charge({ written: false, valid: false, error: `old_text occurs more than once in ${filename}; provide a unique exact snippet. No changes were written.` });
          }
          const content = existing.content.slice(0, first) + new_text + existing.content.slice(first + old_text.length);
          const metadata = saveMetadata();
          const instructions = existing.post.instructions ?? metadata.prompt.slice(0, 500);
          return saveContent(filename, content, metadata, instructions, true);
        } catch (error) {
          return budget.charge({ written: false, error: errorMessage(error) });
        }
      },
    }),
  ] as const;
}

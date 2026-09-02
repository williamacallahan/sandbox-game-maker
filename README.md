# Game Maker

Generate one-shot playable games and small creative works with OpenRouter.

## Quick start

### 1. Install

```bash
bun install
```

Requires [Bun](https://bun.sh) and an OpenRouter API key.

### 2. Set the OpenRouter API key

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

Or create `agent.config.json` in the repo root with defaults:

```json
{
  "apiKey": "sk-or-...",
  "model": "qwen/qwen3.8-flash",
  "maxToolCalls": 8,
  "maxContextTokens": 64000,
  "maxOutputTokens": 36000,
  "maxCost": 1.0
}
```

Supported environment variables: `OPENROUTER_API_KEY`, `AGENT_MODEL`, `AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_CONTEXT_TOKENS`, `AGENT_MAX_OUTPUT_TOKENS`, `AGENT_MAX_REASONING_TOKENS`, `AGENT_MAX_COST`.

### 3. Run the local UI on port 3000

```bash
bun run ui
```

Open <http://localhost:3000>.

The web UI lets you edit the **user prompt**, **system prompt**, model, reasoning effort, and budget caps before generating. Generated files are saved to `games/` and added to `games/feed.json`.

If you use Doppler, the same server is also available as `bun run ui:openrouter`.

### 4. CLI

Generate from the command line:

```bash
bun run start -- "a neon snake game"
```

Watch mode (restarts on source changes):

```bash
bun run dev -- "a pong game"
```

Stream NDJSON events:

```bash
bun run start -- --json "a breakout clone" | jq .
```

Create mode for any creative work (games, posters, charts, etc.):

```bash
bun run start -- --create "a poster about the solar system"
```

CLI flags: `-m, --model`, `-s, --system`, `-r, --reasoning`, `-o, --out`, `--max-tool-calls`, `--max-context-tokens`, `--max-output-tokens`, `--max-reasoning-tokens`, `--max-cost`, `-j, --json`, `-q, --quiet`.

### 5. Edit system prompts and params

- **Default game system prompt and built-in defaults**: `src/config.ts` (`DEFAULTS`)
- **Create-mode system prompt**: `src/config.ts` (`CREATE_SYSTEM_PROMPT`)
- **Per-run overrides**: `agent.config.json`, CLI flags, or the UI fields
- **Runtime model / caps**: env vars listed above

### 6. Build and test

```bash
bun run build
bun test
```

## Project layout

- `src/agent.ts` — model calling, streaming, and token/cost metadata
- `src/cli.ts` — command-line runner
- `src/server.ts` — Bun dev server on port 3000
- `src/tools.ts` — `save_game` / `validate_game` / `read_file` tools
- `src/config.ts` — prompts, defaults, and `loadConfig`
- `src/index.html` — web UI
- `games/` — generated output (`*.html`, `*.js`, `feed.json`)

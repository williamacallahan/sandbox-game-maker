# Game Maker

Generate one-shot, self-contained HTML games and creative works from the Web UI using OpenRouter or an OpenAI-compatible Responses API.

## Web UI quick start

### 1. Install

```bash
bun install
```

Requires [Bun](https://bun.sh) and an LLM API key.

### 2. Configure the LLM

OpenRouter is the default:

```bash
export OPENROUTER_API_KEY="sk-or-..."
```

For an OpenAI-compatible Responses API:

```bash
export LLM_API_KEY="..."
export LLM_BASE_URL="https://dev.llm-gateway.iocloudhost.net/v1"
```

You can also drop defaults into `agent.config.json` in the repo root:

```json
{
  "apiKey": "...",
  "baseUrl": "https://dev.llm-gateway.iocloudhost.net/v1",
  "model": "qwen3.8-27b",
  "maxToolCalls": 8,
  "maxContextTokens": 64000,
  "maxOutputTokens": 36000,
  "maxCost": 1.0
}
```

Other env overrides: `AGENT_MODEL`, `AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_CONTEXT_TOKENS`, `AGENT_MAX_OUTPUT_TOKENS`, `AGENT_MAX_REASONING_TOKENS`, `AGENT_MAX_COST`.

### 3. Start the dev server on port 3000

```bash
bun run ui
```

Open <http://localhost:3000>.

### 4. Generate an HTML game

1. Enter your **Prompt** — e.g. *"a neon snake game with wrap-around walls"*.
2. (Optional) Expand **Settings** to change:
   - **Model** (default `qwen/qwen3.8-flash`)
   - **System Prompt** (default game rules in `src/config.ts`)
   - **Reasoning Effort** (`low`, `medium`, `high`)
   - **Max Tool Calls**, **Context Tokens**, **Output Tokens**, **Max Cost**
3. Click **Make Game**.

The agent streams the generation, calls `save_game` and `validate_game`, and writes a single self-contained `.html` file to `games/` and an entry to `games/feed.json`. Open the saved game in the feed to play it.

### 5. What gets generated

- One `.html` file with inline CSS and vanilla JS.
- No network requests, no frameworks, no CDN imports.
- A `1:1` square viewport.
- Any start overlay is dismissible and responds to `click`.

### 6. Edit system prompts and params

- **Default game system prompt + hard-coded defaults** — `src/config.ts` (`DEFAULTS`)
- **Create-mode system prompt** — `src/config.ts` (`CREATE_SYSTEM_PROMPT`)
- **Per-run overrides** — the UI fields, `agent.config.json`, or env vars

### 7. Build and test

```bash
bun run build
bun test
```

## Extra: Bun CLI

You can also drive generation from the terminal. This is the same engine with different front-ends.

```bash
# Generate a game
bun run start -- "a neon snake game"

# Watch mode
bun run dev -- "a pong game"

# NDJSON event stream
bun run start -- --json "a breakout clone" | jq .

# Create any creative work (poster, chart, toy, etc.)
bun run start -- --create "a poster about the solar system"
```

CLI flags: `-m, --model`, `-s, --system`, `-r, --reasoning`, `-o, --out`, `--max-tool-calls`, `--max-context-tokens`, `--max-output-tokens`, `--max-reasoning-tokens`, `--max-cost`, `-j, --json`, `-q, --quiet`.

## Project layout

- `src/index.html` — Web UI
- `src/server.ts` — Bun dev server on port 3000
- `src/agent.ts` — model calling, streaming, and token/cost metadata
- `src/tools.ts` — `save_game` / `validate_game` / `read_file` tools
- `src/config.ts` — prompts, defaults, and `loadConfig`
- `src/cli.ts` — command-line runner
- `games/` — generated output (`*.html`, `*.js`, `feed.json`)

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
export LLM_BASE_URL="https://api.example.com/v1"
```

Keep deployment endpoints and credentials in environment variables. You can put model and budget defaults in `agent.config.json` in the repo root:

```json
{
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

The agent streams the generation, calls `save_game` and `validate_game`, and saves a self-contained `.html` file with its prompt, settings, and player instructions. Without object storage, files stay in `games/`; configure durable storage below before running in a disposable container. Open the saved game in the feed to play it.

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

## Durable game storage

DigitalOcean Spaces stores generated game files and their feed metadata outside the app container. The web UI and CLI use the same storage. No database or additional SDK is required; the app uses Bun’s S3 client.

Configure these environment variables on the app server and any CLI that should share its gallery:

| Variable | Value |
| --- | --- |
| `GAME_STORAGE_ENDPOINT` | Regional S3 endpoint, such as `https://nyc3.digitaloceanspaces.com` |
| `GAME_STORAGE_REGION` | Spaces region, such as `nyc3` |
| `GAME_STORAGE_BUCKET` | Your private bucket name |
| `GAME_STORAGE_ACCESS_KEY_ID` | Existing Spaces access key, injected by your secret manager |
| `GAME_STORAGE_SECRET_ACCESS_KEY` | Existing Spaces secret key, injected by your secret manager |

Use the regional endpoint, not a CDN or bucket URL. Keep the bucket private. The server serves games through `/games/<filename>`; browsers never receive storage credentials. The key needs bucket listing and object read/write access. Use a separate bucket for each independent gallery.

All five variables are required together. If none are set, the app uses local files; those files require a persistent volume in a container. A partial configuration fails at startup. Once object storage is configured, failed storage requests surface as errors instead of falling back to a local-only save.

Each game and its metadata share one object under `games/`. Independent filenames can be saved concurrently without replacing a shared feed index. Saving the same filename intentionally replaces that game, as it does locally. Run statistics are stored separately so a finishing run cannot overwrite a newer game. HTML and terminal JavaScript games retain their existing URLs.

### Create a Spaces bucket from the terminal

`doctl spaces` manages access keys; bucket creation uses the S3 API. With existing Spaces credentials injected as `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, the AWS CLI can create and check a private bucket:

```bash
aws --endpoint-url https://nyc3.digitaloceanspaces.com --region us-east-1 \
  s3api create-bucket --bucket YOUR_BUCKET --acl private
aws --endpoint-url https://nyc3.digitaloceanspaces.com --region us-east-1 \
  s3api head-bucket --bucket YOUR_BUCKET
```

The endpoint selects the Spaces region. These commands require an existing key with bucket-creation permission. App object access can use an existing key scoped to the bucket. Never put secret values in command arguments or source files.

### Move existing games before replacing the server

Pause new generation and run the migration against the current server’s output directory before switching it to object storage. Supply the five `GAME_STORAGE_*` variables above through the existing secret manager:

```bash
bun run scripts/migrate-games.ts /path/to/current/games
```

The migration copies game content, instructions, and legacy feed metadata. It skips names already present in object storage and leaves source files untouched. Keep other writers stopped until it finishes, then start the app with the same storage settings. Re-running it skips previously copied games. Files already lost with an old container cannot be recovered by this migration.

### Verify storage integration

`bun test` covers local storage and configuration errors. To run the S3 integration tests, point the five storage variables at a disposable test bucket and run:

```bash
RUN_STORAGE_INTEGRATION=1 bun test test/storage.test.ts
```

The integration suite writes test games; never point it at a live gallery bucket.

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
- `src/storage.ts` — local and S3 game persistence
- `scripts/migrate-games.ts` — copy an existing local gallery to object storage
- `src/config.ts` — prompts, defaults, and `loadConfig`
- `src/cli.ts` — command-line runner
- `games/` — generated output (`*.html`, `*.js`, `feed.json`)

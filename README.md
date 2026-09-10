# Game Maker

Generate and iteratively improve self-contained HTML games and creative works from the Web UI using OpenRouter or an OpenAI-compatible Responses API.

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
    "maxToolCalls": 8,
  "maxContextTokens": 131072,
  "maxOutputTokens": 65536,
  "maxCost": 1.0
}
```

The model list in Settings comes from the configured endpoint: OpenRouter's catalog by default, or the gateway's `/v1/models` when `LLM_BASE_URL` is set.

The `*:openrouter` and `ui:llm-gateway` scripts run through `scripts/with-secrets.sh`. When `LLM_API_KEY` or `OPENROUTER_API_KEY` is already set (the deployed container), it runs the command as-is. Otherwise it injects from the Infisical project bound by the gitignored `.infisical.json`: environment `dev`, folder `/` for `OPENROUTER_API_KEY` and `/llm-gateway` for `LLM_API_KEY` and `LLM_BASE_URL`. Bind a checkout once with `infisical login` then `infisical init`; `INFISICAL_ENV` and `INFISICAL_PATH` override the defaults.

Other env overrides: `AGENT_MODEL`, `AGENT_MAX_TOOL_CALLS`, `AGENT_MAX_CONTEXT_TOKENS`, `AGENT_MAX_OUTPUT_TOKENS`, `AGENT_MAX_REASONING_TOKENS`, `AGENT_MAX_COST`.

### 3. Start the dev server on port 3000

```bash
bun run ui
```

Open <http://localhost:3000>.

### 4. Generate an HTML game

1. Enter your **Prompt** — e.g. *"a neon snake game with wrap-around walls"*.
2. (Optional) Expand **Settings** and pick a mode: **Game** (default), **Create** (any creative work), or **UI** (an app screen: dashboard, form, card). Each mode loads its own system prompt; UI also sets the model to the gateway's `oui-1` generative-UI model with its declared limits (16384 context tokens, 8192 output tokens). Then change:
   - **Model** (Qwen 3.8 Flash by default; `AGENT_MODEL` or an explicit model selection overrides the default)
   - **System Prompt** (default game rules in `src/config.ts`)
   - **Reasoning Effort** (`low`, `medium`, `high`)
   - **Max Tool Calls**, **Context Tokens**, **Output Tokens**, **Max Cost**
3. Click **Make Game**.

The agent streams the generation, calls `save_game` and `validate_game`, and saves a self-contained `.html` file with its prompt, settings, and player instructions. Each card's **Delete** removes the version shown in its history select, or the whole creation when that is the only version, after a confirmation dialog. Selecting an older version reveals **Set as current**, which copies that version to the top of the history so the feed, the player, and Improve use it; nothing is discarded. Without object storage, files stay in `games/`; configure durable storage below before running in a disposable container. The gallery shows a static placeholder; use **Play / Open** to launch the saved game in a separate tab.

### Gallery performance and game isolation

The gallery loads up to ten creations at a time and loads the next page as you scroll. Game code does not run in the gallery, including while a new creation is being generated. Use **Play / Open** to run a saved game in a separate tab; the selected version updates that link and its metadata. Details and edit settings load on request.

Game documents run with a server-enforced sandbox and cannot access the gallery, fetch network resources, create workers, or embed other pages. The terminal player allows only its pinned terminal library. A failed game can be closed without navigating away from the gallery. Browser sandboxing does not provide a hard CPU or memory quota; the browser and operating system control those limits.

`GET /api/feed` returns `{ posts, nextCursor }`, with up to ten summaries containing `file`, `prompt`, `model`, and `ts`. Pass the opaque `nextCursor` as `?cursor=...` to continue; `null` marks the end. `limit` accepts integers from 1 to 10. Full metadata remains available from `/api/post/<filename>`.

The server still scans stored records on a cold summary-cache load because creation timestamps live inside those records. Pagination bounds browser downloads and rendering; a lightweight storage index would be needed to make cold discovery independent of total gallery size.

### Completed responses and bounded edits

The model and limits shown in Settings are sent unchanged when you submit. Changing the mode applies that mode's defaults; submitting does not reset your selections. Improve retains the selected version's source and settings.

File tools execute only after a completed model response with valid tool arguments. Failed, incomplete, truncated, or cancelled responses cannot apply their pending edits. A later failed response does not undo a valid save from an earlier completed response. Tool selection is automatic, and tool executions are sequential so edits use the latest saved content.

`save_game` accepts at most 24,000 characters of source. Each `edit_game` match and replacement accepts at most 8,000 characters. Oversized calls fail without writing. Build a runnable foundation and grow it with small exact replacements; the reconstructed game can exceed those per-call limits. Every saved intermediate file must pass static validation. These are application limits, not a guarantee that a provider can generate a large replacement in one response.

### 5. What gets generated

- One `.html` file with inline CSS and vanilla JS.
- No network requests, no frameworks, no CDN imports.
- A `1:1` square viewport.
- Any start overlay is dismissible and responds to `click`.

### 6. Edit system prompts and params

- **Default game system prompt + hard-coded defaults** — `src/config.ts` (`DEFAULTS`)
- **Create-mode system prompt** — `src/config.ts` (`CREATE_SYSTEM_PROMPT`)
- **UI-mode system prompt and model limits** — `src/config.ts` (`UI_SYSTEM_PROMPT`, `UI_DEFAULTS`)
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

The migration copies game content, instructions, and legacy feed metadata. A name already present in object storage is skipped, unless its stored record has no `settings` and the local one does: then the stored game is rewritten with its own content plus those settings, so every record shares one shape. Source files are left untouched. Keep other writers stopped until it finishes, then start the app with the same storage settings. Re-running it skips previously copied games. Files already lost with an old container cannot be recovered by this migration.

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
- `src/tools.ts` — `save_game` / `edit_game` / `validate_game` / `read_file` tools
- `src/storage.ts` — local and S3 game persistence
- `scripts/migrate-games.ts` — copy an existing local gallery to object storage
- `src/config.ts` — prompts, defaults, and `loadConfig`
- `src/cli.ts` — command-line runner
- `games/` — generated output (`*.html`, `*.js`, `feed.json`)

### Iterating and verifying

Improve preserves the selected mode, original objective, and edit history. The model can use `edit_game` for a unique exact text replacement; missing or ambiguous matches and invalid reconstructed files leave the saved version unchanged.

`validate_game` checks static format and policy rules. It cannot establish playability, visual realism, or feature parity; those require browser interaction and visual review. Output allowances include reasoning and tool arguments, so exhausting them may leave no generated code. Reasoning counts derived from streamed characters are labeled as estimates; provider-reported counts remain separate from judgments of output quality.

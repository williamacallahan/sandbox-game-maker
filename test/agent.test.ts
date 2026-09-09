import { describe, expect, test } from 'bun:test';
import { Budget, validateGameContent, validateGameFile } from '../src/tools.js';
import { CREATE_SYSTEM_PROMPT, GATEWAY_DEFAULT_MODEL, UI_SYSTEM_PROMPT, loadConfig } from '../src/config.js';

describe('Budget', () => {
  test('enforces tool call limit', () => {
    const b = new Budget(2, 1000, 0);
    expect(b.take()).toBeNull();
    expect(b.take()).toBeNull();
    expect(b.take()).toContain('Tool call limit (2)');
  });

  test('enforces context token limit', () => {
    const b = new Budget(10, 50, 0);
    b.charge({ content: 'x'.repeat(400) }); // ~100 tokens > 50-token budget
    expect(b.take()).toContain('Context budget (50 tokens) exhausted');
  });

  test('prompt tokens count against the budget', () => {
    const b = new Budget(10, 25, 100); // 100 chars ≈ 25 tokens fills the budget
    expect(b.take()).toContain('Context budget');
  });

  test('truncates overflowing content and flags it', () => {
    const b = new Budget(10, 60, 0); // 60 tokens ≈ 240 chars of headroom
    const r = b.charge({ content: 'x'.repeat(500) });
    expect(r.content.length).toBeLessThan(500);
    expect((r as any).truncated).toBe(true);
  });
});

describe('loadConfig', () => {
  test('applies overrides without an API key when skipped', () => {
    const c = loadConfig({ maxToolCalls: 3 }, { skipApiKey: true });
    expect(c.maxToolCalls).toBe(3);
    expect(c.outDir).toBe('games');
  });

  test('requires unobstructed games and dismissible overlays', () => {
    const gamePrompt = loadConfig({}, { skipApiKey: true }).systemPrompt;
    for (const prompt of [gamePrompt, CREATE_SYSTEM_PROMPT, UI_SYSTEM_PROMPT]) {
      expect(prompt).toContain('game-maker:dismiss-overlay');
      expect(prompt).toContain('instructions field');
    }
  });

  test('loads a custom LLM endpoint', () => {
    const env = { key: process.env.LLM_API_KEY, url: process.env.LLM_BASE_URL };
    process.env.LLM_API_KEY = 'test-key';
    process.env.LLM_BASE_URL = 'https://gateway.example/v1';
    try {
      const config = loadConfig();
      expect(config.apiKey).toBe('test-key');
      expect(config.baseUrl).toBe('https://gateway.example/v1');
      expect(config.model).toBe(GATEWAY_DEFAULT_MODEL);
    } finally {
      if (env.key === undefined) delete process.env.LLM_API_KEY;
      else process.env.LLM_API_KEY = env.key;
      if (env.url === undefined) delete process.env.LLM_BASE_URL;
      else process.env.LLM_BASE_URL = env.url;
    }
  });

  test('throws without an API key', () => {
    const keys = { llm: process.env.LLM_API_KEY, openrouter: process.env.OPENROUTER_API_KEY };
    delete process.env.LLM_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => loadConfig()).toThrow('LLM_API_KEY or OPENROUTER_API_KEY');
    } finally {
      if (keys.llm !== undefined) process.env.LLM_API_KEY = keys.llm;
      if (keys.openrouter !== undefined) process.env.OPENROUTER_API_KEY = keys.openrouter;
    }
  });
});

describe('validateGameFile', () => {
  test('passes a valid interactive HTML game', async () => {
    const { valid, issues } = await validateGameFile('test/fixtures/good-game.html');
    expect(issues).toEqual([]);
    expect(valid).toBe(true);
  });

  test('rejects a game that references external resources', async () => {
    const { valid, issues } = await validateGameFile('test/fixtures/bad-network.html');
    expect(valid).toBe(false);
    expect(issues.some((i) => i.includes('External media'))).toBe(true);
  });

  test('rejects a game with a non-dismissible overlay', async () => {
    const { valid, issues } = await validateGameFile('test/fixtures/bad-overlay.html');
    expect(valid).toBe(false);
    expect(issues.some((i) => i.includes('data-game-overlay'))).toBe(true);
  });

  test('rejects a document saved as its JSON-escaped string', async () => {
    const raw = await Bun.file('test/fixtures/good-game.html').text();
    const escaped = JSON.stringify(raw).slice(1, -1);
    expect(validateGameContent('games/good-game.html', escaped).issues.some((i) => i.includes('JSON-escaped'))).toBe(true);
    expect(validateGameContent('games/good-game.html', raw).valid).toBe(true);
  });

  test('rejects event-dependent initialization and uncolored chart bars', () => {
    const badChart = '<body style="margin:0;width:100vw;height:100vh;overflow:hidden"><div id="chart"></div><script>function render(){const bar=document.createElement("div"); bar.className="bar"; chart.appendChild(bar)}; render(); event.target.classList.add("active")</script></body>';
    const result = validateGameContent('games/bad-chart.html', badChart);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.includes('global event target'))).toBe(true);
    expect(result.issues.some((issue) => issue.includes('Chart bars must assign'))).toBe(true);

    const coloredChart = badChart.replace('event.target.classList.add("active")', 'bar.style.backgroundColor = "#2563eb"; render()');
    const colored = validateGameContent('games/good-chart.html', coloredChart);
    expect(colored.issues.some((issue) => issue.includes('Chart bars must assign'))).toBe(false);
    expect(colored.issues.some((issue) => issue.includes('global event target'))).toBe(false);
  });

  test('rejects malformed grid tracks and mismatched table wrapper selectors', () => {
    const badLayout = '<body style="margin:0;width:100vw;height:100vh;overflow:hidden"><div class="table-wrapper"><table><tr><th>Company</th></tr></table></div><style> .grid { grid-template-columns: fr 1fr; } table-wrapper { overflow:auto; } </style><button onclick="void 0">Go</button></body>';
    const result = validateGameContent('games/bad-layout.html', badLayout);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.includes('bare fr value'))).toBe(true);
    expect(result.issues.some((issue) => issue.includes('table wrapper selector'))).toBe(true);

    const goodLayout = badLayout.replace('grid-template-columns: fr 1fr', 'grid-template-columns: 1fr 1fr').replace('table-wrapper { overflow:auto; }', '.table-wrapper { overflow:auto; }');
    expect(validateGameContent('games/good-layout.html', goodLayout).issues).toEqual([]);
  });

  test('rejects a linear road racer when the prompt requests free-range driving', () => {
    const content = '<body style="margin:0;width:100vw;height:100vh;overflow:hidden"><canvas></canvas><script>let segments=[],position=0,playerX=0; function update(){position+=1; playerX+=1} addEventListener("keydown",()=>{});</script></body>';
    const result = validateGameContent('games/drive.html', content);
    expect(result.issues.some((issue) => issue.includes('linear segment loop'))).toBe(true);
  });

  test('prompts require post-save validation', () => {
    const gamePrompt = loadConfig({}, { skipApiKey: true }).systemPrompt;
    for (const prompt of [gamePrompt, CREATE_SYSTEM_PROMPT]) {
      expect(prompt).toContain('validate_game');
    }
    // UI mode reads the validation that save_game returns instead of a second tool call.
    expect(UI_SYSTEM_PROMPT).toContain('Finish only when valid is true');
  });

  test('keeps mode-specific rendering and metadata rules in all three templates', () => {
    const gamePrompt = loadConfig({}, { skipApiKey: true }).systemPrompt;
    expect(gamePrompt).toContain('Initialize game state and the first render');
    expect(gamePrompt).toContain('visible gameplay element and meter');
    expect(CREATE_SYSTEM_PROMPT).toContain('interactive creative works');
    expect(CREATE_SYSTEM_PROMPT).toContain('save_game instructions metadata');
    expect(UI_SYSTEM_PROMPT).toContain('Render every chart on initialization');
    expect(UI_SYSTEM_PROMPT).toContain('never read the global `event` object');
    expect(UI_SYSTEM_PROMPT).toContain('min-height:0; overflow:auto');
    expect(UI_SYSTEM_PROMPT).toContain('table headers must match their cell columns');
    expect(UI_SYSTEM_PROMPT).toContain('change the underlying sample records first');
    expect(UI_SYSTEM_PROMPT).toContain('full grouping name in accessible labels');
  });
});

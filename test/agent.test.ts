import { describe, expect, test } from 'bun:test';
import { Budget, validateGameFile } from '../src/tools.js';
import { CREATE_SYSTEM_PROMPT, loadConfig } from '../src/config.js';

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
    for (const prompt of [gamePrompt, CREATE_SYSTEM_PROMPT]) {
      expect(prompt).toContain('game-maker:dismiss-overlay');
      expect(prompt).toContain('instructions field');
    }
  });

  test('throws without an API key', () => {
    const key = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => loadConfig()).toThrow('OPENROUTER_API_KEY');
    } finally {
      if (key) process.env.OPENROUTER_API_KEY = key;
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

  test('prompts require post-save validation', () => {
    const gamePrompt = loadConfig({}, { skipApiKey: true }).systemPrompt;
    for (const prompt of [gamePrompt, CREATE_SYSTEM_PROMPT]) {
      expect(prompt).toContain('validate_game');
    }
  });
});

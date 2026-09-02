import { describe, expect, test } from 'bun:test';
import { Budget } from '../src/tools.js';
import { loadConfig } from '../src/config.js';

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

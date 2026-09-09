import { describe, expect, test } from 'bun:test';
import { S3Client } from 'bun';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunStats } from '../src/agent.js';
import { loadConfig } from '../src/config.js';
import { createGameStorage, type Post, type SavePost } from '../src/storage.js';
import { Budget, makeTools, MAX_EDIT_CHARS, MAX_SAVE_CHARS } from '../src/tools.js';

async function withOutDir<T>(body: (outDir: string) => Promise<T>) {
  const outDir = await mkdtemp(join(tmpdir(), 'game-storage-'));
  try {
    return await body(outDir);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

function savePost(ts = 1, runId?: string): SavePost {
  return {
    prompt: 'make a game',
    model: 'test-model',
    ts,
    instructions: 'Use the arrow keys.',
    ...(runId && { runId }),
  };
}

function storageEnv(endpoint = 'http://127.0.0.1:1') {
  return {
    GAME_STORAGE_ENDPOINT: endpoint,
    GAME_STORAGE_REGION: 'us-east-1',
    GAME_STORAGE_BUCKET: 'game-maker-persistence-tests',
    GAME_STORAGE_ACCESS_KEY_ID: 'minioadmin',
    GAME_STORAGE_SECRET_ACCESS_KEY: 'minioadmin',
  };
}

const stats: RunStats = {
  inputTokens: 12,
  outputTokens: 34,
  totalTokens: 46,
  provider: 'test-provider',
  tokensPerSec: 56,
  ttftMs: 78,
  reasoningTokens: 9,
  toolCalls: 2,
  durationMs: 101,
  cost: 0.01,
  upstreamCost: null,
};

const playableHtml = '<body><style>body { margin: 0; overflow: hidden; width: 100vw; height: 100vh; }</style><button onclick="void 0">Play</button></body>';
const playableTerminalGame = 'process.stdin.on("data", () => {}); setInterval(() => {}, 1);';

describe('game storage', () => {
  test('persists content and metadata across a fresh local instance', async () => {
    await withOutDir(async (outDir) => {
      const filename = 'durable-game.html';
      const content = '<main>durable</main>';
      const saved = await createGameStorage(outDir, {}).save(filename, content, savePost(123));

      const resumed = createGameStorage(outDir, {});
      expect(resumed.mode).toBe('local');
      const restored = await resumed.read(filename);
      expect(restored.content).toBe(content);
      expect(restored.post).toMatchObject(saved);
      expect((await resumed.list()).find((post) => post.file === filename)).toMatchObject(saved);
    });
  });

  test('retains every concurrent save after restart', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      const games = Array.from({ length: 16 }, (_, index) => ({
        filename: `parallel-game-${index}.html`,
        content: `<main>parallel ${index}</main>`,
        post: savePost(index),
      }));

      await Promise.all(games.map(({ filename, content, post }) => storage.save(filename, content, post)));

      const resumed = createGameStorage(outDir, {});
      const posts = await resumed.list();
      expect(games.every(({ filename }) => posts.some((post) => post.file === filename))).toBe(true);
      await Promise.all(games.map(async ({ filename, content }) => {
        expect((await resumed.read(filename)).content).toBe(content);
      }));
    });
  });

  test('uses local storage only when every remote setting is absent', async () => {
    await withOutDir(async (outDir) => {
      expect(createGameStorage(outDir, {}).mode).toBe('local');
      expect(createGameStorage(outDir, storageEnv()).mode).toBe('s3');
      expect(() => createGameStorage(outDir, { GAME_STORAGE_ENDPOINT: 'http://127.0.0.1:1' })).toThrow('All five GAME_STORAGE');
    });
  });

  test('rejects invalid game identifiers at the storage boundary', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      await expect(storage.save('../outside.html', '<main/>', savePost())).rejects.toThrow('Invalid game filename');
      await expect(storage.read('../outside.html')).rejects.toThrow('Invalid game filename');
    });
  });

  test('does not fall back to local data when configured remote storage fails', async () => {
    await withOutDir(async (outDir) => {
      const local = createGameStorage(outDir, {});
      await local.save('local-only.html', '<main>local</main>', savePost());

      const unavailable = createGameStorage(outDir, storageEnv());
      await expect(unavailable.read('local-only.html')).rejects.toThrow();
      await expect(unavailable.save('failed-write.html', '<main>failed</main>', savePost())).rejects.toThrow();
      await expect(local.read('failed-write.html')).rejects.toThrow();
    });
  });

  test('merges legacy feed data once while canonical records take precedence', async () => {
    await withOutDir(async (outDir) => {
      const filename = 'legacy-game.html';
      const legacyPost: Post = { file: filename, prompt: 'legacy', model: 'legacy-model', ts: 1 };
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, filename), '<main>legacy</main>');
      await writeFile(join(outDir, 'feed.json'), JSON.stringify([legacyPost]));

      const storage = createGameStorage(outDir, {});
      expect((await storage.read(filename)).content).toBe('<main>legacy</main>');
      const saved = await storage.save(filename, '<main>canonical</main>', savePost(2));

      const resumed = createGameStorage(outDir, {});
      const matching = (await resumed.list()).filter((post) => post.file === filename);
      expect(matching).toHaveLength(1);
      expect(matching[0]).toMatchObject(saved);
      expect((await resumed.read(filename)).content).toBe('<main>canonical</main>');
    });
  });

  test('does not let a late prior-run statistic overwrite a newer save', async () => {
    await withOutDir(async (outDir) => {
      const filename = 'statistics-game.html';
      const firstRun = crypto.randomUUID();
      const newerRun = crypto.randomUUID();
      const newerStats = { ...stats, durationMs: 999 };
      const storage = createGameStorage(outDir, {});
      await storage.save(filename, '<main>first</main>', savePost(1, firstRun));
      const newer = await storage.save('statistics-game-newer.html', '<main>newer</main>', { ...savePost(2, newerRun), prompt: 'newer game' });
      await storage.saveStats(firstRun, stats);
      await storage.saveStats(newerRun, newerStats);

      const restored = await createGameStorage(outDir, {}).read('statistics-game-newer.html');
      expect(restored.content).toBe('<main>newer</main>');
      expect(restored.post).toMatchObject(newer);
      expect(restored.post.stats).toEqual(newerStats);
    });
  });

  test('removes a local game together with its exported file', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      await storage.save('gone-game.html', '<main>gone</main>', savePost(5));
      await storage.save('kept-game.html', '<main>kept</main>', savePost(6));

      expect(await storage.remove('gone-game.html')).toBe(0);
      expect(await storage.exists('gone-game.html')).toBe(false);
      await expect(storage.read('gone-game.html')).rejects.toThrow();
      expect((await storage.list()).map((post) => post.file)).toEqual(['kept-game.html']);
      await expect(storage.remove('../escape.html')).rejects.toThrow('Invalid game filename');
    });
  });

  test('rejects saving a game that already exists', async () => {
    await withOutDir(async (outDir) => {
      const filename = 'already-exists.html';
      const storage = createGameStorage(outDir, {});
      await storage.save(filename, '<main>first</main>', savePost(1));
      await expect(storage.save(filename, '<main>second</main>', savePost(2))).rejects.toThrow('already exists');

      const restored = await createGameStorage(outDir, {}).read(filename);
      expect(restored.content).toBe('<main>first</main>');
    });
  });

  test('gives a model-picked filename a unique suffix instead of overwriting or versioning', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      expect(await storage.exists('pong.html')).toBe(false);
      expect(await storage.uniqueName('pong.html')).toBe('pong.html');
      await storage.save('pong.html', '<main>first</main>', savePost(1));
      await storage.save('pong-2.html', '<main>taken</main>', savePost(2));
      expect(await storage.exists('pong.html')).toBe(true);
      expect(await storage.uniqueName('pong.html')).toBe('pong-3.html');

      const config = loadConfig({ outDir }, { skipApiKey: true });
      const [save] = makeTools(config, new Budget(4, 10_000, 0), {
        storage,
        saveMetadata: () => ({ prompt: 'again', model: 'tool-model', ts: 3 }),
      });
      expect(await save.function.execute({ filename: 'pong.html', content: playableHtml, instructions: 'Click play.' }))
        .toMatchObject({ written: true, path: join(outDir, 'pong-3.html') });
      expect((await storage.read('pong.html')).content).toBe('<main>first</main>');
      expect((await storage.read('pong-3.html')).content).toBe(playableHtml);

      // Improve keeps the requested name and overwrites in place (a new version, not a new file).
      const [improve] = makeTools(config, new Budget(4, 10_000, 0), {
        storage, wantedFilename: 'pong.html', overwrite: true,
        saveMetadata: () => ({ prompt: 'improve', model: 'tool-model', ts: 4 }),
      });
      expect(await improve.function.execute({ filename: 'whatever.html', content: playableHtml, instructions: 'Click play.' }))
        .toMatchObject({ written: true, path: join(outDir, 'pong.html') });
      expect((await storage.read('pong.html')).content).toBe(playableHtml);
      expect(await storage.exists('whatever.html')).toBe(false);
    });
  });

  test('makes every game tool use storage and applies the requested filename at save time', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      const config = loadConfig({ outDir }, { skipApiKey: true });
      const saved: Post[] = [];
      const [save, validate, read, list] = makeTools(config, new Budget(20, 10_000, 0), {
        storage,
        saveMetadata: () => ({ prompt: 'tool prompt', model: 'tool-model', ts: 123 }),
        onSave: (post) => saved.push(post),
      });
      const html = 'tool-game.html';
      const terminal = 'tool-terminal.js';

      expect(await save.function.execute({ filename: html, content: playableHtml, instructions: 'Click play.' }))
        .toMatchObject({ written: true, path: join(outDir, html) });
      expect(await save.function.execute({ filename: terminal, content: playableTerminalGame, instructions: 'Press a key.' }))
        .toMatchObject({ written: true, path: join(outDir, terminal) });
      expect(await validate.function.execute({ path: join(outDir, html) })).toMatchObject({ valid: true, issues: [] });
      expect(await validate.function.execute({ path: join(outDir, terminal) })).toMatchObject({ valid: true, issues: [] });
      expect(await read.function.execute({ path: join(outDir, html) })).toMatchObject({ content: playableHtml });
      expect(await read.function.execute({ path: join(outDir, terminal) })).toMatchObject({ content: playableTerminalGame });
      expect(await list.function.execute({})).toMatchObject({ entries: [html, terminal] });
      expect(await read.function.execute({ path: join(outDir, '..', 'outside.html') })).toMatchObject({ error: expect.stringContaining('inside') });
      expect((await storage.read(html)).post).toMatchObject({ prompt: 'tool prompt', instructions: 'Click play.' });
      expect(saved.map((post) => post.file)).toEqual([html, terminal]);

      const [saveWanted] = makeTools(config, new Budget(4, 10_000, 0), {
        storage,
        wantedFilename: 'requested-game.html',
        saveMetadata: () => ({ prompt: 'requested prompt', model: 'tool-model', ts: 124 }),
        onSave: (post) => saved.push(post),
      });
      expect(await saveWanted.function.execute({
        filename: 'model-picked.html',
        content: playableHtml,
        instructions: 'Click play.',
      })).toMatchObject({ written: true, path: join(outDir, 'requested-game.html') });
      expect((await storage.read('requested-game.html')).content).toBe(playableHtml);
      expect(saved.at(-1)).toMatchObject({ file: 'requested-game.html', prompt: 'requested prompt' });
    });
  });

  test('does not report a tool write as successful when remote persistence fails', async () => {
    await withOutDir(async (outDir) => {
      const local = createGameStorage(outDir, {});
      const config = loadConfig({ outDir }, { skipApiKey: true });
      const saved: Post[] = [];
      const [save] = makeTools(config, new Budget(4, 10_000, 0), {
        storage: createGameStorage(outDir, storageEnv()),
        onSave: (post) => saved.push(post),
      });

      await expect(save.function.execute({
        filename: 'unavailable-game.html',
        content: playableHtml,
        instructions: 'Click play.',
      })).rejects.toThrow();
      await expect(local.read('unavailable-game.html')).rejects.toThrow();
      expect(saved).toEqual([]);
    });
  });

  test('rejects invalid content before persistence', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      const config = loadConfig({ outDir }, { skipApiKey: true });
      const saved: Post[] = [];
      const [save] = makeTools(config, new Budget(4, 10_000, 0), { storage, onSave: (post) => saved.push(post) });
      const result = await save.function.execute({
        filename: 'bad-chart.html',
        content: '<body style="margin:0;width:100vw;height:100vh;overflow:hidden"><div class="bar"></div><script>event.target.classList.add("active")</script></body>',
        instructions: 'Chart',
      });
      expect(result).toMatchObject({ written: false, valid: false });
      expect(await storage.exists('bad-chart.html')).toBe(false);
      expect(saved).toEqual([]);
    });
  });

  test('bounds save_game content before storage and accepts the maximum', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      const config = loadConfig({ outDir }, { skipApiKey: true });
      const [save] = makeTools(config, new Budget(4, 10_000, 0), {
        storage,
        saveMetadata: () => ({ prompt: 'bounded save', model: 'tool-model', ts: 1 }),
      });
      const content = playableHtml + ' '.repeat(MAX_SAVE_CHARS - playableHtml.length);
      const tooLarge = `${content} `;
      const uniqueName = storage.uniqueName.bind(storage);
      let uniqueNameCalls = 0;
      storage.uniqueName = async (filename) => {
        uniqueNameCalls++;
        return uniqueName(filename);
      };

      expect(content).toHaveLength(MAX_SAVE_CHARS);
      expect(save.function.inputSchema.safeParse({ filename: 'maximum-save.html', content }).success).toBe(true);
      const rejectedSave = save.function.inputSchema.safeParse({ filename: 'oversize-save.html', content: tooLarge });
      expect(rejectedSave.success).toBe(false);
      if (rejectedSave.success) throw new Error('Expected oversized save content to fail validation.');
      expect(rejectedSave.error.issues[0]?.message).toContain('no changes written');
      expect(await save.function.execute({ filename: 'maximum-save.html', content, instructions: 'Click play.' }))
        .toMatchObject({ written: true, valid: true });
      expect(await save.function.execute({ filename: 'oversize-save.html', content: tooLarge, instructions: 'Click play.' }))
        .toMatchObject({ written: false, valid: false, error: expect.stringContaining('no changes written') });
      expect(uniqueNameCalls).toBe(1);
      expect(await storage.exists('oversize-save.html')).toBe(false);
    });
  });

  test('edit_game applies repeated exact replacements and preserves prior instructions', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      const config = loadConfig({ outDir }, { skipApiKey: true });
      const saved: Post[] = [];
      let metadataCall = 0;
      const [, , , , edit] = makeTools(config, new Budget(8, 10_000, 0), {
        storage,
        saveMetadata: () => ({ prompt: metadataCall++ === 0 ? 'initial prompt' : 'edit prompt', model: 'tool-model', ts: metadataCall }),
        onSave: (post) => saved.push(post),
      });
      const save = makeTools(config, new Budget(2, 10_000, 0), {
        storage,
        saveMetadata: () => ({ prompt: 'initial prompt', model: 'tool-model', ts: 1 }),
      })[0];
      await save.function.execute({ filename: 'editable.html', content: playableHtml, instructions: 'Keep these controls.' });

      expect(await edit.function.execute({ path: join(outDir, 'editable.html'), old_text: 'Play', new_text: 'Start' }))
        .toMatchObject({ written: true, valid: true });
      expect(await edit.function.execute({ path: join(outDir, 'editable.html'), old_text: 'Start', new_text: 'Go' }))
        .toMatchObject({ written: true, valid: true });
      const restored = await storage.read('editable.html');
      expect(restored.content).toContain('>Go</button>');
      expect(restored.post).toMatchObject({ prompt: 'edit prompt', instructions: 'Keep these controls.' });
      expect(saved).toHaveLength(2);
    });
  });

  test('edit_game leaves content and metadata unchanged for missing or ambiguous text', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      const config = loadConfig({ outDir }, { skipApiKey: true });
      const saved: Post[] = [];
      const [save, , , , edit] = makeTools(config, new Budget(8, 10_000, 0), {
        storage,
        saveMetadata: () => ({ prompt: 'stable prompt', model: 'tool-model', ts: 1 }),
        onSave: (post) => saved.push(post),
      });
      const content = playableHtml.replace('Play', 'TOKEN').replace('</button>', 'TOKEN</button>');
      await save.function.execute({ filename: 'stable.html', content, instructions: 'Stable controls.' });
      const before = await storage.read('stable.html');

      expect(await edit.function.execute({ path: join(outDir, 'stable.html'), old_text: 'missing', new_text: 'changed' }))
        .toMatchObject({ written: false, valid: false, error: expect.stringContaining('not found') });
      expect(await storage.read('stable.html')).toEqual(before);
      expect(await edit.function.execute({ path: join(outDir, 'stable.html'), old_text: 'TOKEN', new_text: 'changed' }))
        .toMatchObject({ written: false, valid: false, error: expect.stringContaining('more than once') });
      expect(await storage.read('stable.html')).toEqual(before);
      expect(saved).toHaveLength(1);
    });
  });

  test('edit_game rejects invalid reconstructions and path traversal before writing', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      const config = loadConfig({ outDir }, { skipApiKey: true });
      const saved: Post[] = [];
      const [save, , , , edit] = makeTools(config, new Budget(8, 10_000, 0), {
        storage,
        saveMetadata: () => ({ prompt: 'stable prompt', model: 'tool-model', ts: 1 }),
        onSave: (post) => saved.push(post),
      });
      await save.function.execute({ filename: 'protected.html', content: playableHtml, instructions: 'Stable controls.' });
      const before = await storage.read('protected.html');

      expect(await edit.function.execute({ path: join(outDir, 'protected.html'), old_text: 'Play', new_text: 'fetch("https://example.com")' }))
        .toMatchObject({ written: false, valid: false });
      expect(await storage.read('protected.html')).toEqual(before);
      expect(await edit.function.execute({ path: join(outDir, '..', 'outside.html'), old_text: 'Play', new_text: 'Changed' }))
        .toMatchObject({ written: false, error: expect.stringContaining('inside') });
      expect(await storage.read('protected.html')).toEqual(before);
      expect(saved).toHaveLength(1);
    });
  });

  test('bounds edit_game patches before storage and accepts the maximum', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      const config = loadConfig({ outDir }, { skipApiKey: true });
      const oldText = 'o'.repeat(MAX_EDIT_CHARS);
      const newText = 'n'.repeat(MAX_EDIT_CHARS);
      await storage.save('bounded-edit.html', playableHtml.replace('</body>', `${oldText}</body>`), savePost());
      const read = storage.read.bind(storage);
      const save = storage.save.bind(storage);
      let reads = 0;
      let writes = 0;
      storage.read = async (filename, versionId) => {
        reads++;
        return read(filename, versionId);
      };
      storage.save = async (filename, content, metadata, overwrite) => {
        writes++;
        return save(filename, content, metadata, overwrite);
      };
      const [, , , , edit] = makeTools(config, new Budget(8, 10_000, 0), {
        storage,
        saveMetadata: () => ({ prompt: 'bounded edit', model: 'tool-model', ts: 2 }),
      });
      const path = join(outDir, 'bounded-edit.html');
      const oversizedOldText = `${oldText}x`;
      const oversizedNewText = `${newText}x`;

      expect(edit.function.inputSchema.safeParse({ path, old_text: oldText, new_text: newText }).success).toBe(true);
      const rejectedOldText = edit.function.inputSchema.safeParse({ path, old_text: oversizedOldText, new_text: newText });
      const rejectedNewText = edit.function.inputSchema.safeParse({ path, old_text: newText, new_text: oversizedNewText });
      expect(rejectedOldText.success).toBe(false);
      expect(rejectedNewText.success).toBe(false);
      if (rejectedOldText.success || rejectedNewText.success) throw new Error('Expected oversized edit text to fail validation.');
      expect(rejectedOldText.error.issues[0]?.message).toContain('no changes written');
      expect(rejectedNewText.error.issues[0]?.message).toContain('no changes written');
      expect(await edit.function.execute({ path, old_text: oldText, new_text: newText })).toMatchObject({ written: true, valid: true });
      const afterExactEdit = await read('bounded-edit.html');
      const readsBeforeRejection = reads;
      const writesBeforeRejection = writes;

      expect(await edit.function.execute({ path, old_text: oversizedOldText, new_text: 'x' }))
        .toMatchObject({ written: false, valid: false, error: expect.stringContaining('smaller exact edit_game calls') });
      expect(await edit.function.execute({ path, old_text: newText, new_text: oversizedNewText }))
        .toMatchObject({ written: false, valid: false, error: expect.stringContaining('no changes written') });
      expect(reads).toBe(readsBeforeRejection);
      expect(writes).toBe(writesBeforeRejection);
      expect(await read('bounded-edit.html')).toEqual(afterExactEdit);
    });
  });

  test('edit_game keeps large saved files editable through bounded patches', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      const config = loadConfig({ outDir }, { skipApiKey: true });
      const content = `${playableHtml.replace('Play', 'First')}\n<!-- ${'x'.repeat(MAX_SAVE_CHARS)} -->`;
      await storage.save('large-edit.html', content, { ...savePost(), instructions: 'Keep these controls.' });
      const [, , , , edit] = makeTools(config, new Budget(4, 20_000, 0), {
        storage,
        saveMetadata: () => ({ prompt: 'large edit', model: 'tool-model', ts: 2 }),
      });
      const path = join(outDir, 'large-edit.html');

      expect(content.length).toBeGreaterThan(MAX_SAVE_CHARS);
      expect(await edit.function.execute({ path, old_text: 'First', new_text: 'Second' })).toMatchObject({ written: true, valid: true });
      expect(await edit.function.execute({ path, old_text: 'Second', new_text: 'Third' })).toMatchObject({ written: true, valid: true });
      const restored = await storage.read('large-edit.html');
      expect(restored.content).toContain('Third');
      expect(restored.content.length).toBeGreaterThan(MAX_SAVE_CHARS);
      expect(restored.post.instructions).toBe('Keep these controls.');
    });
  });

  test('edit_game uses historical adapter content for the first patch and current content thereafter', async () => {
    await withOutDir(async (outDir) => {
      const storage = createGameStorage(outDir, {});
      const reads: string[] = [];
      const read = storage.read.bind(storage);
      storage.read = async (filename, versionId) => {
        reads.push(versionId ?? 'current');
        const current = await read(filename);
        return versionId ? { ...current, content: playableHtml.replace('Play', 'Historical') } : current;
      };
      const config = loadConfig({ outDir }, { skipApiKey: true });
      const save = makeTools(config, new Budget(2, 10_000, 0), {
        storage,
        saveMetadata: () => ({ prompt: 'versioned prompt', model: 'tool-model', ts: 1 }),
      })[0];
      await save.function.execute({ filename: 'versioned.html', content: playableHtml, instructions: 'Keep controls.' });
      const [, , , , edit] = makeTools(config, new Budget(4, 10_000, 0), {
        storage,
        existingVersionId: 'selected-version',
        saveMetadata: () => ({ prompt: 'versioned edit', model: 'tool-model', ts: 2 }),
      });

      expect(await edit.function.execute({ path: join(outDir, 'versioned.html'), old_text: 'Historical', new_text: 'Start' }))
        .toMatchObject({ written: true, valid: true });
      expect(await edit.function.execute({ path: join(outDir, 'versioned.html'), old_text: 'Start', new_text: 'Go' }))
        .toMatchObject({ written: true, valid: true });
      expect(reads).toEqual(['selected-version', 'current']);
      expect((await read('versioned.html')).content).toBe(playableHtml.replace('Play', 'Go'));
    });
  });
});

const runStorageIntegration = process.env.RUN_STORAGE_INTEGRATION === '1';
const storageIntegration = runStorageIntegration ? test : test.skip;

storageIntegration('persists, reads, lists, and paginates records through MinIO', async () => {
  await withOutDir(async (writerOutDir) => {
    await withOutDir(async (readerOutDir) => {
      const env = storageEnv(process.env.GAME_STORAGE_ENDPOINT);
      env.GAME_STORAGE_REGION = process.env.GAME_STORAGE_REGION!;
      env.GAME_STORAGE_BUCKET = process.env.GAME_STORAGE_BUCKET!;
      env.GAME_STORAGE_ACCESS_KEY_ID = process.env.GAME_STORAGE_ACCESS_KEY_ID!;
      env.GAME_STORAGE_SECRET_ACCESS_KEY = process.env.GAME_STORAGE_SECRET_ACCESS_KEY!;
      const writer = createGameStorage(writerOutDir, env);
      const prefix = `0-minio-${crypto.randomUUID()}`;
      const html = `${prefix}-html.html`;
      const terminal = `${prefix}-terminal.js`;
      const firstRun = crypto.randomUUID();
      const newerRun = crypto.randomUUID();
      const newerStats = { ...stats, durationMs: 999 };
      const config = loadConfig({ outDir: writerOutDir }, { skipApiKey: true });
      const [save, validate, read, list] = makeTools(config, new Budget(20, 50_000, 0), {
        storage: writer,
        saveMetadata: () => ({ prompt: 'remote tool prompt', model: 'tool-model', ts: 2, runId: newerRun }),
      });

      const pages = Array.from({ length: 1001 }, (_, index) => ({
        filename: `${prefix}-page-${String(index).padStart(4, '0')}.html`,
        content: `<main>page ${index}</main>`,
        post: savePost(10_000 + index),
      }));
      const remote = new S3Client({
        endpoint: env.GAME_STORAGE_ENDPOINT, region: env.GAME_STORAGE_REGION, bucket: env.GAME_STORAGE_BUCKET,
        accessKeyId: env.GAME_STORAGE_ACCESS_KEY_ID, secretAccessKey: env.GAME_STORAGE_SECRET_ACCESS_KEY,
      });
      const keys = [html, terminal, ...pages.map((page) => page.filename)].map((file) => `games/${file}.json`);
      keys.push(`games/stats/${firstRun}.json`, `games/stats/${newerRun}.json`);
      try {
        expect(await save.function.execute({ filename: html, content: playableHtml, instructions: 'Click play.' }))
          .toMatchObject({ written: true, path: join(writerOutDir, html) });
        expect(await save.function.execute({ filename: terminal, content: playableTerminalGame, instructions: 'Press a key.' }))
          .toMatchObject({ written: true, path: join(writerOutDir, terminal) });
        expect(await validate.function.execute({ path: join(writerOutDir, html) })).toMatchObject({ valid: true, issues: [] });
        expect(await validate.function.execute({ path: join(writerOutDir, terminal) })).toMatchObject({ valid: true, issues: [] });
        expect(await read.function.execute({ path: join(writerOutDir, html) })).toMatchObject({ content: playableHtml });
        const toolListing = await list.function.execute({});
        if (!('entries' in toolListing)) throw new Error('list_dir did not return entries.');
        expect(toolListing.entries).toContain(html);
        expect(toolListing.entries).toContain(terminal);
        await writer.saveStats(firstRun, stats);
        await writer.saveStats(newerRun, newerStats);

        for (let offset = 0; offset < pages.length; offset += 32) {
          await Promise.all(pages.slice(offset, offset + 32).map(({ filename, content, post }) => writer.save(filename, content, post)));
        }

        const reader = createGameStorage(readerOutDir, env);
        const remoteHtml = await reader.read(html);
        expect(remoteHtml.content).toBe(playableHtml);
        expect(remoteHtml.post.stats).toEqual(newerStats);
        expect((await reader.read(terminal)).content).toContain('process.stdin');
        const listed = new Set((await reader.list()).map((post) => post.file));
        expect(listed.has(html)).toBe(true);
        expect(listed.has(terminal)).toBe(true);
        expect(pages.every(({ filename }) => listed.has(filename))).toBe(true);
      } finally {
        for (let offset = 0; offset < keys.length; offset += 32) {
          await Promise.all(keys.slice(offset, offset + 32).map((key) => remote.delete(key)));
        }
      }
    });
  });
}, 60_000);

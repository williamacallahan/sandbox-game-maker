#!/usr/bin/env bun
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createGameStorage } from '../src/storage.js';

const source = Bun.argv[2];
if (!source || Bun.argv.length !== 3) {
  throw new Error('Usage: bun run scripts/migrate-games.ts /path/to/games (pause other writers first)');
}
if (!(await stat(source)).isDirectory()) throw new Error('Source must be an existing games directory.');
const temporary = await mkdtemp(join(tmpdir(), 'game-maker-migration-'));
try {
  const destination = createGameStorage(temporary);
  if (destination.mode !== 's3') throw new Error('Configure all GAME_STORAGE_* variables before migrating.');
  const local = createGameStorage(resolve(source), {});
  const existing = new Set((await destination.list()).map((post) => post.file));
  let copied = 0;
  let skipped = 0;
  for (const post of await local.list()) {
    if (!post.file) continue;
    if (existing.has(post.file)) {
      skipped++;
      continue;
    }
    const game = await local.read(post.file);
    await destination.save(post.file, game.content, game.post);
    copied++;
  }
  console.log(`Migration complete: ${copied} copied, ${skipped} already stored. Source files unchanged.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

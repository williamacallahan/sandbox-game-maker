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
  const existing = new Map((await destination.list()).map((post) => [post.file, post]));
  let copied = 0;
  let backfilled = 0;
  let skipped = 0;
  for (const post of await local.list()) {
    if (!post.file) continue;
    const stored = existing.get(post.file);
    if (stored?.settings || (stored && !post.settings)) {
      skipped++;
      continue;
    }
    // A stored game without settings (saved before they were recorded) is rewritten with the same content
    // plus the local settings, so every record shares one shape.
    const game = stored ? await destination.read(post.file) : await local.read(post.file);
    const { stats, ...metadata } = game.post; // stats live in their own object, never inside the record
    await destination.save(post.file, game.content, { ...metadata, settings: post.settings }, Boolean(stored));
    if (stored) backfilled++; else copied++;
  }
  console.log(`Migration complete: ${copied} copied, ${backfilled} backfilled with settings, ${skipped} already stored. Source files unchanged.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

import { S3Client } from 'bun';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentConfig } from './config.js';
import type { RunStats } from './agent.js';

export const GAME_FILENAME = /^[a-z0-9][a-z0-9-]*\.(html|js)$/;

export type Post = {
  file: string | null;
  prompt: string;
  model: string;
  ts: number;
  instructions?: string;
  settings?: Pick<AgentConfig, 'model' | 'reasoningEffort' | 'maxToolCalls' | 'maxContextTokens' | 'maxOutputTokens' | 'maxReasoningTokens' | 'maxCost' | 'systemPrompt'>;
  stats?: RunStats | null;
};
type Record = { content: string; post: Post; statsRunId?: string };
export type SavePost = Omit<Post, 'file'> & { runId?: string };

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'NoSuchKey');
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

async function atomicWrite(path: string, content: string) {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function createGameStorage(outDir: string, env: NodeJS.ProcessEnv = process.env) {
  const values = [env.GAME_STORAGE_ENDPOINT, env.GAME_STORAGE_REGION, env.GAME_STORAGE_BUCKET,
    env.GAME_STORAGE_ACCESS_KEY_ID, env.GAME_STORAGE_SECRET_ACCESS_KEY];
  const configured = values.some((value) => value !== undefined);
  if (configured && values.some((value) => !value?.trim())) throw new Error('All five GAME_STORAGE_* variables are required together.');
  if (configured) {
    const url = new URL(env.GAME_STORAGE_ENDPOINT!);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('GAME_STORAGE_ENDPOINT must be an HTTP(S) service endpoint without a path or credentials.');
    }
  }
  const remote = configured ? new S3Client({
    endpoint: env.GAME_STORAGE_ENDPOINT, region: env.GAME_STORAGE_REGION, bucket: env.GAME_STORAGE_BUCKET,
    accessKeyId: env.GAME_STORAGE_ACCESS_KEY_ID, secretAccessKey: env.GAME_STORAGE_SECRET_ACCESS_KEY,
  }) : null;
  const recordsDir = join(outDir, '.records');

  async function readFeed(): Promise<Post[]> {
    let feed: Post[] = [];
    try { feed = JSON.parse(await readFile(join(outDir, 'feed.json'), 'utf8')); }
    catch (error) { if (!missing(error)) throw error; }
    return feed;
  }

  async function legacy(filename: string, getFeed = readFeed): Promise<Record> {
    const path = join(outDir, filename);
    const [content, info, feed] = await Promise.all([readFile(path, 'utf8'), stat(path), getFeed()]);
    return { content, post: feed.find((post) => post.file === filename) ?? { file: filename, prompt: '', model: '', ts: info.mtimeMs } };
  }

  async function readRecord(filename: string, getFeed = readFeed): Promise<Record> {
    if (!GAME_FILENAME.test(filename)) throw new Error('Invalid game filename.');
    let record: Record;
    try {
      record = remote
        ? await remote.file(`games/${filename}.json`).json()
        : JSON.parse(await readFile(join(recordsDir, `${filename}.json`), 'utf8'));
    } catch (error) {
      if (!missing(error)) throw error;
      return legacy(filename, getFeed);
    }
    if (typeof record.content !== 'string' || record.post?.file !== filename || typeof record.post.prompt !== 'string' || typeof record.post.model !== 'string' || !Number.isFinite(record.post.ts)) {
      throw new Error('Invalid stored game record.');
    }
    return record;
  }

  async function readStats(runId: string): Promise<RunStats | null> {
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid stored run identifier.');
    try {
      return remote ? await remote.file(`games/stats/${runId}.json`).json()
        : JSON.parse(await readFile(join(recordsDir, 'stats', `${runId}.json`), 'utf8'));
    } catch (error) { if (missing(error)) return null; throw error; }
  }

  return {
    mode: remote ? 's3' as const : 'local' as const,
    async save(filename: string, content: string, metadata: SavePost): Promise<Post> {
      if (!GAME_FILENAME.test(filename)) throw new Error('Invalid game filename.');
      const { runId, ...fields } = metadata;
      const post: Post = { ...fields, file: filename };
      const record: Record = { content, post, ...(runId && { statsRunId: runId }) };
      const recordPath = join(recordsDir, `${filename}.json`);
      // ponytail: check-then-write race is acceptable here; concurrent saves of
      // the same filename are a caller-level collision, not a normal path.
      if (remote) {
        const key = `games/${filename}.json`;
        if (await remote.file(key).exists()) throw new Error(`Game ${JSON.stringify(filename)} already exists.`);
        await remote.write(key, JSON.stringify(record), { type: 'application/json' });
      } else {
        await mkdir(recordsDir, { recursive: true });
        if (await exists(recordPath)) throw new Error(`Game ${JSON.stringify(filename)} already exists.`);
        await atomicWrite(recordPath, JSON.stringify(record));
      }
      // The record owns reads; this export keeps local CLI output convenient.
      try {
        await mkdir(outDir, { recursive: true });
        await atomicWrite(join(outDir, filename), content);
      } catch { console.warn('Game saved, but its local file export failed.'); }
      return post;
    },
    async read(filename: string): Promise<{ content: string; post: Post }> {
      const record = await readRecord(filename);
      if (record.statsRunId) record.post.stats = await readStats(record.statsRunId);
      return { content: record.content, post: record.post };
    },
    async list(): Promise<Post[]> {
      const names = new Set<string>();
      for (const [directory, suffix] of [[outDir, ''], [recordsDir, '.json']] as const) {
        try {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const filename = suffix && entry.name.endsWith(suffix) ? entry.name.slice(0, -suffix.length) : entry.name;
            if (entry.isFile() && GAME_FILENAME.test(filename)) names.add(filename);
          }
        } catch (error) { if (!missing(error)) throw error; }
      }
      if (remote) {
        let continuationToken: string | undefined;
        do {
          const page = await remote.list({ prefix: 'games/', continuationToken });
          for (const item of page.contents ?? []) {
            const filename = item.key.slice('games/'.length, -'.json'.length);
            if (item.key.endsWith('.json') && GAME_FILENAME.test(filename)) names.add(filename);
          }
          continuationToken = page.isTruncated ? page.nextContinuationToken : undefined;
          if (page.isTruncated && !continuationToken) throw new Error('Storage returned an incomplete listing without a continuation token.');
        } while (continuationToken);
      }
      const stats = new Map<string, Promise<RunStats | null>>();
      const posts: Post[] = [];
      const filenames = [...names];
      let legacyFeed: Promise<Post[]> | undefined;
      // Bound storage requests while retaining the gallery's complete listing.
      for (let offset = 0; offset < filenames.length; offset += 16) {
        posts.push(...await Promise.all(filenames.slice(offset, offset + 16).map(async (filename) => {
          const record = await readRecord(filename, () => legacyFeed ??= readFeed());
          if (record.statsRunId) {
            if (!stats.has(record.statsRunId)) stats.set(record.statsRunId, readStats(record.statsRunId));
            record.post.stats = await stats.get(record.statsRunId)!;
          }
          return record.post;
        })));
      }
      return posts.sort((a, b) => b.ts - a.ts);
    },
    async saveStats(runId: string, stats: RunStats): Promise<void> {
      if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid run identifier.');
      if (remote) await remote.write(`games/stats/${runId}.json`, JSON.stringify(stats), { type: 'application/json' });
      else {
        await mkdir(join(recordsDir, 'stats'), { recursive: true });
        await atomicWrite(join(recordsDir, 'stats', `${runId}.json`), JSON.stringify(stats));
      }
    },
  };
}
export type GameStorage = ReturnType<typeof createGameStorage>;

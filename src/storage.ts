import { S3Client } from 'bun';
import { S3Client as AwsS3Client, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { Buffer } from 'node:buffer';
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
export type GameVersion = { versionId: string; lastModified: Date; isLatest: boolean; eTag: string };
export type FeedPost = { file: string; prompt: string; model: string; ts: number; unavailable?: true };
export type FeedPage = { posts: FeedPost[]; nextCursor: string | null };
export type FeedPageOptions = { limit?: number; cursor?: string };

export const FEED_PAGE_SIZE = 10;
const FEED_CURSOR_MAX_LENGTH = 256;
const FEED_PROMPT_MAX_LENGTH = 500;
const FEED_MODEL_MAX_LENGTH = 200;
const FEED_CACHE_TTL_MS = 15_000;

export class FeedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedRequestError';
  }
}

export function parseFeedLimit(value: string): number {
  if (!/^(?:[1-9]|10)$/.test(value)) throw new FeedRequestError('limit must be an integer from 1 to 10.');
  return Number(value);
}

export function encodeFeedCursor(post: Pick<FeedPost, 'ts' | 'file'>): string {
  return Buffer.from(JSON.stringify({ ts: post.ts, file: post.file }), 'utf8').toString('base64url');
}

export function decodeFeedCursor(value: string | undefined): { ts: number; file: string } | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > FEED_CURSOR_MAX_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new FeedRequestError('cursor is invalid.');
  }
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.toString('base64url') !== value) throw new Error('non-canonical cursor');
    const parsed: unknown = JSON.parse(decoded.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('cursor payload is not an object');
    const candidate = parsed as { ts?: unknown; file?: unknown };
    if (typeof candidate.ts !== 'number' || !Number.isFinite(candidate.ts) || typeof candidate.file !== 'string' || !GAME_FILENAME.test(candidate.file)) {
      throw new Error('cursor payload is invalid');
    }
    return { ts: candidate.ts, file: candidate.file };
  } catch {
    throw new FeedRequestError('cursor is invalid.');
  }
}

function compareFeedPosts(a: FeedPost, b: FeedPost): number {
  return a.ts !== b.ts ? b.ts - a.ts : a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

export function paginateFeed(posts: FeedPost[], options: FeedPageOptions = {}): FeedPage {
  const limit = options.limit ?? FEED_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > FEED_PAGE_SIZE) {
    throw new FeedRequestError(`limit must be an integer from 1 to ${FEED_PAGE_SIZE}.`);
  }
  const cursor = decodeFeedCursor(options.cursor);
  const ordered = [...posts].sort(compareFeedPosts);
  const eligible = cursor
    ? ordered.filter((post) => post.ts < cursor.ts || (post.ts === cursor.ts && post.file > cursor.file))
    : ordered;
  const page = eligible.slice(0, limit);
  return {
    posts: page.map((post) => ({ ...post })),
    nextCursor: eligible.length > limit && page.length ? encodeFeedCursor(page.at(-1)!) : null,
  };
}

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'NoSuchKey');
}

class UnavailableSummaryError extends Error {
  constructor() {
    super('Unavailable game summary.');
    this.name = 'UnavailableSummaryError';
  }
}

function isPostForFile(value: unknown, filename: string): value is Post & { file: string } {
  if (typeof value !== 'object' || value === null) return false;
  const post = value as { file?: unknown; prompt?: unknown; model?: unknown; ts?: unknown };
  return post.file === filename && typeof post.prompt === 'string' && typeof post.model === 'string' && typeof post.ts === 'number' && Number.isFinite(post.ts);
}

function summarizePost(post: Post & { file: string }): FeedPost {
  return {
    file: post.file,
    prompt: post.prompt.slice(0, FEED_PROMPT_MAX_LENGTH),
    model: post.model.slice(0, FEED_MODEL_MAX_LENGTH),
    ts: post.ts,
  };
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
  const awsClient = configured ? new AwsS3Client({
    endpoint: env.GAME_STORAGE_ENDPOINT,
    region: env.GAME_STORAGE_REGION,
    credentials: {
      accessKeyId: env.GAME_STORAGE_ACCESS_KEY_ID!,
      secretAccessKey: env.GAME_STORAGE_SECRET_ACCESS_KEY!,
    },
  }) : null;
  const recordsDir = join(outDir, '.records');
  let summaryGeneration = 0;
  let summaryCache: { generation: number; expiresAt: number; posts: FeedPost[] } | null = null;
  let summaryFlight: { generation: number; promise: Promise<FeedPost[]> } | null = null;

  function invalidateSummaryCache() {
    summaryGeneration++;
    summaryCache = null;
  }

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

  async function legacySummary(filename: string, getFeed = readFeed): Promise<FeedPost> {
    const [info, feed] = await Promise.all([stat(join(outDir, filename)), getFeed()]);
    if (!Array.isArray(feed)) throw new UnavailableSummaryError();
    const post = feed.find((candidate) => candidate.file === filename);
    if (!post) return { file: filename, prompt: '', model: '', ts: info.mtimeMs };
    if (!isPostForFile(post, filename)) throw new UnavailableSummaryError();
    return summarizePost(post);
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

  async function readSummaryRecord(filename: string, getFeed = readFeed): Promise<FeedPost> {
    if (!GAME_FILENAME.test(filename)) throw new Error('Invalid game filename.');
    let raw: unknown;
    try {
      raw = remote
        ? await remote.file(`games/${filename}.json`).json()
        : JSON.parse(await readFile(join(recordsDir, `${filename}.json`), 'utf8'));
    } catch (error) {
      if (missing(error)) return legacySummary(filename, getFeed);
      if (error instanceof SyntaxError) throw new UnavailableSummaryError();
      throw error;
    }
    if (typeof raw !== 'object' || raw === null) throw new UnavailableSummaryError();
    const candidate = raw as { content?: unknown; post?: unknown };
    if (typeof candidate.content !== 'string' || !isPostForFile(candidate.post, filename)) throw new UnavailableSummaryError();
    return summarizePost(candidate.post);
  }

  async function unavailableSummary(filename: string): Promise<FeedPost> {
    let ts = 0;
    if (!remote) {
      for (const path of [join(recordsDir, `${filename}.json`), join(outDir, filename)]) {
        try {
          ts = (await stat(path)).mtimeMs;
          break;
        } catch (error) {
          if (!missing(error)) throw error;
        }
      }
    }
    return { file: filename, prompt: 'Unavailable game', model: '', ts, unavailable: true };
  }

  async function readSummary(filename: string, getFeed: () => Promise<Post[]>): Promise<FeedPost> {
    try {
      return await readSummaryRecord(filename, getFeed);
    } catch (error) {
      if (error instanceof UnavailableSummaryError || missing(error) || error instanceof SyntaxError) {
        return unavailableSummary(filename);
      }
      throw error;
    }
  }

  async function readVersionRecord(filename: string, versionId: string): Promise<Record> {
    if (!GAME_FILENAME.test(filename)) throw new Error('Invalid game filename.');
    if (!awsClient) throw new Error('Versioned reads require S3 storage.');
    const key = `games/${filename}.json`;
    const response = await awsClient.send(new GetObjectCommand({
      Bucket: env.GAME_STORAGE_BUCKET!,
      Key: key,
      VersionId: versionId,
    }));
    const body = await response.Body?.transformToString();
    if (!body) throw new Error('Version not found.');
    const record: Record = JSON.parse(body);
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
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
  }

  async function listVersions(filename: string): Promise<GameVersion[]> {
    if (!GAME_FILENAME.test(filename)) throw new Error('Invalid game filename.');
    if (!awsClient) return [];
    const key = `games/${filename}.json`;
    const versions: GameVersion[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    do {
      const response = await awsClient.send(new ListObjectVersionsCommand({
        Bucket: env.GAME_STORAGE_BUCKET!,
        Prefix: key,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }));
      for (const v of response.Versions ?? []) {
        if (v.Key === key && v.VersionId && v.LastModified && v.ETag) {
          versions.push({
            versionId: v.VersionId,
            lastModified: v.LastModified,
            isLatest: v.IsLatest ?? false,
            eTag: v.ETag.replace(/^"|"$/g, ''),
          });
        }
      }
      keyMarker = response.NextKeyMarker;
      versionIdMarker = response.NextVersionIdMarker;
    } while (keyMarker || versionIdMarker);
    return versions.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }

  async function gameExists(filename: string): Promise<boolean> {
    return remote ? remote.file(`games/${filename}.json`).exists() : exists(join(recordsDir, `${filename}.json`));
  }

  async function discoverNames(): Promise<Set<string>> {
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
    return names;
  }

  async function scanSummaries(): Promise<FeedPost[]> {
    const filenames = [...await discoverNames()];
    const posts: FeedPost[] = [];
    let legacyFeed: Promise<Post[]> | undefined;
    // ponytail: current records keep ts inside each JSON object, so a cold scan is O(records); an index requires a schema migration.
    for (let offset = 0; offset < filenames.length; offset += 4) {
      posts.push(...await Promise.all(filenames.slice(offset, offset + 4).map((filename) =>
        readSummary(filename, () => legacyFeed ??= readFeed()))));
    }
    return posts.sort(compareFeedPosts);
  }

  async function cachedSummaries(): Promise<FeedPost[]> {
    const now = Date.now();
    if (summaryCache && summaryCache.expiresAt > now) return summaryCache.posts;
    const generation = summaryGeneration;
    if (summaryFlight?.generation === generation) return summaryFlight.promise;
    let promise: Promise<FeedPost[]>;
    promise = scanSummaries().then((posts) => {
      if (summaryGeneration === generation) summaryCache = { generation, expiresAt: Date.now() + FEED_CACHE_TTL_MS, posts };
      return posts;
    }).finally(() => {
      if (summaryFlight?.generation === generation && summaryFlight.promise === promise) summaryFlight = null;
    });
    summaryFlight = { generation, promise };
    return promise;
  }

  return {
    mode: remote ? 's3' as const : 'local' as const,
    exists: gameExists,
    /** First free name among filename, name-2.ext, name-3.ext, … A new game never overwrites or versions an existing one. */
    async uniqueName(filename: string): Promise<string> {
      if (!GAME_FILENAME.test(filename)) throw new Error('Invalid game filename.');
      const dot = filename.lastIndexOf('.');
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? filename : `${filename.slice(0, dot)}-${n}${filename.slice(dot)}`;
        if (!await gameExists(candidate)) return candidate;
      }
    },
    async save(filename: string, content: string, metadata: SavePost, overwrite = false): Promise<Post> {
      if (!GAME_FILENAME.test(filename)) throw new Error('Invalid game filename.');
      const { runId, ...fields } = metadata;
      const post: Post = { ...fields, file: filename };
      const record: Record = { content, post, ...(runId && { statsRunId: runId }) };
      const recordPath = join(recordsDir, `${filename}.json`);
      // ponytail: check-then-write race is acceptable here; concurrent saves of
      // the same filename are a caller-level collision, not a normal path.
      if (!overwrite && await gameExists(filename)) throw new Error(`Game ${JSON.stringify(filename)} already exists.`);
      if (remote) await remote.write(`games/${filename}.json`, JSON.stringify(record), { type: 'application/json' });
      else {
        await mkdir(recordsDir, { recursive: true });
        await atomicWrite(recordPath, JSON.stringify(record));
      }
      invalidateSummaryCache();
      // The record owns reads; this export keeps local CLI output convenient.
      try {
        await mkdir(outDir, { recursive: true });
        await atomicWrite(join(outDir, filename), content);
      } catch { console.warn('Game saved, but its local file export failed.'); }
      return post;
    },
    async read(filename: string, versionId?: string): Promise<{ content: string; post: Post }> {
      const record = versionId ? await readVersionRecord(filename, versionId) : await readRecord(filename);
      if (record.statsRunId) record.post.stats = await readStats(record.statsRunId);
      return { content: record.content, post: record.post };
    },
    async list(): Promise<Post[]> {
      const names = await discoverNames();
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
    async listSummaries(): Promise<FeedPost[]> {
      return (await cachedSummaries()).map((post) => ({ ...post }));
    },
    async listFeed(options: FeedPageOptions = {}): Promise<FeedPage> {
      return paginateFeed(await cachedSummaries(), options);
    },
    async saveStats(runId: string, stats: RunStats): Promise<void> {
      if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('Invalid run identifier.');
      if (remote) await remote.write(`games/stats/${runId}.json`, JSON.stringify(stats), { type: 'application/json' });
      else {
        await mkdir(join(recordsDir, 'stats'), { recursive: true });
        await atomicWrite(join(recordsDir, 'stats', `${runId}.json`), JSON.stringify(stats));
      }
    },
    versions: listVersions,
    /**
     * Make one stored version the current one: it is copied over the key as the newest version, which is what the
     * feed, the player, and Improve read. History keeps every version, so the previous current one stays selectable.
     */
    async promote(filename: string, versionId: string): Promise<void> {
      if (!GAME_FILENAME.test(filename)) throw new Error('Invalid game filename.');
      if (!awsClient) throw new Error('Versioned writes require S3 storage.');
      invalidateSummaryCache();
      const key = `games/${filename}.json`;
      await awsClient.send(new CopyObjectCommand({
        Bucket: env.GAME_STORAGE_BUCKET!,
        Key: key,
        CopySource: `${env.GAME_STORAGE_BUCKET}/${key}?versionId=${encodeURIComponent(versionId)}`,
        MetadataDirective: 'COPY',
      }));
    },
    /**
     * Permanently delete one stored version, or every version when none is named.
     * Returns how many versions remain; 0 means the game is gone. Local storage keeps one version per game.
     */
    async remove(filename: string, versionId?: string): Promise<number> {
      if (!GAME_FILENAME.test(filename)) throw new Error('Invalid game filename.');
      invalidateSummaryCache();
      let remaining = 0;
      if (awsClient) {
        const key = `games/${filename}.json`;
        const targets = versionId ? [versionId] : (await listVersions(filename)).map((v) => v.versionId);
        for (const VersionId of targets) {
          await awsClient.send(new DeleteObjectCommand({ Bucket: env.GAME_STORAGE_BUCKET!, Key: key, VersionId }));
        }
        remaining = (await listVersions(filename)).length;
      } else {
        await rm(join(recordsDir, `${filename}.json`), { force: true });
      }
      if (remaining === 0) await rm(join(outDir, filename), { force: true });
      return remaining;
    },
  };
}
export type GameStorage = ReturnType<typeof createGameStorage>;

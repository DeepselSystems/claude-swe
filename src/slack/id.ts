import Redis from 'ioredis';
import { config } from '../config.js';

const redis = new Redis({ host: config.redis.host, port: config.redis.port });

const THREAD_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

function threadKey(channelId: string, threadTs: string): string {
  return `slack:thread:${channelId}:${threadTs}`;
}

function taskKey(taskId: string): string {
  return `slack:task:${taskId}`;
}

/** Generate a short unique ID for Slack-originated tasks: s-<8 base36 chars> */
export function generateSlackTaskId(): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let id = 's-';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function isSlackTaskId(id: string): boolean {
  return id.startsWith('s-');
}

export async function setSlackThreadTask(channelId: string, threadTs: string, taskId: string, repos: string[] = []): Promise<void> {
  await Promise.all([
    redis.setex(threadKey(channelId, threadTs), THREAD_TTL_SECONDS, JSON.stringify({ taskId, repos })),
    redis.setex(taskKey(taskId), THREAD_TTL_SECONDS, JSON.stringify({ channelId, threadTs })),
  ]);
}

export async function getSlackThreadTask(channelId: string, threadTs: string): Promise<{ taskId: string; repos: string[] } | null> {
  const value = await redis.get(threadKey(channelId, threadTs));
  if (!value) return null;
  // Backward compat: old entries stored just the taskId string
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'object' && parsed.taskId) return parsed;
    return { taskId: value, repos: [] };
  } catch {
    return { taskId: value, repos: [] };
  }
}

export async function getSlackThreadByTask(taskId: string): Promise<{ channelId: string; threadTs: string } | null> {
  const value = await redis.get(taskKey(taskId));
  if (!value) return null;
  return JSON.parse(value) as { channelId: string; threadTs: string };
}

/** Refresh TTL on both keys when a thread is interacted with */
export async function refreshSlackThreadTtl(channelId: string, threadTs: string, taskId: string): Promise<void> {
  await Promise.all([
    redis.expire(threadKey(channelId, threadTs), THREAD_TTL_SECONDS),
    redis.expire(taskKey(taskId), THREAD_TTL_SECONDS),
  ]);
}

// Redis key for "waiting for repo" state — task was created but had no repo
function pendingKey(channelId: string, threadTs: string): string {
  return `slack:pending:${channelId}:${threadTs}`;
}

interface PendingTask {
  taskId: string;
  taskDescription: string;
}

export async function setPendingSlackTask(channelId: string, threadTs: string, data: PendingTask): Promise<void> {
  await redis.setex(pendingKey(channelId, threadTs), THREAD_TTL_SECONDS, JSON.stringify(data));
}

export async function getPendingSlackTask(channelId: string, threadTs: string): Promise<PendingTask | null> {
  const value = await redis.get(pendingKey(channelId, threadTs));
  if (!value) return null;
  return JSON.parse(value) as PendingTask;
}

export async function deletePendingSlackTask(channelId: string, threadTs: string): Promise<void> {
  await redis.del(pendingKey(channelId, threadTs));
}

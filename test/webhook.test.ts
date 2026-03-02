import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

vi.mock('../src/config.js', () => ({
  config: {
    trello: {
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      token: 'test-token',
      botUsername: 'claude',
      boards: [
        { id: 'board-1', includeLists: [], repos: [], done: { listId: 'list-done' } },
      ],
    },
    github: {
      token: 'gh-token',
      webhookSecret: 'gh-secret',
    },
    anthropic: { apiKey: 'anth-key' },
    server: {
      port: 3000,
      webhookBaseUrl: 'https://example.com',
    },
    redis: { host: 'localhost', port: 6379 },
    containers: { backend: 'docker', workerImage: 'claude-swe-worker:latest' },
  },
  getBoardConfig: vi.fn().mockImplementation((boardId: string) => {
    if (boardId === 'board-1') {
      return { id: 'board-1', includeLists: [], repos: [], done: { listId: 'list-done' } };
    }
    return undefined;
  }),
}));

vi.mock('../src/queue/queue.js', () => ({
  taskQueue: { add: vi.fn().mockResolvedValue({ id: 'job-1' }) },
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../src/trello/bot.js', () => ({
  botMemberId: 'bot-member-id',
}));

vi.mock('../src/trello/api.js', () => ({
  fetchCard: vi.fn().mockImplementation((cardId: string) =>
    Promise.resolve({
      id: cardId,
      shortLink: 'abc123',
      name: 'Fix login bug',
      desc: 'repo: https://github.com/org/app',
      url: 'https://trello.com/c/abc123',
      idList: 'list-1',
    }),
  ),
}));

import { taskQueue } from '../src/queue/queue.js';
import type { Request, Response } from 'express';

function makeTrelloSignature(body: string, secret: string, callbackUrl: string): string {
  const content = body + callbackUrl + '/webhooks/trello';
  return crypto.createHmac('sha1', secret).update(content).digest('base64');
}

function makeGitHubSignature(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function mockRes(): Response & { statusCode: number } {
  const res = {
    statusCode: 200,
    sendStatus(code: number) {
      this.statusCode = code;
      return this;
    },
    json() { return this; },
  };
  return res as unknown as Response & { statusCode: number };
}

describe('handleTrelloWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('responds 200 to HEAD verification requests', async () => {
    const { handleTrelloWebhook } = await import('../src/webhook/handler.js');
    const req = { method: 'HEAD', headers: {}, body: {} } as unknown as Request;
    const res = mockRes();
    handleTrelloWebhook(req, res);
    expect(res.statusCode).toBe(200);
  });

  it('rejects requests with no signature', async () => {
    const { handleTrelloWebhook } = await import('../src/webhook/handler.js');
    const req = {
      method: 'POST',
      headers: {},
      body: {},
      rawBody: Buffer.from('{}'),
    } as unknown as Request;
    const res = mockRes();
    handleTrelloWebhook(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with invalid signature', async () => {
    const { handleTrelloWebhook } = await import('../src/webhook/handler.js');
    const bodyStr = JSON.stringify({ action: { type: 'addMemberToCard' } });
    const req = {
      method: 'POST',
      headers: { 'x-trello-webhook': 'bad-sig' },
      body: JSON.parse(bodyStr),
      rawBody: Buffer.from(bodyStr),
    } as unknown as Request;
    const res = mockRes();
    handleTrelloWebhook(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('enqueues new-task job when @claude is added to a card', async () => {
    const { handleTrelloWebhook } = await import('../src/webhook/handler.js');

    const payload = {
      action: {
        type: 'addMemberToCard',
        memberCreator: { id: 'u1', username: 'tim', fullName: 'Tim' },
        data: {
          card: { id: 'card-1', shortLink: 'abc123', name: 'Fix login bug', desc: 'repo: https://github.com/org/app', url: 'https://trello.com/c/abc123' },
          member: { id: 'bot-member-id', username: 'claude', fullName: 'Claude' },
          board: { id: 'board-1', name: 'My Board' },
        },
        id: 'act-1',
        date: new Date().toISOString(),
      },
      model: { id: 'board-1', name: 'My Board' },
    };

    const bodyStr = JSON.stringify(payload);
    const sig = makeTrelloSignature(bodyStr, 'test-secret', 'https://example.com');
    const req = {
      method: 'POST',
      headers: { 'x-trello-webhook': sig },
      body: payload,
      rawBody: Buffer.from(bodyStr),
    } as unknown as Request;
    const res = mockRes();

    handleTrelloWebhook(req, res);
    await new Promise((r) => setTimeout(r, 10));

    expect(res.statusCode).toBe(200);
    expect(taskQueue.add).toHaveBeenCalledWith(
      'new-task',
      expect.objectContaining({ cardId: 'card-1', cardName: 'Fix login bug' }),
      expect.any(Object),
    );
  });

  it('enqueues feedback job when a human comments on a card', async () => {
    const { handleTrelloWebhook } = await import('../src/webhook/handler.js');

    const payload = {
      action: {
        type: 'commentCard',
        memberCreator: { id: 'u1', username: 'tim', fullName: 'Tim' },
        data: {
          card: { id: 'card-2', shortLink: 'xyz789', name: 'Build dashboard', desc: 'repo: https://github.com/org/dash', url: 'https://trello.com/c/xyz789' },
          text: 'Please also add a loading spinner',
          board: { id: 'board-1', name: 'My Board' },
        },
        id: 'act-2',
        date: new Date().toISOString(),
      },
      model: { id: 'board-1', name: 'My Board' },
    };

    const bodyStr = JSON.stringify(payload);
    const sig = makeTrelloSignature(bodyStr, 'test-secret', 'https://example.com');
    const req = {
      method: 'POST',
      headers: { 'x-trello-webhook': sig },
      body: payload,
      rawBody: Buffer.from(bodyStr),
    } as unknown as Request;
    const res = mockRes();

    handleTrelloWebhook(req, res);
    await new Promise((r) => setTimeout(r, 10));

    expect(res.statusCode).toBe(200);
    expect(taskQueue.add).toHaveBeenCalledWith(
      'feedback',
      expect.objectContaining({
        cardId: 'card-2',
        cardDesc: 'repo: https://github.com/org/dash',
        commentText: 'Please also add a loading spinner',
      }),
      expect.any(Object),
    );
  });
});

describe('handleGitHubWebhook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects requests with no signature', async () => {
    const { handleGitHubWebhook } = await import('../src/webhook/handler.js');
    const req = {
      method: 'POST',
      headers: {},
      body: {},
      rawBody: Buffer.from('{}'),
    } as unknown as Request;
    const res = mockRes();
    handleGitHubWebhook(req, res);
    expect(res.statusCode).toBe(401);
  });

  it('enqueues cleanup job when a claude/* PR is closed', async () => {
    const { handleGitHubWebhook } = await import('../src/webhook/handler.js');

    const payload = {
      action: 'closed',
      pull_request: {
        number: 42,
        html_url: 'https://github.com/org/app/pull/42',
        head: { ref: 'claude/abc123' },
        merged: true,
        state: 'closed',
      },
      repository: { full_name: 'org/app' },
    };

    const bodyStr = JSON.stringify(payload);
    const sig = makeGitHubSignature(bodyStr, 'gh-secret');
    const req = {
      method: 'POST',
      headers: {
        'x-hub-signature-256': sig,
        'x-github-event': 'pull_request',
      },
      body: payload,
      rawBody: Buffer.from(bodyStr),
    } as unknown as Request;
    const res = mockRes();

    handleGitHubWebhook(req, res);
    await new Promise((r) => setTimeout(r, 10));

    expect(res.statusCode).toBe(200);
    expect(taskQueue.add).toHaveBeenCalledWith(
      'cleanup',
      expect.objectContaining({ cardShortLink: 'abc123', reason: 'merged' }),
    );
  });

  it('ignores non-claude branches', async () => {
    const { handleGitHubWebhook } = await import('../src/webhook/handler.js');

    const payload = {
      action: 'closed',
      pull_request: {
        number: 99,
        html_url: 'https://github.com/org/app/pull/99',
        head: { ref: 'feature/some-branch' },
        merged: false,
        state: 'closed',
      },
      repository: { full_name: 'org/app' },
    };

    const bodyStr = JSON.stringify(payload);
    const sig = makeGitHubSignature(bodyStr, 'gh-secret');
    const req = {
      method: 'POST',
      headers: {
        'x-hub-signature-256': sig,
        'x-github-event': 'pull_request',
      },
      body: payload,
      rawBody: Buffer.from(bodyStr),
    } as unknown as Request;
    const res = mockRes();

    handleGitHubWebhook(req, res);
    await new Promise((r) => setTimeout(r, 10));

    expect(taskQueue.add).not.toHaveBeenCalled();
  });
});

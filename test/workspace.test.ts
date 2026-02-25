import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  getBoardConfig: vi.fn().mockImplementation((boardId: string) => {
    if (boardId === 'board-single') {
      return { id: 'board-single', includeLists: [], repos: ['https://github.com/myorg/my-app'] };
    }
    if (boardId === 'board-multi') {
      return {
        id: 'board-multi',
        includeLists: [],
        repos: ['https://github.com/myorg/frontend', 'https://github.com/myorg/backend'],
      };
    }
    if (boardId === 'board-empty') {
      return { id: 'board-empty', includeLists: [], repos: [] };
    }
    return undefined;
  }),
}));

import { getBoardRepos } from '../src/workspace/repo.js';

describe('getBoardRepos', () => {
  it('returns repos for a board with a single repo', () => {
    expect(getBoardRepos('board-single')).toEqual(['https://github.com/myorg/my-app']);
  });

  it('returns repos for a board with multiple repos', () => {
    expect(getBoardRepos('board-multi')).toEqual([
      'https://github.com/myorg/frontend',
      'https://github.com/myorg/backend',
    ]);
  });

  it('returns empty array for a board with no repos', () => {
    expect(getBoardRepos('board-empty')).toEqual([]);
  });

  it('returns empty array for an unknown board', () => {
    expect(getBoardRepos('board-unknown')).toEqual([]);
  });
});

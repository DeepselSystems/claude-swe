import { getBoardConfig } from '../config.js';

/**
 * Get the list of configured repos for a board.
 * These are advisory hints — Claude decides which repo to actually clone.
 */
export function getBoardRepos(boardId: string): string[] {
  return getBoardConfig(boardId)?.repos ?? [];
}

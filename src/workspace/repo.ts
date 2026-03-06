import { getBoardConfig, config } from '../config.js';

/**
 * Get the list of configured repos for a board.
 * These are advisory hints — Claude decides which repo to actually clone.
 */
export function getBoardRepos(boardId: string): string[] {
  return getBoardConfig(boardId)?.repos ?? [];
}

/**
 * Get all unique repo slugs (owner/repo) across all configured boards.
 * Used by cleanup to check for open PRs across all possible repos.
 */
export function getAllRepoSlugs(): string[] {
  const seen = new Set<string>();
  for (const board of config.trello.boards) {
    for (const repoUrl of board.repos) {
      try {
        const url = new URL(repoUrl);
        const slug = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
        if (slug) seen.add(slug);
      } catch {
        // ignore malformed URLs
      }
    }
  }
  return [...seen];
}

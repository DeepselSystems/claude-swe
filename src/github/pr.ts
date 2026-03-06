import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../logger.js';

const execFileAsync = promisify(execFile);

/**
 * Check if there are open PRs with the given head branch across the specified repos.
 * Returns a flat list of open PR URLs found.
 * Uses the `gh` CLI so no extra auth config is needed.
 */
export async function findOpenPRsForBranch(branch: string, repoSlugs: string[]): Promise<string[]> {
  if (repoSlugs.length === 0) return [];

  const log = logger.child({ phase: 'github', branch });

  const results = await Promise.allSettled(
    repoSlugs.map(async (slug) => {
      const { stdout } = await execFileAsync('gh', [
        'pr', 'list',
        '--repo', slug,
        '--head', branch,
        '--state', 'open',
        '--json', 'url',
        '-q', '.[].url',
      ]);
      return stdout.trim().split('\n').filter(Boolean);
    }),
  );

  const openPRs: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      openPRs.push(...result.value);
    } else {
      log.warn({ err: result.reason, repo: repoSlugs[i] }, 'Failed to check open PRs for repo');
    }
  }

  return openPRs;
}

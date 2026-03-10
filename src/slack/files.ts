import { createWriteStream, mkdirSync } from 'fs';
import { pipeline } from 'stream/promises';
import path from 'path';
import { getSlackApp } from './client.js';
import { logger } from '../logger.js';

interface SlackFile {
  id: string;
  name?: string;
  url_private?: string;
  mimetype?: string;
}

/**
 * Download files shared in a Slack message to a local directory.
 * Uses the bot token for auth (Slack requires Authorization header for private file URLs).
 */
export async function downloadSlackFiles(files: SlackFile[], targetDir: string): Promise<void> {
  const app = getSlackApp();
  if (!app || files.length === 0) return;

  mkdirSync(targetDir, { recursive: true });

  const token = (app.client as { token?: string }).token;
  if (!token) {
    logger.warn('No Slack token available for file download');
    return;
  }

  for (const file of files) {
    if (!file.url_private) continue;

    const filename = file.name ?? file.id;
    const dest = path.join(targetDir, filename);

    try {
      const res = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok || !res.body) {
        logger.warn({ fileId: file.id, status: res.status }, 'Failed to download Slack file');
        continue;
      }
      const stream = createWriteStream(dest);
      await pipeline(res.body as any, stream);
      logger.info({ fileId: file.id, dest }, 'Downloaded Slack file');
    } catch (err) {
      logger.warn({ err, fileId: file.id }, 'Error downloading Slack file — skipping');
    }
  }
}

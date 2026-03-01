/**
 * CLI script: download image attachments (and inline description images) from a Trello card.
 * Usage: node download-images.mjs <cardId> <destDir>
 *
 * Reads TRELLO_API_KEY and TRELLO_TOKEN from environment.
 * Saves files to <destDir>; creates the directory if it doesn't exist.
 * Silently skips images that fail to download so one bad attachment
 * doesn't abort the whole job.
 */

import fs from 'fs';
import path from 'path';

const API_KEY = process.env.TRELLO_API_KEY;
const TOKEN = process.env.TRELLO_TOKEN;
const BASE = 'https://api.trello.com/1';

const IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

const MAX_IMAGES = 20;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

function authParams() {
  return `key=${API_KEY ?? ''}&token=${TOKEN ?? ''}`;
}

async function trelloFetch(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${BASE}${path}${sep}${authParams()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Trello ${res.status}: ${await res.text()}`);
  return res.json();
}

function extFromMime(mimeType) {
  switch (mimeType) {
    case 'image/png':  return '.png';
    case 'image/gif':  return '.gif';
    case 'image/webp': return '.webp';
    default:           return '.jpg';
  }
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/** Download a URL to destPath. Returns false if skipped (too large, error, etc.). */
async function downloadFile(url, destPath) {
  try {
    const fetchUrl = url.includes('trello.com') ? `${url}?${authParams()}` : url;
    const res = await fetch(fetchUrl);
    if (!res.ok) return false;

    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_FILE_BYTES) {
      console.error(`Skipping ${path.basename(destPath)}: too large (${contentLength} bytes)`);
      return false;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_FILE_BYTES) {
      console.error(`Skipping ${path.basename(destPath)}: too large after download`);
      return false;
    }

    fs.writeFileSync(destPath, buffer);
    return true;
  } catch (err) {
    console.error(`Failed to download ${url}:`, err);
    return false;
  }
}

/** Parse inline image URLs from a Trello card description. */
function extractDescriptionImageUrls(desc) {
  const urls = [];

  for (const m of desc.matchAll(/!\[.*?\]\((https?:\/\/[^)]+)\)/g)) {
    urls.push(m[1]);
  }

  for (const m of desc.matchAll(/https?:\/\/trello\.com\/\S+/g)) {
    const url = m[0].replace(/[)>.,]+$/, '');
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      urls.push(url);
    }
  }

  return [...new Set(urls)];
}

async function main() {
  const [cardId, destDir] = process.argv.slice(2);

  if (!cardId || !destDir) {
    console.error('Usage: download-images.mjs <cardId> <destDir>');
    process.exit(1);
  }

  if (!API_KEY || !TOKEN) {
    console.error('TRELLO_API_KEY and TRELLO_TOKEN must be set');
    process.exit(1);
  }

  fs.mkdirSync(destDir, { recursive: true });

  const [card, attachments] = await Promise.all([
    trelloFetch(`/cards/${cardId}?fields=desc`),
    trelloFetch(`/cards/${cardId}/attachments`),
  ]);

  let downloaded = 0;

  for (const att of attachments) {
    if (downloaded >= MAX_IMAGES) break;

    const isImageMime = IMAGE_MIME_TYPES.has(att.mimeType);
    const ext = path.extname(att.name).toLowerCase();
    const isImageExt = IMAGE_EXTENSIONS.has(ext);

    if (!isImageMime && !isImageExt) continue;

    const filename = sanitizeFilename(att.name) || `attachment-${downloaded + 1}${extFromMime(att.mimeType)}`;
    const destPath = path.join(destDir, filename);

    const ok = await downloadFile(att.url, destPath);
    if (ok) {
      console.log(`Downloaded attachment: ${filename}`);
      downloaded++;
    }
  }

  const descImageUrls = extractDescriptionImageUrls(card.desc ?? '');
  let descIndex = 1;

  for (const url of descImageUrls) {
    if (downloaded >= MAX_IMAGES) break;

    const ext = path.extname(new URL(url).pathname).toLowerCase();
    const safeExt = IMAGE_EXTENSIONS.has(ext) ? ext : '.jpg';
    const destPath = path.join(destDir, `desc-image-${descIndex}${safeExt}`);

    const ok = await downloadFile(url, destPath);
    if (ok) {
      console.log(`Downloaded description image: desc-image-${descIndex}${safeExt}`);
      downloaded++;
      descIndex++;
    }
  }

  console.log(`Done. Downloaded ${downloaded} image(s) to ${destDir}`);
}

main().catch((err) => {
  console.error('download-images failed:', err);
  process.exit(1);
});

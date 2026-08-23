import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';

/**
 * Writes a base64-encoded file into `dir`, sanitizing `filename` to avoid
 * path traversal (a caller-supplied filename should never be able to
 * write outside the intended directory). Used by the MCP upload_resume
 * tool, since resumePath/coverLetterPath in the candidate profile are
 * just paths — something has to actually put a file there, and on a
 * remote deployment there's no filesystem access to do that any other way.
 */
export async function saveUploadedFile(dir, filename, base64Content) {
  const safeName = String(filename).replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new Error(`Invalid filename: "${filename}"`);
  }
  const path = resolve(join(dir, safeName));
  const buffer = Buffer.from(base64Content, 'base64');
  if (buffer.length === 0) {
    throw new Error('Decoded file content is empty — check that contentBase64 is valid base64.');
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buffer);
  return { path, bytes: buffer.length };
}

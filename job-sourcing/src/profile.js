import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export const REQUIRED_FIELDS = ['fullName', 'email', 'resumePath'];

/**
 * Loads and lightly validates the candidate profile used to drive
 * autofill. See config/candidate.example.json for the shape.
 */
export async function loadCandidateProfile(
  path = process.env.CANDIDATE_PROFILE_PATH ?? './config/candidate.json',
) {
  const absolute = resolve(path);
  let raw;
  try {
    raw = await readFile(absolute, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `No candidate profile found at ${absolute}. Copy config/candidate.example.json ` +
          `to config/candidate.json and fill it in (or set CANDIDATE_PROFILE_PATH).`,
      );
    }
    throw err;
  }

  const profile = JSON.parse(raw);
  const missing = REQUIRED_FIELDS.filter((field) => !profile[field]);
  if (missing.length) {
    throw new Error(`Candidate profile at ${absolute} is missing required field(s): ${missing.join(', ')}`);
  }
  return profile;
}

/**
 * Reads the candidate profile without loadCandidateProfile's required-field
 * check — for inspecting a profile that's still being built up (e.g. via
 * the MCP set_candidate_profile tool) without throwing. Returns null if no
 * profile file exists yet, rather than throwing.
 */
export async function readCandidateProfileRaw(
  path = process.env.CANDIDATE_PROFILE_PATH ?? './config/candidate.json',
) {
  const absolute = resolve(path);
  try {
    return JSON.parse(await readFile(absolute, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

/**
 * Merges `updates` into `existing` one level deep: a plain-object value
 * (location, links, workAuthorization, eeo, defaultAnswers, search) has
 * its keys merged into the existing object rather than replacing it
 * wholesale — critical for defaultAnswers, where setting one new
 * question's answer must not wipe out previously-saved ones. Anything
 * else (strings, arrays, booleans) is a plain overwrite.
 */
export function mergeProfile(existing, updates) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;
    const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = { ...merged[key], ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Persists a partial update to the candidate profile — creating it if it
 * doesn't exist yet. This is what lets a remote caller (the MCP
 * set_candidate_profile tool, since a Railway deployment has no
 * filesystem access otherwise) bootstrap the profile and add persistent
 * answers to dynamic application questions (`defaultAnswers`) without
 * ever needing shell/volume access to the running container. Returns the
 * merged profile; does NOT enforce loadCandidateProfile's required-field
 * check, since a caller building up a profile across several calls should
 * be able to save an incomplete one along the way.
 */
export async function saveCandidateProfile(
  path = process.env.CANDIDATE_PROFILE_PATH ?? './config/candidate.json',
  updates = {},
) {
  const absolute = resolve(path);
  let existing = {};
  try {
    existing = JSON.parse(await readFile(absolute, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const merged = mergeProfile(existing, updates);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, JSON.stringify(merged, null, 2));
  return merged;
}

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REQUIRED_FIELDS = ['fullName', 'email', 'resumePath'];

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

export function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => vars[key] ?? '');
}

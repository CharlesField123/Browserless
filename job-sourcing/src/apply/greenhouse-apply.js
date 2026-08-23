import { autofillApplication } from './autofill.js';

/**
 * Greenhouse-hosted applications render fairly standard labeled form
 * fields, so the generic label-driven engine handles them well as-is.
 * This wrapper exists as the stable per-board entry point the CLI calls,
 * so board-specific quirks can be added here later without touching
 * callers.
 */
export async function applyOnGreenhouse(client, job, profile, options) {
  return autofillApplication(client, job, profile, options);
}

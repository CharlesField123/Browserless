import { autofillApplication } from './autofill.js';

/**
 * Lever's hosted "apply" pages (jobs.lever.co/.../apply) also render
 * standard labeled fields, so the generic engine handles them as-is.
 * Kept as its own entry point for the same reason as greenhouse-apply.js.
 */
export async function applyOnLever(client, job, profile, options) {
  return autofillApplication(client, job, profile, options);
}

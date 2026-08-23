/**
 * Path (on the Browserless *server's* filesystem, not this machine's) where
 * a given board's Chrome profile should live so logins persist across
 * separate CLI runs. Must match a volume mounted into the Browserless
 * container — see docker-compose.job-sourcing.yml.
 */
export function serverProfileDir(board) {
  const root = process.env.JOB_SOURCING_SERVER_PROFILES_DIR ?? '/tmp/job-sourcing-profiles';
  return `${root.replace(/\/$/, '')}/${board}`;
}

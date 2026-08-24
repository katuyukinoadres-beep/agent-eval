/**
 * The version this build stamps into everything it produces.
 *
 * Kept apart from `cli.ts` so tests can assert it without importing the entry
 * point — and it is a literal rather than a read of `package.json`, because it
 * is stamped into `--version`, the summary header, the payload's
 * `toolVersion`, and every snapshot on disk. Snapshots are hash-chained and
 * cannot be rewritten, so a version that drifts from the published one makes it
 * impossible to tell later which build produced which number.
 *
 * `test/version.test.ts` asserts this equals `package.json`, so the two cannot
 * diverge without the suite failing.
 */
export const VERSION = '0.1.0'

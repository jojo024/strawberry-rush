/*
 * Strawberry Rush — optional global leaderboard backend (Supabase).
 *
 * Paste your Supabase project's URL and PUBLIC anon key below to turn the
 * leaderboard global (shared across everyone who plays this build). Leave them
 * blank to keep scores local to each browser.
 *
 * The anon key is designed to be public and safe to ship in client code; row
 * security on the table (see README "Global leaderboard") controls what it can
 * do. A client-only leaderboard is inherently spoofable — fine for fun, not for
 * anything competitive.
 *
 * Setup (≈5 min): see the "Global leaderboard" section in README.md — create a
 * free Supabase project, run the SQL there to make the `scores` table + policy,
 * then fill in the two values below.
 */
window.LEADERBOARD_CONFIG = {
  url: '',       // e.g. 'https://abcdefgh.supabase.co'  (no trailing slash)
  anonKey: ''    // your project's anon / public API key
};

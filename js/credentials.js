// Credential storage and token lifecycle.
//
// The API token lives in chrome.storage.local — on this device only. It is
// deliberately not in chrome.storage.sync, which would replicate it in
// plaintext through the user's Google account to every signed-in browser. Use
// Settings > Export config to move to another machine.
//
// Atlassian does not expose a token's expiry over the API, so the date here is
// a user-editable reminder: recorded at setup as creation + DEFAULT_LIFETIME,
// correctable in Settings. It exists so an expired token reads as "expired"
// instead of an unexplained 401.
//
// The GitHub token (M11) is a *second* credential with its own keys and its own
// lifecycle, deliberately not folded into the record above: a dead GitHub token
// must never make the Jira views look broken, and forgetting one must not
// forget the other. It is also the one token whose expiry is real rather than
// assumed — GitHub reports it on every authenticated call.

import { runMigrations } from "./migrations.js";

export const DEFAULT_TOKEN_LIFETIME_DAYS = 365;
export const EXPIRY_WARNING_DAYS = 14;

const KEYS = ["email", "token", "tokenCreatedAt", "tokenExpiresAt"];
const GITHUB_KEYS = ["githubToken", "githubTokenCreatedAt", "githubTokenExpiresAt"];

function localGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function localSet(obj) {
  return new Promise((resolve) => {
    chrome.storage.local.set(obj, () => resolve());
  });
}

function localRemove(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.remove(keys, () => resolve());
  });
}

export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export function defaultExpiry(from = new Date()) {
  const due = new Date(from.getTime());
  due.setDate(due.getDate() + DEFAULT_TOKEN_LIFETIME_DAYS);
  return isoDate(due);
}

// Whole days from today until `expiresAt` (negative once past). Null when unset.
export function daysUntil(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const due = new Date(`${String(expiresAt).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(due.getTime())) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}

// Full credential record, or null when there is nothing usable to auth with.
export async function loadCredentials() {
  await runMigrations();
  const stored = await localGet(KEYS);
  if (!stored.email || !stored.token) return null;
  return {
    email: stored.email,
    token: stored.token,
    tokenCreatedAt: stored.tokenCreatedAt || null,
    tokenExpiresAt: stored.tokenExpiresAt || null,
  };
}

// The shape jiraFetch/jiraPost want: { email, token }, or null.
export async function getCredentials() {
  const creds = await loadCredentials();
  return creds ? { email: creds.email, token: creds.token } : null;
}

export async function saveCredentials({ email, token, tokenExpiresAt }) {
  await runMigrations();
  const now = new Date();
  const existing = await localGet(KEYS);
  // Saving Settings with an unchanged token must not reset its age — the
  // creation date only moves when the token itself does.
  const rotated = existing.token !== token;
  const patch = {
    email,
    token,
    tokenCreatedAt: rotated || !existing.tokenCreatedAt ? now.toISOString() : existing.tokenCreatedAt,
    tokenExpiresAt: tokenExpiresAt || defaultExpiry(now),
  };
  await localSet(patch);
  return patch;
}

// Correcting the expiry date must not disturb the token itself.
export async function saveTokenExpiry(tokenExpiresAt) {
  await runMigrations();
  await localSet({ tokenExpiresAt: tokenExpiresAt || null });
}

// Drops the token but keeps the email, so re-auth is one field.
export async function clearToken() {
  await localRemove(["token", "tokenCreatedAt", "tokenExpiresAt"]);
}

export async function clearCredentials() {
  await localRemove(KEYS);
}

// Derived state for the expiry banner and the Settings hint.
export async function tokenStatus(now = new Date()) {
  const stored = await localGet(KEYS);
  const expiresAt = stored.tokenExpiresAt || null;
  const days = daysUntil(expiresAt, now);
  return {
    hasToken: Boolean(stored.token),
    email: stored.email || "",
    createdAt: stored.tokenCreatedAt || null,
    expiresAt,
    daysLeft: days,
    expired: days !== null && days < 0,
    expiringSoon: days !== null && days >= 0 && days <= EXPIRY_WARNING_DAYS,
  };
}

// ── GitHub token ─────────────────────────────────────────────────────────────
// Same storage, separate keys, separate lifecycle. Never exported with the
// config: a second credential in a shared file is a second thing to leak.

export async function getGithubToken() {
  await runMigrations();
  const stored = await localGet(GITHUB_KEYS);
  return stored.githubToken || "";
}

export async function saveGithubToken(token, { expiresAt } = {}) {
  await runMigrations();
  const existing = await localGet(GITHUB_KEYS);
  const rotated = existing.githubToken !== token;
  const patch = {
    githubToken: token,
    githubTokenCreatedAt:
      rotated || !existing.githubTokenCreatedAt
        ? new Date().toISOString()
        : existing.githubTokenCreatedAt,
    // Unlike Atlassian, the real date arrives on the first authenticated call —
    // so an unknown expiry stays unknown rather than being guessed at a year.
    githubTokenExpiresAt: expiresAt ?? (rotated ? null : existing.githubTokenExpiresAt ?? null),
  };
  await localSet(patch);
  return patch;
}

// Called from the response header on every authenticated GitHub call. Writes
// only on a change, so a fetch does not touch storage on every request.
export async function recordGithubTokenExpiry(expiresAt) {
  if (!expiresAt) return;
  const stored = await localGet(GITHUB_KEYS);
  if (!stored.githubToken) return;
  if (stored.githubTokenExpiresAt === expiresAt) return;
  await localSet({ githubTokenExpiresAt: expiresAt });
}

export async function clearGithubToken() {
  await localRemove(GITHUB_KEYS);
}

export async function githubTokenStatus(now = new Date()) {
  const stored = await localGet(GITHUB_KEYS);
  const expiresAt = stored.githubTokenExpiresAt || null;
  const days = daysUntil(expiresAt, now);
  return {
    hasToken: Boolean(stored.githubToken),
    createdAt: stored.githubTokenCreatedAt || null,
    expiresAt,
    daysLeft: days,
    expired: days !== null && days < 0,
    expiringSoon: days !== null && days >= 0 && days <= EXPIRY_WARNING_DAYS,
  };
}

export function describeGithubTokenStatus(status) {
  if (!status.hasToken) return "No GitHub token stored";
  if (!status.expiresAt) {
    return "GitHub token stored — expiry unknown until the first call";
  }
  if (status.expired) {
    const ago = Math.abs(status.daysLeft);
    return `GitHub token expired ${status.expiresAt} (${ago} day${ago === 1 ? "" : "s"} ago)`;
  }
  if (status.daysLeft === 0) return `GitHub token expires today (${status.expiresAt})`;
  return `GitHub token expires ${status.expiresAt} (in ${status.daysLeft} day${status.daysLeft === 1 ? "" : "s"})`;
}

export function describeTokenStatus(status) {
  if (!status.hasToken) return "No token stored";
  if (!status.expiresAt) return "Expiry date not set";
  if (status.expired) {
    const ago = Math.abs(status.daysLeft);
    return `Token expired ${status.expiresAt} (${ago} day${ago === 1 ? "" : "s"} ago)`;
  }
  if (status.daysLeft === 0) return `Token expires today (${status.expiresAt})`;
  return `Token expires ${status.expiresAt} (in ${status.daysLeft} day${status.daysLeft === 1 ? "" : "s"})`;
}

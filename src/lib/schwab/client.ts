/**
 * Schwab Trader API, READ-ONLY (2026-11-10). The app reads balances, positions and cash; it never trades.
 *   - Requests to Schwab's data API go through schwabGet(), which allows GET only and only the paths in
 *     READ_PATHS. There is no code for orders, and a test fails if any appears in this folder.
 *   - The Schwab app itself is registered with an order limit of 0.
 * Sign-in is Schwab's OAuth: you sign in on Schwab's page; the app keeps only the tokens, encrypted with a
 * key derived from SCHWAB_APP_SECRET (model_runs kind "schwab_token"). Schwab's refresh token lasts 7 days,
 * so you sign in again once a week.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { save } from "@/lib/intel/jobs";

export const SCHWAB_VERSION = "schwab@1";
const AUTH = "https://api.schwabapi.com/v1/oauth";
const API = "https://api.schwabapi.com";
/** The only Schwab data paths the app may call, all with GET. */
export const READ_PATHS = [/^\/trader\/v1\/accounts(\?fields=positions)?$/, /^\/trader\/v1\/accounts\/accountNumbers$/, /^\/marketdata\/v1\/quotes\?/];
export const REFRESH_DAYS = 7;
const ACCESS_MARGIN_MS = 60_000;

export const configured = () => !!process.env.SCHWAB_APP_KEY && !!process.env.SCHWAB_APP_SECRET;
const basic = () => `Basic ${Buffer.from(`${process.env.SCHWAB_APP_KEY}:${process.env.SCHWAB_APP_SECRET}`).toString("base64")}`;

export function authorizeUrl(redirectUri: string, state: string) {
  const q = new URLSearchParams({ client_id: process.env.SCHWAB_APP_KEY ?? "", redirect_uri: redirectUri, state });
  return `${AUTH}/authorize?${q}`;
}

/* ---------------------------------------------------------------- tokens, encrypted at rest */

type Tokens = { access: string; refresh: string; accessExpiresAt: string; refreshIssuedAt: string };
type Sealed = { v: 1; iv: string; tag: string; data: string; accessExpiresAt: string; refreshIssuedAt: string; at: string };

function key(): Buffer {
  return Buffer.from(hkdfSync("sha256", process.env.SCHWAB_APP_SECRET ?? "", "portfolio-intelligence", "schwab-token-v1", 32));
}
export function seal(t: Tokens, now = new Date()): Sealed {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify({ a: t.access, r: t.refresh }), "utf8"), c.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64"), accessExpiresAt: t.accessExpiresAt, refreshIssuedAt: t.refreshIssuedAt, at: now.toISOString() };
}
export function unseal(s: Sealed): Tokens {
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(s.iv, "base64"));
  d.setAuthTag(Buffer.from(s.tag, "base64"));
  const o = JSON.parse(Buffer.concat([d.update(Buffer.from(s.data, "base64")), d.final()]).toString("utf8")) as { a: string; r: string };
  return { access: o.a, refresh: o.r, accessExpiresAt: s.accessExpiresAt, refreshIssuedAt: s.refreshIssuedAt };
}

async function tokenRequest(body: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const res = await fetch(`${AUTH}/token`, {
    method: "POST", headers: { Authorization: basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body), cache: "no-store", signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Schwab sign-in answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return res.json();
}

/** After you sign in on Schwab's page: swaps the one-time code for tokens and stores them. */
export async function exchangeCode(db: SupabaseClient, code: string, redirectUri: string, now = new Date()) {
  const t = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  if (!t.refresh_token) throw new Error("Schwab did not return a refresh token");
  await save(db, "schwab_token", SCHWAB_VERSION, { event: "connected" }, seal({ access: t.access_token, refresh: t.refresh_token, accessExpiresAt: new Date(now.getTime() + t.expires_in * 1000).toISOString(), refreshIssuedAt: now.toISOString() }, now));
}

export type Connection = { configured: boolean; connected: boolean; refreshIssuedAt: string | null; expiresAt: string | null; daysLeft: number | null; disconnected: boolean };

async function latestSealed(db: SupabaseClient): Promise<{ sealed: Sealed | null; disconnected: boolean }> {
  const { data } = await db.from("model_runs").select("inputs, outputs").eq("kind", "schwab_token").order("computed_at", { ascending: false }).limit(1).maybeSingle();
  if (!data) return { sealed: null, disconnected: false };
  if ((data.inputs as { event?: string })?.event === "disconnected") return { sealed: null, disconnected: true };
  return { sealed: data.outputs as Sealed, disconnected: false };
}

export function connectionOf(s: Pick<Sealed, "refreshIssuedAt"> | null, now: Date, disconnected = false): Connection {
  if (!s) return { configured: configured(), connected: false, refreshIssuedAt: null, expiresAt: null, daysLeft: null, disconnected };
  const exp = Date.parse(s.refreshIssuedAt) + REFRESH_DAYS * 86_400_000;
  const left = (exp - now.getTime()) / 86_400_000;
  return { configured: configured(), connected: left > 0, refreshIssuedAt: s.refreshIssuedAt, expiresAt: new Date(exp).toISOString(), daysLeft: Math.max(0, Math.round(left * 10) / 10), disconnected };
}

export async function connection(db: SupabaseClient, now = new Date()): Promise<Connection> {
  const { sealed, disconnected } = await latestSealed(db);
  return connectionOf(sealed, now, disconnected);
}

/** A valid access token, refreshing it when it is about to expire. Throws when you need to sign in again. */
export async function accessToken(db: SupabaseClient, now = new Date()): Promise<string> {
  if (!configured()) throw new Error("Schwab is not set up: SCHWAB_APP_KEY and SCHWAB_APP_SECRET are missing in Netlify");
  const { sealed } = await latestSealed(db);
  if (!sealed || !connectionOf(sealed, now).connected) throw new Error("Schwab sign-in has expired: tap Connect Schwab to sign in again");
  const t = unseal(sealed);
  if (Date.parse(t.accessExpiresAt) - now.getTime() > ACCESS_MARGIN_MS) return t.access;
  const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh });
  // A refresh does not extend the 7-day sign-in; Schwab may return the same refresh token.
  await save(db, "schwab_token", SCHWAB_VERSION, { event: "refreshed" }, seal({ access: r.access_token, refresh: r.refresh_token ?? t.refresh, accessExpiresAt: new Date(now.getTime() + r.expires_in * 1000).toISOString(), refreshIssuedAt: t.refreshIssuedAt }, now));
  return r.access_token;
}

export async function disconnect(db: SupabaseClient) {
  await save(db, "schwab_token", SCHWAB_VERSION, { event: "disconnected" }, { at: new Date().toISOString() });
}

/** GET only, allowed read paths only. */
export async function schwabGet<T>(db: SupabaseClient, path: string): Promise<T> {
  if (!READ_PATHS.some((re) => re.test(path))) throw new Error(`Blocked: ${path.split("?")[0]} is not a read-only Schwab path this app allows`);
  const token = await accessToken(db);
  const res = await fetch(`${API}${path}`, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Schwab answered ${res.status} for ${path.split("?")[0]}`);
  return res.json() as Promise<T>;
}

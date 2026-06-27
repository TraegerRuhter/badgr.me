import {
  createSupabaseClient,
  createSupabaseRemoteStore,
  ensureAnonSession,
} from "@alarmed/supabase";
import { syncTasks, type SyncResult } from "@alarmed/core";

import { localTaskStore } from "../db/database";

/**
 * Wires Supabase sync to the local store, if configured. Vite inlines `VITE_*`
 * vars at build time; the anon key is meant to be public (RLS gates access),
 * so it's safe in the client bundle. Leave `VITE_SUPABASE_URL` unset to run
 * fully offline with no sync — same opt-in pattern as the nag-ai proxy.
 */
const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const client = url && anonKey ? createSupabaseClient({ url, anonKey }) : null;
const remote = client ? createSupabaseRemoteStore(client) : null;

export const syncEnabled = remote !== null;

/**
 * One best-effort reconciliation pass. Sync failures (offline, auth, RLS) must
 * never break the offline-first app, so the caller swallows rejections; this
 * only signs in and runs the engine.
 */
export async function runSync(): Promise<SyncResult> {
  if (!remote || !client) return { pushed: 0, pulled: 0 };
  await ensureAnonSession(client);
  return syncTasks(localTaskStore, remote);
}

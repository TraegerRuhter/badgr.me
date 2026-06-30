import {
  createSupabaseClient,
  createSupabaseRemoteStore,
  ensureAnonSession,
} from "@alarmed/supabase";
import { createCoalescedRunner, syncTasks, type SyncResult } from "@alarmed/core";

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

async function performSync(): Promise<SyncResult> {
  if (!remote || !client) return { pushed: 0, pulled: 0 };
  await ensureAnonSession(client);
  return syncTasks(localTaskStore, remote);
}

/**
 * One best-effort reconciliation pass, coalesced so a burst of triggers (each
 * change kicks a sync) never overlaps two passes racing each other — at most
 * one runs while one more is queued. Sync failures (offline, auth, RLS) must
 * never break the offline-first app, so the runner swallows rejections.
 */
export const runSync = createCoalescedRunner(performSync);

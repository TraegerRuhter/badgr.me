// supabase-js uses the WHATWG URL API, which React Native doesn't ship — this
// polyfill must be imported before the client is created.
import "react-native-url-polyfill/auto";

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createSupabaseClient,
  createSupabaseRemoteStore,
  ensureAnonSession,
} from "@alarmed/supabase";
import { createCoalescedRunner, syncTasks, type SyncResult } from "@alarmed/core";

import { localTaskStore } from "../db/database";

/**
 * Wires Supabase sync to the local SQLite store, if configured. Expo inlines
 * `EXPO_PUBLIC_*` vars at build time; the anon key is meant to be public (RLS
 * gates access), so it's safe in the bundle. Leave `EXPO_PUBLIC_SUPABASE_URL`
 * unset to run fully offline with no sync — same opt-in pattern as nag-ai.
 *
 * The auth session persists in AsyncStorage so the anonymous user is stable
 * across launches (and thus sees the same rows under RLS).
 */
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

const client =
  url && anonKey
    ? createSupabaseClient({ url, anonKey, authStorage: AsyncStorage })
    : null;
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

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Thin wrapper around supabase-js so both clients build the connection the
 * same way. The library is isomorphic; the only platform difference is where
 * the auth session is persisted — web uses localStorage by default, React
 * Native passes AsyncStorage in via `authStorage`.
 */
export interface SupabaseConfig {
  url: string;
  anonKey: string;
  /** Storage adapter for the auth session (RN: AsyncStorage). Web omits it. */
  authStorage?: {
    getItem: (key: string) => Promise<string | null> | string | null;
    setItem: (key: string, value: string) => Promise<void> | void;
    removeItem: (key: string) => Promise<void> | void;
  };
}

export function createSupabaseClient(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url, config.anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // RN has no URL-based session detection; harmless to disable on web too
      // since we never use OAuth redirects in this single-user app.
      detectSessionInUrl: false,
      ...(config.authStorage ? { storage: config.authStorage } : {}),
    },
  });
}

/**
 * Single-user app: RLS only requires *a* signed-in user, not a specific one,
 * so an anonymous session is enough to read/write this device's tasks. Call
 * before syncing; a no-op once a session already exists.
 */
export async function ensureAnonSession(client: SupabaseClient): Promise<void> {
  const { data } = await client.auth.getSession();
  if (data.session) return;

  const { error } = await client.auth.signInAnonymously();
  if (error) throw error;
}

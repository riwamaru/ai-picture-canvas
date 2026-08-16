import { createClient } from "@supabase/supabase-js";

/**
 * service_role キーのクライアント。RLS を迂回する。
 *
 * ★ サーバー側でしか作らない。ブラウザへ渡る経路を作ってはならない
 *   （PoC 実装指示書 2 章 禁止事項④の趣旨）。
 *   NEXT_PUBLIC_ が付いていないため、Next.js はクライアントバンドルへ含めない。
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY が設定されていません。",
    );
  }

  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

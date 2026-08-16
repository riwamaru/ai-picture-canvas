import { createBrowserClient } from "@supabase/ssr";

/** ブラウザ側の Supabase クライアント。ログインにだけ使う。 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

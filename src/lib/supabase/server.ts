import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * ログイン中の利用者として振る舞う Supabase クライアント。
 *
 * このクライアントは RLS の下で動く。つまり自分の profiles / jobs しか読めない。
 * 上限や他人の記録には触れない。
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Server Component から呼ばれた場合は書き込めない。
            // セッションの更新は middleware が行うのでここは無視してよい。
          }
        },
      },
    },
  );
}

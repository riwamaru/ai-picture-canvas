import type { User } from "@supabase/supabase-js";
import { createClient } from "./supabase/server";
import { createAdminClient } from "./supabase/admin";

/**
 * ロール（機能仕様書 F-08 / 4.6）。
 *
 *   admin … 管理者。/admin と管理 API を使える
 *   staff … 利用者
 *
 * ★ 判定は DB（profiles.role）が本体。ADMIN_EMAILS は安全弁で、
 *   環境変数に載っている人は DB の値によらず管理者になる。
 *   無いと、誤って全員を利用者に落としたとき誰も管理画面へ入れなくなる。
 *
 * ★ 画面の出し分けは認可ではない。認可は各 API ルートでこの関数を通して行う。
 */
export type Role = "admin" | "staff";

export const ROLE_LABEL: Record<Role, string> = { admin: "管理者", staff: "利用者" };

export function envAdmins(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/** ログイン中の利用者とロール。未ログインなら null。 */
export async function currentUser(): Promise<{ user: User; role: Role; isAdmin: boolean } | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await createAdminClient()
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  const email = (user.email ?? "").toLowerCase();
  const dbRole: Role = profile?.role === "admin" ? "admin" : "staff";
  const isAdmin = dbRole === "admin" || envAdmins().includes(email);

  return { user, role: isAdmin ? "admin" : "staff", isAdmin };
}

/** 管理 API の入口。管理者でなければ null。 */
export async function requireAdmin(): Promise<User | null> {
  const current = await currentUser();
  return current?.isAdmin ? current.user : null;
}

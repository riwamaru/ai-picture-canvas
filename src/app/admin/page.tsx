import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AdminPanel } from "@/components/AdminPanel";

/**
 * 管理者向けシステム設定（ページ）。ADMIN_EMAILS の人だけ。
 *
 * 以前はモーダルだったが、節が増えたので左メニューつきのページにした。
 * 認可はここ（サーバー）と各 API ルートの両方で行う。画面の出し分けは認可ではない。
 */

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!admins.includes((user.email ?? "").toLowerCase())) redirect("/");

  return <AdminPanel />;
}

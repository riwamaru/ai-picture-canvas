import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { AdminPanel } from "@/components/AdminPanel";

/**
 * 管理者向けシステム設定（ページ）。ロールが管理者の人だけ。
 *
 * 以前はモーダルだったが、節が増えたので左メニューつきのページにした。
 * 認可はここ（サーバー）と各 API ルートの両方で行う。画面の出し分けは認可ではない。
 */

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const current = await currentUser();
  if (!current) redirect("/login");
  if (!current.isAdmin) redirect("/");

  return <AdminPanel />;
}

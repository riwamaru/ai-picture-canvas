import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { buildCatalog } from "@/lib/catalog";
import { AppShell } from "@/components/AppShell";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // middleware でも弾いているが、ここでも確認する（マッチャの書き間違いを認証の穴にしない）。
  const current = await currentUser();
  if (!current) redirect("/login");

  return <AppShell catalog={buildCatalog()} email={current.user.email ?? ""} isAdmin={current.isAdmin} />;
}

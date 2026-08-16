import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { buildCatalog } from "@/lib/catalog";
import { Studio } from "@/components/Studio";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // middleware でも弾いているが、ここでも確認する（マッチャの書き間違いを認証の穴にしない）。
  if (!user) redirect("/login");

  const admins = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return (
    <Studio
      catalog={buildCatalog()}
      email={user.email ?? ""}
      isAdmin={admins.includes((user.email ?? "").toLowerCase())}
    />
  );
}

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InviteForm } from "@/components/InviteForm";

export const dynamic = "force-dynamic";

/** 招待画面。ADMIN_EMAILS に載っている人だけが開ける（API 側でも同じ確認をしている）。 */
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

  return <InviteForm />;
}

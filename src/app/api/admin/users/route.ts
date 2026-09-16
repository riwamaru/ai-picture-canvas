import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { envAdmins, requireAdmin, type Role } from "@/lib/auth";

/**
 * 利用者の編集（管理画面）。ロールと枚数上限を後から変えられる。
 *
 * ★ 自分自身を利用者に落とすことはできない（管理画面から締め出されるため）。
 * ★ ADMIN_EMAILS に載っている人は DB の値によらず管理者なので、ここで落としても効かない。
 *   画面にもそう出す。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request) {
  const caller = await requireAdmin();
  if (!caller) {
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as
    | { email?: unknown; role?: unknown; maxImages?: unknown }
    | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email) return NextResponse.json({ ok: false, message: "対象が不正です。" }, { status: 400 });

  const patch: { role?: Role; max_images?: number } = {};
  if (body?.role === "admin" || body?.role === "staff") patch.role = body.role;
  if (typeof body?.maxImages === "number" && Number.isInteger(body.maxImages)) {
    patch.max_images = Math.min(Math.max(body.maxImages, 1), 500);
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, message: "変更する項目がありません。" }, { status: 400 });
  }

  if (patch.role === "staff" && email === (caller.email ?? "").toLowerCase()) {
    return NextResponse.json(
      { ok: false, message: "自分自身を利用者にはできません（管理画面へ入れなくなります）。" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();
  const [{ error: e1 }, { error: e2 }] = await Promise.all([
    admin.from("profiles").update(patch).eq("email", email),
    // 招待リスト側も揃える（未サインアップの人はこちらだけが効く）
    admin.from("allowed_emails").update(patch).eq("email", email),
  ]);
  const error = e1 ?? e2;
  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 });

  return NextResponse.json({
    ok: true,
    // 環境変数に載っている人は落としても管理者のまま。画面で知らせる
    pinnedAdmin: envAdmins().includes(email),
  });
}

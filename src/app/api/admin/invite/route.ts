import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 招待。ADMIN_EMAILS に載っている人だけが叩ける。
 *
 * ★ 招待は 2 段構えになっている：
 *     ① allowed_emails へ入れる（DB のトリガが「載っていないアドレス」を拒否する）
 *     ② auth のユーザーを作る（ログイン画面は shouldCreateUser:false で動く）
 *   ①だけ、②だけでは入れない。
 *
 * ★ パスワードを発行する選択肢を用意してあるのは、Supabase の組み込みメール送信に
 *   厳しい送信レート制限があるためである（既定では 1 時間に数通）。
 *   独自 SMTP を設定するまでの間、マジックリンクだけだと招待が詰まる。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function adminEmails(): string[] {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const callerEmail = user?.email?.toLowerCase();
  if (!callerEmail || !adminEmails().includes(callerEmail)) {
    // 招待できる人かどうかを外から探れないよう、理由は返さない。
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    email?: unknown;
    maxImages?: unknown;
    withPassword?: unknown;
    note?: unknown;
  } | null;

  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ ok: false, message: "メールアドレスが不正です。" }, { status: 400 });
  }

  const maxImages =
    typeof body?.maxImages === "number" && Number.isInteger(body.maxImages)
      ? Math.min(Math.max(body.maxImages, 1), 100)
      : 10;

  const admin = createAdminClient();

  const { error: allowError } = await admin.from("allowed_emails").upsert(
    {
      email,
      max_images: maxImages,
      note: typeof body?.note === "string" ? body.note.slice(0, 200) : null,
    },
    { onConflict: "email" },
  );
  if (allowError) {
    return NextResponse.json(
      { ok: false, message: `招待リストに追加できませんでした: ${allowError.message}` },
      { status: 500 },
    );
  }

  // 既に profiles があるなら、枚数だけ更新して終わる（招待のやり直しで枠が戻らないように）。
  const { data: existing } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();

  if (existing) {
    await admin.from("profiles").update({ max_images: maxImages }).eq("id", existing.id);
    return NextResponse.json({
      ok: true,
      alreadyInvited: true,
      email,
      maxImages,
      message: "すでに招待済みです。上限枚数だけ更新しました。",
    });
  }

  const password = body?.withPassword === true ? randomBytes(9).toString("base64url") : undefined;

  const { error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError) {
    return NextResponse.json(
      { ok: false, message: `利用者を作成できませんでした: ${createError.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    email,
    maxImages,
    // パスワードはここでしか表示されない（DB にも平文では残らない）。
    password: password ?? null,
    message: password
      ? "招待しました。このパスワードを本人へ伝えてください（この画面を閉じると二度と表示されません）。"
      : "招待しました。本人がログイン画面でメールアドレスを入力すると、ログイン用のリンクが届きます。",
  });
}

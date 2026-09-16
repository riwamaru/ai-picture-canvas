import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * STEP 0 からのキャスト新規登録（F-14）。
 *
 * 仕様書 4.8 / D-2：登録権限の範囲は「店長以上に限定する案を基本」だが未確定。
 * 体験環境では、招待された利用者なら誰でも登録できる。source='manual' で記録する。
 * 管理者は管理画面から編集・削除できる。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, message: "ログインしてください。" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { storeName?: unknown; name?: unknown; joinedYm?: unknown }
    | null;
  const storeName = typeof body?.storeName === "string" ? body.storeName.trim() : "";
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 60) : "";
  const joinedYmRaw = typeof body?.joinedYm === "string" ? body.joinedYm.replace(/-/g, "").trim() : "";
  const joinedYm = /^\d{6}$/.test(joinedYmRaw) ? joinedYmRaw : null;

  if (!storeName) return NextResponse.json({ ok: false, message: "店舗を選んでください。" }, { status: 400 });
  if (!name) return NextResponse.json({ ok: false, message: "キャスト名を入力してください。" }, { status: 400 });
  if (joinedYmRaw && !joinedYm) {
    return NextResponse.json({ ok: false, message: "入店年月は YYYY-MM の形で入力してください。" }, { status: 400 });
  }

  const admin = createAdminClient();

  // 店舗が台帳に無ければ作る（画面の候補に無い店舗名を打ち込んだ場合）
  const { data: store } = await admin
    .from("stores")
    .upsert({ name: storeName }, { onConflict: "name" })
    .select("id")
    .single();
  if (!store) return NextResponse.json({ ok: false, message: "店舗を登録できませんでした。" }, { status: 500 });

  const { data: cast, error } = await admin
    .from("casts")
    .insert({ store_id: store.id, name, joined_ym: joinedYm, source: "manual" })
    .select("id, name, joined_ym")
    .single();

  if (error) {
    // 仕様書 4.8：同月入店の同名は自動マージせず、登録時に知らせる
    if (error.code === "23505") {
      return NextResponse.json(
        { ok: false, message: "同じ店舗に、同じ名前・同じ入店年月のキャストが登録済みです。" },
        { status: 409 },
      );
    }
    return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    cast: { id: cast.id, name: cast.name, joinedYm: cast.joined_ym, label: joinedYm ? `${name}_${joinedYm}` : name },
  });
}

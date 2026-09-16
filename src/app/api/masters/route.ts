import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * 店舗・キャストの候補（STEP 0 のサジェスト用・F-12）。
 * RLS 下で読む（ログイン済みなら全件読める）。有効なものだけ返す。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ ok: false, message: "ログインしてください。" }, { status: 401 });
  }

  const [{ data: stores }, { data: casts }] = await Promise.all([
    supabase.from("stores").select("id, name").eq("active", true).order("sort_order").order("name"),
    supabase
      .from("casts")
      .select("id, store_id, name, joined_ym")
      .eq("active", true)
      .order("name"),
  ]);

  return NextResponse.json({
    ok: true,
    stores: stores ?? [],
    casts: (casts ?? []).map((cast) => ({
      id: cast.id,
      storeId: cast.store_id,
      name: cast.name,
      joinedYm: cast.joined_ym,
      // 仕様書 4.8 の表示名「名前_YYYYMM」。Drive のフォルダ名もこれから決まる
      label: cast.joined_ym ? `${cast.name}_${cast.joined_ym}` : cast.name,
    })),
  });
}

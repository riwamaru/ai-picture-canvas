import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";

/**
 * 店舗・キャストの台帳の管理（管理画面）。ADMIN_EMAILS の人だけ。
 *
 *   GET                       … 全件（無効も含む）
 *   POST   { kind, ...fields } … 追加
 *   PATCH  { kind, id, ...fields } … 編集
 *   DELETE { kind, id }        … 削除（キャストは物理削除。店舗は配下のキャストごと消える）
 *
 * ★ jobs の store_name / cast_name は文字列で残しているので、
 *   ここで改名・削除しても過去のセッションの記録は変わらない。
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


function normalizeYm(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const raw = String(value).replace(/-/g, "").trim();
  return /^\d{6}$/.test(raw) ? raw : undefined;
}

export async function GET() {
  if (!(await requireAdmin())) {
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 403 });
  }
  const admin = createAdminClient();
  const [{ data: stores }, { data: casts }] = await Promise.all([
    admin.from("stores").select("id, name, sort_order, active, created_at").order("sort_order").order("name"),
    admin
      .from("casts")
      .select("id, store_id, name, joined_ym, note, active, source, created_at")
      .order("name"),
  ]);

  // 使われている回数（消してよいかの目安）
  const { data: usage } = await admin.from("jobs").select("store_name, cast_name");
  const storeUse = new Map<string, number>();
  const castUse = new Map<string, number>();
  for (const row of usage ?? []) {
    if (row.store_name) storeUse.set(row.store_name, (storeUse.get(row.store_name) ?? 0) + 1);
    if (row.cast_name) castUse.set(row.cast_name, (castUse.get(row.cast_name) ?? 0) + 1);
  }

  return NextResponse.json({
    ok: true,
    stores: (stores ?? []).map((s) => ({ ...s, jobs: storeUse.get(s.name) ?? 0 })),
    casts: (casts ?? []).map((c) => ({
      ...c,
      label: c.joined_ym ? `${c.name}_${c.joined_ym}` : c.name,
      jobs: castUse.get(c.joined_ym ? `${c.name}_${c.joined_ym}` : c.name) ?? 0,
    })),
  });
}

export async function POST(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const admin = createAdminClient();

  if (body?.kind === "store") {
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    if (!name) return NextResponse.json({ ok: false, message: "店舗名を入力してください。" }, { status: 400 });
    const { error } = await admin.from("stores").insert({ name, sort_order: Number(body.sort_order ?? 0) || 0 });
    if (error) {
      return NextResponse.json(
        { ok: false, message: error.code === "23505" ? "同じ名前の店舗があります。" : error.message },
        { status: error.code === "23505" ? 409 : 500 },
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (body?.kind === "cast") {
    const storeId = typeof body.store_id === "string" ? body.store_id : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
    const joinedYm = normalizeYm(body.joined_ym);
    if (!storeId || !name) {
      return NextResponse.json({ ok: false, message: "店舗とキャスト名は必須です。" }, { status: 400 });
    }
    if (joinedYm === undefined) {
      return NextResponse.json({ ok: false, message: "入店年月は YYYYMM または YYYY-MM で入力してください。" }, { status: 400 });
    }
    const { error } = await admin.from("casts").insert({
      store_id: storeId,
      name,
      joined_ym: joinedYm,
      note: typeof body.note === "string" ? body.note.trim().slice(0, 200) || null : null,
      source: "manual",
    });
    if (error) {
      return NextResponse.json(
        {
          ok: false,
          message: error.code === "23505" ? "同じ店舗に、同じ名前・同じ入店年月のキャストが登録済みです。" : error.message,
        },
        { status: error.code === "23505" ? 409 : 500 },
      );
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, message: "kind が不正です。" }, { status: 400 });
}

export async function PATCH(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ ok: false, message: "id が不正です。" }, { status: 400 });
  const admin = createAdminClient();

  if (body?.kind === "store") {
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 60);
    if (typeof body.sort_order === "number") patch.sort_order = body.sort_order;
    if (typeof body.active === "boolean") patch.active = body.active;
    const { error } = await admin.from("stores").update(patch).eq("id", id);
    if (error) {
      return NextResponse.json(
        { ok: false, message: error.code === "23505" ? "同じ名前の店舗があります。" : error.message },
        { status: error.code === "23505" ? 409 : 500 },
      );
    }
    return NextResponse.json({ ok: true });
  }

  if (body?.kind === "cast") {
    const patch: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 60);
    if (typeof body.store_id === "string" && body.store_id) patch.store_id = body.store_id;
    const joinedYm = normalizeYm(body.joined_ym);
    if (joinedYm === undefined && body.joined_ym !== undefined) {
      return NextResponse.json({ ok: false, message: "入店年月は YYYYMM または YYYY-MM で入力してください。" }, { status: 400 });
    }
    if (joinedYm !== undefined) patch.joined_ym = joinedYm;
    if (typeof body.note === "string") patch.note = body.note.trim().slice(0, 200) || null;
    if (typeof body.active === "boolean") patch.active = body.active;
    const { error } = await admin.from("casts").update(patch).eq("id", id);
    if (error) {
      return NextResponse.json(
        {
          ok: false,
          message: error.code === "23505" ? "同じ店舗に、同じ名前・同じ入店年月のキャストが登録済みです。" : error.message,
        },
        { status: error.code === "23505" ? 409 : 500 },
      );
    }
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: false, message: "kind が不正です。" }, { status: 400 });
}

export async function DELETE(request: Request) {
  if (!(await requireAdmin())) {
    return NextResponse.json({ ok: false, message: "権限がありません。" }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ ok: false, message: "id が不正です。" }, { status: 400 });
  const admin = createAdminClient();

  const table = body?.kind === "store" ? "stores" : body?.kind === "cast" ? "casts" : null;
  if (!table) return NextResponse.json({ ok: false, message: "kind が不正です。" }, { status: 400 });

  const { error } = await admin.from(table).delete().eq("id", id);
  if (error) return NextResponse.json({ ok: false, message: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

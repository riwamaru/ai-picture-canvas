import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * メールのログインリンクの着地点。
 *
 * Supabase の設定（PKCE か否か）でリンクの形が変わるため、両方を受ける：
 *   - ?code=...                    → exchangeCodeForSession
 *   - ?token_hash=...&type=...     → verifyOtp
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}/`);
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent("リンクの有効期限が切れています。もう一度お試しください。")}`,
    );
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(`${origin}/`);
    return NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent("リンクの有効期限が切れています。もう一度お試しください。")}`,
    );
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent("ログイン情報が読み取れませんでした。")}`,
  );
}

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * セッションの更新と、未ログインの締め出し。
 *
 * ★ ここが唯一の入口ではない。API ルート側でも必ず getUser() を確認している。
 *   middleware だけに頼ると、マッチャの書き間違いがそのまま認証の穴になる。
 */
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // getSession() ではなく getUser()。Cookie の中身を信用せず、毎回サーバーで検証する。
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = path.startsWith("/login") || path.startsWith("/auth");

  // API はリダイレクトしない。HTML の /login を返すと、
  // fetch した側は JSON を期待しているので解析に失敗し、
  // 「ログインが切れた」ではなく「通信が途切れた」に見えてしまう。
  // 各ルートハンドラが自分で 401 の JSON を返す。
  if (path.startsWith("/api/")) {
    return response;
  }

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

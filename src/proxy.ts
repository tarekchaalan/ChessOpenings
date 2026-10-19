import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Keeps Supabase auth cookies fresh. No-op when Supabase isn't configured.
 *
 * Also rescues email links that missed the callback: when a redirect URL
 * isn't on the project's allow list, Supabase falls back to the Site URL, so
 * `?code=` / `?token_hash=` arrive on a page that would ignore them.
 */
export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.next();

  const { pathname, searchParams } = request.nextUrl;
  if (
    request.method === "GET" &&
    !pathname.startsWith("/auth/callback") &&
    !pathname.startsWith("/api/") &&
    (searchParams.has("code") || searchParams.has("token_hash") || searchParams.has("error_code"))
  ) {
    const to = request.nextUrl.clone();
    to.pathname = "/auth/callback";
    if (!searchParams.has("next") && pathname !== "/") to.searchParams.set("next", pathname);
    return NextResponse.redirect(to);
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies) => {
        cookies.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookies.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });
  await supabase.auth.getUser();
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|data/|engine/|.*\\.(?:svg|png|jpg|jpeg|gif|webp|json)$).*)"],
};

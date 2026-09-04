import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "extrema_session";
const SESSION_MAX_AGE = 30 * 60;

function backendBaseUrl() {
  return process.env.BACKEND_API_URL || "http://127.0.0.1:3001/api";
}

async function proxy(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  const { path } = await context.params;
  const pathname = "/" + path.join("/");
  const target = backendBaseUrl().replace(/\/$/, "") + pathname;

  const headers = new Headers();
  headers.set("content-type", request.headers.get("content-type") || "application/json");
  headers.set(
    "x-extrema-origin",
    request.headers.get("x-extrema-browser-origin") ||
      request.headers.get("origin") ||
      request.nextUrl.origin,
  );

  const session = request.cookies.get(COOKIE_NAME)?.value;
  if (session) headers.set("authorization", `Bearer ${session}`);

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json(
      { error: "backend_unreachable" },
      { status: 503 },
    );
  }

  const text = await upstream.text();
  let payload: Record<string, unknown> = {};

  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = { error: "invalid_backend_response" };
    }
  }

  const isAuthFinish =
    pathname === "/auth/register/finish" ||
    pathname === "/auth/login/finish";

  let token: string | null = null;
  if (isAuthFinish && upstream.ok && typeof payload.token === "string") {
    token = payload.token;
    delete payload.token;
  }

  const response = NextResponse.json(payload, { status: upstream.status });

  if (token) {
    response.cookies.set({
      name: COOKIE_NAME,
      value: token,
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
  }

  if (pathname === "/auth/logout") {
    response.cookies.set({
      name: COOKIE_NAME,
      value: "",
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "strict",
      path: "/",
      maxAge: 0,
    });
  }

  return response;
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;

import { NextResponse } from "next/server";
import crypto from "crypto";
import { getOAuthClient, YOUTUBE_SCOPES } from "@/lib/googleAuth";

export const dynamic = "force-dynamic";

/** Початок OAuth: редірект на сторінку згоди Google. */
export async function GET() {
  try {
    const state = crypto.randomBytes(16).toString("hex");
    const url = getOAuthClient().generateAuthUrl({
      access_type: "offline", // потрібен refresh_token для worker
      prompt: "consent",
      scope: YOUTUBE_SCOPES,
      state,
    });
    const res = NextResponse.redirect(url);
    res.cookies.set("google_oauth_state", state, {
      httpOnly: true,
      maxAge: 600,
      path: "/",
    });
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/auth/logout/route";

describe("session logout", () => {
  it("expires the httpOnly application session cookie", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/auth/logout"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ signedOut: true });
    const cookie = response.cookies.get("od_session");
    expect(cookie?.value).toBe("");
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.maxAge).toBe(0);
    expect(cookie?.path).toBe("/");
  });
});

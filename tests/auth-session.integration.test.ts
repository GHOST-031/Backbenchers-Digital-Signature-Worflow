import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as session } from "@/app/api/auth/session/route";
import {
  LocalAuthenticationService,
  authenticationService,
} from "@/services/auth";

const enabled = Boolean(process.env.FOUNDATION_DB_TEST);
const password = "a secure integration password";

async function signIn(email: string): Promise<string> {
  const response = await login(
    new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }),
  );
  expect(response.status).toBe(200);
  const token = response.cookies.get("od_session")?.value;
  expect(token).toBeTruthy();
  return token as string;
}

async function checkSession(token: string) {
  return session(
    new NextRequest("http://localhost/api/auth/session", {
      headers: { cookie: `od_session=${token}` },
    }),
  );
}

describe.skipIf(!enabled)("PostgreSQL session revocation", () => {
  it("revokes only the logged-out token and keeps old tokens invalid after a new login", async () => {
    const suffix = randomUUID();
    const email = `session-${suffix}@example.test`;
    const otherEmail = `other-session-${suffix}@example.test`;
    await authenticationService.register(email, "Session owner", password);
    await authenticationService.register(otherEmail, "Other user", password);

    const oldToken = await signIn(email);
    const anotherUserToken = await signIn(otherEmail);
    expect((await checkSession(oldToken)).status).toBe(200);
    expect(await authenticationService.readSession(oldToken)).toMatchObject({
      email,
    });

    const logoutResponse = await logout(
      new NextRequest("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { cookie: `od_session=${oldToken}` },
      }),
    );
    expect(logoutResponse.status).toBe(200);
    expect(logoutResponse.cookies.get("od_session")?.maxAge).toBe(0);
    expect((await checkSession(oldToken)).status).toBe(401);
    await expect(
      authenticationService.readSession(oldToken),
    ).resolves.toBeNull();
    await expect(
      new LocalAuthenticationService().readSession(oldToken),
    ).resolves.toBeNull();
    await expect(
      authenticationService.readSession(anotherUserToken),
    ).resolves.toMatchObject({ email: otherEmail });

    const newToken = await signIn(email);
    expect(newToken).not.toBe(oldToken);
    expect((await checkSession(newToken)).status).toBe(200);
    await expect(
      authenticationService.readSession(newToken),
    ).resolves.toMatchObject({
      email,
    });
    await expect(
      authenticationService.readSession(oldToken),
    ).resolves.toBeNull();
    expect((await checkSession(oldToken)).status).toBe(401);
    expect((await checkSession(anotherUserToken)).status).toBe(200);
  });
});

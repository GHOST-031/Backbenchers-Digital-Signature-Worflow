import {
  createHmac,
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { and, eq } from "drizzle-orm";
import { db, pool } from "@/db/client";
import { signers, users } from "@/db/schema";
import { config } from "@/config/env";

const scrypt = promisify(scryptCallback);
export interface AuthenticatedIdentity {
  userId: string;
  email: string;
  displayName: string;
}
export interface AuthenticationService {
  createPasswordHash(password: string): Promise<string>;
  verifyPassword(password: string, encoded: string): Promise<boolean>;
  issueSession(identity: AuthenticatedIdentity): string;
  readSession(
    cookie: string | undefined,
  ): Promise<AuthenticatedIdentity | null>;
  revokeSession(cookie: string | undefined): Promise<void>;
  authenticate(
    email: string,
    password: string,
  ): Promise<AuthenticatedIdentity | null>;
  register(
    email: string,
    displayName: string,
    password: string,
  ): Promise<AuthenticatedIdentity>;
}
export interface SessionRevocationStore {
  isRevoked(tokenDigest: Buffer): Promise<boolean>;
  revoke(tokenDigest: Buffer, userId: string, expiresAt: Date): Promise<void>;
}
class DatabaseSessionRevocationStore implements SessionRevocationStore {
  async isRevoked(tokenDigest: Buffer): Promise<boolean> {
    const result = await pool.query(
      "select 1 from revoked_sessions where token_digest=$1 limit 1",
      [tokenDigest],
    );
    return result.rows.length > 0;
  }
  async revoke(
    tokenDigest: Buffer,
    userId: string,
    expiresAt: Date,
  ): Promise<void> {
    await pool.query(
      `insert into revoked_sessions (token_digest,user_id,expires_at)
       values ($1,$2,$3) on conflict (token_digest) do nothing`,
      [tokenDigest, userId, expiresAt],
    );
  }
}
export interface SignerPrincipal {
  userId: string;
  signerId: string;
  documentId: string;
}
export interface IdentityVerificationProvider {
  verifySigner(principal: SignerPrincipal): Promise<boolean>;
}
export class LocalIdentityVerificationProvider implements IdentityVerificationProvider {
  async verifySigner(principal: SignerPrincipal): Promise<boolean> {
    const [match] = await db
      .select({ id: signers.id })
      .from(signers)
      .where(
        and(
          eq(signers.userId, principal.userId),
          eq(signers.id, principal.signerId),
          eq(signers.documentId, principal.documentId),
        ),
      )
      .limit(1);
    return Boolean(match);
  }
}
export class LocalAuthenticationService implements AuthenticationService {
  constructor(
    private readonly sessionRevocations: SessionRevocationStore = new DatabaseSessionRevocationStore(),
  ) {}
  async createPasswordHash(password: string): Promise<string> {
    if (password.length < 12)
      throw new Error("Password must contain at least 12 characters");
    const salt = randomBytes(16);
    const derived = (await scrypt(password, salt, 64)) as Buffer;
    return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
  }
  async verifyPassword(password: string, encoded: string): Promise<boolean> {
    const [algorithm, saltHex, digestHex] = encoded.split("$");
    if (algorithm !== "scrypt" || !saltHex || !digestHex) return false;
    const expected = Buffer.from(digestHex, "hex");
    const actual = (await scrypt(
      password,
      Buffer.from(saltHex, "hex"),
      expected.length,
    )) as Buffer;
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
  issueSession(identity: AuthenticatedIdentity): string {
    const payload = Buffer.from(
      JSON.stringify({
        ...identity,
        sessionId: randomUUID(),
        expiresAt: Date.now() + 7 * 86400_000,
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", config.SESSION_SECRET)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }
  private decodeSession(
    cookie: string | undefined,
  ): (AuthenticatedIdentity & { expiresAt: number }) | null {
    if (!cookie) return null;
    const [payload, provided] = cookie.split(".");
    if (!payload || !provided) return null;
    const expected = createHmac("sha256", config.SESSION_SECRET)
      .update(payload)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(provided, "base64url");
    } catch {
      return null;
    }
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return null;
    try {
      const value = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as AuthenticatedIdentity & {
        sessionId: string;
        expiresAt: number;
      };
      if (
        !value.userId ||
        !value.email ||
        !value.sessionId ||
        value.expiresAt <= Date.now()
      )
        return null;
      return value;
    } catch {
      return null;
    }
  }
  async readSession(
    cookie: string | undefined,
  ): Promise<AuthenticatedIdentity | null> {
    const identity = this.decodeSession(cookie);
    if (!identity || !cookie) return null;
    try {
      const tokenDigest = createHash("sha256").update(cookie).digest();
      if (await this.sessionRevocations.isRevoked(tokenDigest)) return null;
      return {
        userId: identity.userId,
        email: identity.email,
        displayName: identity.displayName,
      };
    } catch {
      // A revocation-store outage must fail closed for authentication.
      return null;
    }
  }
  async revokeSession(cookie: string | undefined): Promise<void> {
    const identity = this.decodeSession(cookie);
    if (!identity || !cookie) return;
    const tokenDigest = createHash("sha256").update(cookie).digest();
    await this.sessionRevocations.revoke(
      tokenDigest,
      identity.userId,
      new Date(identity.expiresAt),
    );
  }
  async authenticate(
    email: string,
    password: string,
  ): Promise<AuthenticatedIdentity | null> {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    if (!user || !(await this.verifyPassword(password, user.passwordHash)))
      return null;
    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
    };
  }
  async register(
    email: string,
    displayName: string,
    password: string,
  ): Promise<AuthenticatedIdentity> {
    const [user] = await db
      .insert(users)
      .values({
        email: email.toLowerCase(),
        displayName,
        passwordHash: await this.createPasswordHash(password),
      })
      .returning({
        userId: users.id,
        email: users.email,
        displayName: users.displayName,
      });
    if (!user) throw new Error("Account creation failed");
    return user;
  }
}
export const authenticationService: AuthenticationService =
  new LocalAuthenticationService();
export const identityVerificationProvider: IdentityVerificationProvider =
  new LocalIdentityVerificationProvider();

import dotenv from "dotenv";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";

// Drizzle CLI does not load Next.js' .env.local file automatically.
dotenv.config({ path: ".env.local" });
dotenv.config();

const schema = z.object({
  DATABASE_URL: z.string().refine((value) => {
    try {
      const protocol = new URL(value).protocol;
      return protocol === "postgres:" || protocol === "postgresql:";
    } catch {
      return false;
    }
  }, "Expected a PostgreSQL connection URL"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  STORAGE_ROOT: z.string().min(1).default(".data/private-documents"),
  SESSION_SECRET: z.string().min(32),
  SIGNING_PRIVATE_KEY_B64: z.string().min(1),
  SIGNING_PUBLIC_KEY_B64: z.string().min(1),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issueList = parsed.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${issueList}`);
}
export const config = parsed.data;
try {
  const privateKey = createPrivateKey(
    Buffer.from(config.SIGNING_PRIVATE_KEY_B64, "base64"),
  );
  const publicKey = createPublicKey(
    Buffer.from(config.SIGNING_PUBLIC_KEY_B64, "base64"),
  );
  if (
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("Signing keys must use Ed25519");
  }
  const probe = Buffer.from("od-signing-key-pair-check");
  if (!verify(null, probe, publicKey, sign(null, probe, privateKey))) {
    throw new Error("Private and public signing keys do not match");
  }
} catch (error) {
  throw new Error(
    `Invalid signing key configuration: ${error instanceof Error ? error.message : "unknown key error"}`,
  );
}

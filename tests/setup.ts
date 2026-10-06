import { generateKeyPairSync } from "node:crypto";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
process.env.DATABASE_URL ??=
  "postgres://postgres:postgres@localhost:5432/od_signing_test";
process.env.APP_URL ??= "http://localhost:3000";
process.env.STORAGE_ROOT ??= "/tmp/od-signing-test-storage";
process.env.SESSION_SECRET ??=
  "test-only-session-secret-long-enough-to-be-valid";
process.env.SIGNING_PRIVATE_KEY_B64 ??= Buffer.from(
  privateKey.export({ type: "pkcs8", format: "pem" }),
).toString("base64");
process.env.SIGNING_PUBLIC_KEY_B64 ??= Buffer.from(
  publicKey.export({ type: "spki", format: "pem" }),
).toString("base64");
Object.assign(process.env, { NODE_ENV: "test" });

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

if (existsSync(".env.local")) {
  console.error(
    ".env.local already exists; refusing to overwrite local secrets.",
  );
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
writeFileSync(
  ".env.local",
  [
    "DATABASE_URL=postgres://postgres:postgres@localhost:5432/od_signing",
    "APP_URL=http://localhost:3000",
    "STORAGE_ROOT=.data/private-documents",
    `SESSION_SECRET=${randomBytes(32).toString("base64url")}`,
    `SIGNING_PRIVATE_KEY_B64=${Buffer.from(privateKey).toString("base64")}`,
    `SIGNING_PUBLIC_KEY_B64=${Buffer.from(publicKey).toString("base64")}`,
    "NODE_ENV=development",
    "",
  ].join("\n"),
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Created .env.local with a fresh development-only Ed25519 keypair. Keep it private and out of version control.",
);

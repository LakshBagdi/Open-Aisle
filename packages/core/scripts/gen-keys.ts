/**
 * Print a new Ed25519 private key (JWK) for RULES_SIGNING_KEY, and a random
 * CONFIRM_TOKEN_SECRET. Paste both into .env (never commit them).
 *
 *   pnpm --filter @open-aisle/core tsx scripts/gen-keys.ts
 */
import { randomBytes } from "node:crypto";
import { exportJWK, generateKeyPair } from "jose";

const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
const jwk = await exportJWK(privateKey);
console.log(`RULES_SIGNING_KEY='${JSON.stringify(jwk)}'`);
console.log(`CONFIRM_TOKEN_SECRET=${randomBytes(32).toString("base64url")}`);

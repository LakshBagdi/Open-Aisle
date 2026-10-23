/**
 * Spending rules are signed, like a stamped form.
 *
 * When the person (or their helper) sets "max $80 per order, $300 a month",
 * we store the numbers AND a signed copy (JWS). Before every payment the
 * server checks the signature: if anyone changed the numbers in the database
 * without re-signing, the check fails and nothing is paid.
 *
 * Production: Ed25519 key pair (RULES_SIGNING_KEY = private JWK). Generate one
 * with `pnpm --filter @open-aisle/core tsx scripts/gen-keys.ts`.
 * Local development without a key: HMAC with CONFIRM_TOKEN_SECRET.
 */
import { importJWK, jwtVerify, SignJWT, type JWK } from "jose";
import { env } from "../env";

export type RulesPayload = {
  userId: string;
  perOrderCents: number;
  monthlyCents: number;
  allowedStoreIds: string[];
  undoWindowSeconds: number;
  version: number;
};

type Keys = { alg: "EdDSA" | "HS256"; sign: CryptoKey | Uint8Array; verify: CryptoKey | Uint8Array };
let keys: Promise<Keys> | undefined;

function loadKeys(): Promise<Keys> {
  if (!keys) {
    keys = (async () => {
      const raw = env().RULES_SIGNING_KEY;
      if (raw) {
        const jwk = JSON.parse(raw) as JWK;
        const { d: _private, ...publicJwk } = jwk;
        return {
          alg: "EdDSA",
          sign: (await importJWK({ ...jwk, alg: "EdDSA" }, "EdDSA")) as CryptoKey,
          verify: (await importJWK({ ...publicJwk, alg: "EdDSA" }, "EdDSA")) as CryptoKey,
        };
      }
      const secret = new TextEncoder().encode(env().CONFIRM_TOKEN_SECRET);
      return { alg: "HS256", sign: secret, verify: secret };
    })();
  }
  return keys;
}

export function resetSigningKeys() {
  keys = undefined;
}

export async function signRules(payload: RulesPayload): Promise<string> {
  const k = await loadKeys();
  return new SignJWT({ rules: payload })
    .setProtectedHeader({ alg: k.alg, typ: "open-aisle-rules" })
    .setIssuedAt()
    .setSubject(payload.userId)
    .sign(k.sign);
}

/** Returns the signed rules, or throws if the signature is wrong. */
export async function verifyRules(jws: string): Promise<RulesPayload> {
  const k = await loadKeys();
  const { payload } = await jwtVerify(jws, k.verify, { algorithms: [k.alg], typ: "open-aisle-rules" });
  return (payload as { rules: RulesPayload }).rules;
}

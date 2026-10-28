// Firebase sign-in check: the app sends the signed-in person's Firebase ID token ("Authorization: Bearer …").
// It is a JWT signed by Google (RS256); verified here with Google's public keys, so scans can be counted per person
// and a copied app key alone is not enough. Workers runtime (WebCrypto) only, no libraries.

export const GOOGLE_KEYS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_S = 300;

export type Jwk = JsonWebKey & { kid: string };
export type KeyFetcher = (force: boolean) => Promise<Jwk[]>;
export type TokenCheck = { ok: true; uid: string } | { ok: false; error: string };

// Google's keys change every few hours; kept in memory as long as Google's Cache-Control allows
let cached: { keys: Jwk[]; until: number } | null = null;

export const fetchGoogleKeys: KeyFetcher = async force => {
  if (!force && cached && cached.until > Date.now()) return cached.keys;
  const res = await fetch(GOOGLE_KEYS_URL);
  if (!res.ok) throw new Error(`keys ${res.status}`);
  const { keys } = await res.json() as { keys: Jwk[] };
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') || '')?.[1] || '3600');
  cached = { keys, until: Date.now() + Math.min(maxAge, 6 * 3600) * 1000 };
  return keys;
};

const b64urlBytes = (s: string): Uint8Array => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlJson = (s: string): Record<string, unknown> => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

/** Checks a Firebase ID token for `projectId`: Google's signature, issuer, audience, times and user id. */
export const verifyFirebaseToken = async (
  token: string, projectId: string, now = Date.now(), getKeys: KeyFetcher = fetchGoogleKeys,
): Promise<TokenCheck> => {
  if (!projectId) return { ok: false, error: 'not_configured' };
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 4096) return { ok: false, error: 'malformed' };
  let header: Record<string, unknown>, claims: Record<string, unknown>;
  try { header = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { return { ok: false, error: 'malformed' }; }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return { ok: false, error: 'bad_header' };

  const nowS = Math.floor(now / 1000);
  if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}`) return { ok: false, error: 'wrong_project' };
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) return { ok: false, error: 'no_user' };
  if (typeof claims.exp !== 'number' || claims.exp <= nowS) return { ok: false, error: 'expired' };
  if (typeof claims.iat !== 'number' || claims.iat > nowS + CLOCK_SKEW_S) return { ok: false, error: 'not_yet_valid' };

  let jwk: Jwk | undefined;
  try {
    jwk = (await getKeys(false)).find(k => k.kid === header.kid);
    if (!jwk) jwk = (await getKeys(true)).find(k => k.kid === header.kid);   // Google rotated its keys
  } catch { return { ok: false, error: 'keys_unavailable' }; }
  if (!jwk) return { ok: false, error: 'unknown_key' };

  try {
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    return valid ? { ok: true, uid: claims.sub } : { ok: false, error: 'bad_signature' };
  } catch { return { ok: false, error: 'bad_signature' }; }
};

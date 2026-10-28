import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verifyFirebaseToken, type Jwk } from '../src/auth';
import worker, { setKeyFetcherForTests, type Env } from '../src/index';

// A test key pair stands in for Google's signing key
const PROJECT = 'demo-kirana';
const NOW = Date.UTC(2026, 9, 28, 6, 0, 0);
let privateKey: CryptoKey;
let publicJwk: Jwk;
let otherPrivate: CryptoKey;

const b64url = (bytes: Uint8Array | string) => {
  const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  let bin = '';
  b.forEach(x => { bin += String.fromCharCode(x); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const sign = async (claims: Record<string, unknown>, opts: { kid?: string; key?: CryptoKey; alg?: string } = {}) => {
  const head = b64url(JSON.stringify({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' }));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', opts.key ?? privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
};

const goodClaims = (over: Record<string, unknown> = {}) => ({
  iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'user-123',
  iat: NOW / 1000 - 60, exp: NOW / 1000 + 3000, ...over,
});

const keys = async () => [publicJwk];

beforeAll(async () => {
  const gen = () => crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
  const pair = await gen();
  privateKey = pair.privateKey;
  publicJwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1' } as Jwk;
  otherPrivate = (await gen()).privateKey;
});

describe('verifyFirebaseToken', () => {
  it('accepts a token Google signed for this project', async () => {
    expect(await verifyFirebaseToken(await sign(goodClaims()), PROJECT, NOW, keys)).toEqual({ ok: true, uid: 'user-123' });
  });

  it('refuses tokens that are forged, expired, for another project or malformed', async () => {
    const bad = async (token: string, error: string) =>
      expect(await verifyFirebaseToken(token, PROJECT, NOW, keys)).toEqual({ ok: false, error });
    await bad(await sign(goodClaims(), { key: otherPrivate }), 'bad_signature');
    await bad(await sign(goodClaims({ exp: NOW / 1000 - 1 })), 'expired');
    await bad(await sign(goodClaims({ aud: 'someone-else' })), 'wrong_project');
    await bad(await sign(goodClaims({ iss: 'https://evil.example' })), 'wrong_project');
    await bad(await sign(goodClaims({ sub: '' })), 'no_user');
    await bad(await sign(goodClaims({ iat: NOW / 1000 + 3600 })), 'not_yet_valid');
    await bad(await sign(goodClaims(), { kid: 'unknown' }), 'unknown_key');
    await bad(await sign(goodClaims(), { alg: 'none' }), 'bad_header');
    await bad('not.a.token', 'malformed');
    // a valid token with its claims changed afterwards
    const [h, , s] = (await sign(goodClaims())).split('.');
    await bad(`${h}.${b64url(JSON.stringify(goodClaims({ sub: 'admin' })))}.${s}`, 'bad_signature');
  });

  it('fetches the keys again when Google has rotated them', async () => {
    const fetcher = vi.fn(async (force: boolean) => (force ? [publicJwk] : []));
    expect(await verifyFirebaseToken(await sign(goodClaims()), PROJECT, NOW, fetcher)).toEqual({ ok: true, uid: 'user-123' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// ── The worker with sign-in ──

const APP_KEY = 'app-key-0123456789abcdef';
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD';
const answer = { name_eng: 'X', name_marathi: null, brand: null, net_qty: null, mrp: 10, mfg_date: null, expiry_date: null, barcode: null, confidence: {} };

const makeEnv = (over: Partial<Env> = {}): Env => {
  const store = new Map<string, string>();
  return {
    GEMINI_API_KEY: 'k', APP_KEY, GEMINI_MODEL: 'm', DAILY_CAP: '100', ENABLED: 'true',
    USAGE: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => { store.set(k, v); } } as unknown as KVNamespace,
    DEVICE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit,
    FIREBASE_PROJECT_ID: PROJECT, USER_DAILY_CAP: '2', ...over,
  };
};
const req = (headers: Record<string, string> = {}) => new Request('https://w.example/read', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-app-key': APP_KEY, 'x-device-id': 'device-12345678', ...headers },
  body: JSON.stringify({ images: [jpeg] }),
});

describe('worker sign-in', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  const setup = () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setKeyFetcherForTests(keys);
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }))));
  };

  it('a signed-in person gets their own daily limit', async () => {
    setup();
    const env = makeEnv();
    const auth = { authorization: `Bearer ${await sign(goodClaims())}` };
    expect((await worker.fetch(req(auth), env)).status).toBe(200);
    expect((await worker.fetch(req(auth), env)).status).toBe(200);
    const third = await worker.fetch(req(auth), env);
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: 'user_daily_cap' });
    // someone else is not affected
    const other = { authorization: `Bearer ${await sign(goodClaims({ sub: 'user-456' }))}` };
    expect((await worker.fetch(req(other), env)).status).toBe(200);
  });

  it('a bad token is refused; no token is refused only when sign-in is required', async () => {
    setup();
    const forged = { authorization: `Bearer ${await sign(goodClaims(), { key: otherPrivate })}` };
    const r1 = await worker.fetch(req(forged), makeEnv());
    expect(r1.status).toBe(401);
    expect(await r1.json()).toMatchObject({ error: 'bad_sign_in' });
    expect((await worker.fetch(req(), makeEnv())).status).toBe(200);
    const r2 = await worker.fetch(req(), makeEnv({ REQUIRE_SIGN_IN: 'true' }));
    expect(r2.status).toBe(401);
    expect(await r2.json()).toMatchObject({ error: 'sign_in_required' });
  });
});

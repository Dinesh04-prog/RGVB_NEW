// Gemini pack reader for NexusPOS "Fill from Photos". Cloudflare Workers free plan.
//
// POST /read  headers: X-App-Key, X-Device-Id   body: {"images":["<base64 JPEG>", ...]} (1–5, exactly this shape)
// → 200 {"ok":true,"model":..,"read":{..},"problems":[..],"raw":"<model JSON text>"}
// → 4xx/5xx {"ok":false,"error":"disabled|unauthorized|bad_device|rate_limited|daily_cap|too_large|bad_request|
//                                bad_image_count|not_jpeg|quota|upstream|timeout|bad_answer"}
//
// Never logs the app key, the API key or image data: only error codes.
import {
  MAX_BODY_BYTES, RESPONSE_SCHEMA, SYSTEM_PROMPT, answerText, parseImagesBody, quotaDay, safeEqual, validateRead,
} from './validate';
import { verifyFirebaseToken, fetchGoogleKeys, type KeyFetcher } from './auth';

export interface Env {
  GEMINI_API_KEY: string;        // secret
  APP_KEY: string;               // secret, sent by the app as X-App-Key
  APP_KEY_PREVIOUS?: string;     // secret, optional: still accepted while phones update after a key rotation
  GEMINI_MODEL: string;          // var, e.g. "gemini-3.5-flash-lite"
  DAILY_CAP: string;             // var, scans per Pacific day for all devices together
  ENABLED: string;               // var, "true" to serve; anything else = off (kill switch)
  USAGE: KVNamespace;            // daily counter
  DEVICE_LIMITER: RateLimit;     // 6 requests / 60 s per device (per signed-in person when signed in)
  FIREBASE_PROJECT_ID?: string;  // var: Firebase project whose sign-in tokens are accepted
  REQUIRE_SIGN_IN?: string;      // var: "true" = refuse scans without a valid Firebase sign-in token
  USER_DAILY_CAP?: string;       // var: scans per signed-in person per Pacific day
}

// Replaceable in tests (Google's real public keys otherwise)
let getGoogleKeys: KeyFetcher = fetchGoogleKeys;
export const setKeyFetcherForTests = (f: KeyFetcher) => { getGoogleKeys = f; };

const GEMINI_TIMEOUT_MS = 20_000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status: number, error: string) => {
  console.log(`read failed: ${error}`);   // error code only
  return json(status, { ok: false, error });
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/read') return fail(404, 'not_found');
    if (request.method !== 'POST') return fail(405, 'method_not_allowed');
    if (env.ENABLED !== 'true') return fail(503, 'disabled');

    const key = request.headers.get('x-app-key') || '';
    if (!(safeEqual(key, env.APP_KEY || '') || safeEqual(key, env.APP_KEY_PREVIOUS || ''))) return fail(401, 'unauthorized');
    const device = request.headers.get('x-device-id') || '';
    if (!/^[A-Za-z0-9-]{8,64}$/.test(device)) return fail(400, 'bad_device');

    // Signed-in person (Firebase ID token): counted and limited per person, not per shared key
    const authz = request.headers.get('authorization') || '';
    let uid = '';
    if (authz.startsWith('Bearer ')) {
      const check = await verifyFirebaseToken(authz.slice(7).trim(), env.FIREBASE_PROJECT_ID || '', Date.now(), getGoogleKeys);
      if (!check.ok) return fail(401, 'bad_sign_in');
      uid = check.uid;
    } else if (env.REQUIRE_SIGN_IN === 'true') {
      return fail(401, 'sign_in_required');
    }

    const { success } = await env.DEVICE_LIMITER.limit({ key: uid ? `user:${uid}` : device });
    if (!success) return fail(429, 'rate_limited');

    const declared = Number(request.headers.get('content-length') || '0');
    if (declared > MAX_BODY_BYTES) return fail(413, 'too_large');
    const text = await request.text();
    const checked = parseImagesBody(text);
    if (!checked.ok) return fail(checked.error === 'too_large' ? 413 : 400, checked.error);

    // Global daily cap (KV is eventually consistent, so it can overshoot by a few on bursts; set it well under the quota)
    const cap = Number(env.DAILY_CAP || '150');
    const dayKey = `scans:${quotaDay(new Date())}`;
    const used = Number((await env.USAGE.get(dayKey)) || '0');
    if (used >= cap) return fail(429, 'daily_cap');
    // Each signed-in person's share of the day, so one heavy user cannot use up everyone's free quota
    if (uid) {
      const userKey = `user:${uid}:${quotaDay(new Date())}`;
      const userUsed = Number((await env.USAGE.get(userKey)) || '0');
      if (userUsed >= Number(env.USER_DAILY_CAP || '20')) return fail(429, 'user_daily_cap');
      await env.USAGE.put(userKey, String(userUsed + 1), { expirationTtl: 3 * 24 * 3600 });
    }
    await env.USAGE.put(dayKey, String(used + 1), { expirationTtl: 3 * 24 * 3600 });

    const model = env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
    // Small parts via JSON.stringify; the photos are spliced in as they are (checked plain base64, see parseImagesBody)
    const head = JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 },
    }).slice(0, -1);
    const prompt = JSON.stringify({ text: `${checked.images.length} photo(s) of the same pack. Return the JSON.` });
    const imageParts = checked.images.map(b64 => `{"inline_data":{"mime_type":"image/jpeg","data":"${b64}"}}`).join(',');
    const payload = `${head},"contents":[{"role":"user","parts":[${prompt},${imageParts}]}]}`;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), GEMINI_TIMEOUT_MS);
    let resp: Response;
    try {
      resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body: payload,
        signal: abort.signal,
      });
    } catch {
      return fail(504, abort.signal.aborted ? 'timeout' : 'upstream');
    } finally {
      clearTimeout(timer);
    }
    if (resp.status === 429) return fail(429, 'quota');
    if (!resp.ok) return fail(502, `upstream_${resp.status}`);

    let answer: string | null;
    try { answer = answerText(await resp.json()); } catch { return fail(502, 'bad_answer'); }
    if (!answer) return fail(502, 'bad_answer');
    let parsed: unknown;
    try { parsed = JSON.parse(answer); } catch { return fail(502, 'bad_answer'); }
    const { read, problems } = validateRead(parsed);
    return json(200, { ok: true, model, read, problems, raw: answer.slice(0, 4000) });
  },
};

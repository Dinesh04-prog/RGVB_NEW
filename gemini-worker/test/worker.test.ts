import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { type Env } from '../src/index';

const API_KEY = 'AIza-test-api-key-123';
const APP_KEY = 'app-key-0123456789abcdef';
const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD';

const makeEnv = (over: Partial<Env> = {}, limited = false): Env => {
  const store = new Map<string, string>();
  return {
    GEMINI_API_KEY: API_KEY, APP_KEY, GEMINI_MODEL: 'gemini-3.5-flash-lite', DAILY_CAP: '2', ENABLED: 'true',
    USAGE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => { store.set(k, v); },
    } as unknown as KVNamespace,
    DEVICE_LIMITER: { limit: async () => ({ success: !limited }) } as unknown as RateLimit,
    ...over,
  };
};

const req = (body: unknown = { images: [jpeg] }, headers: Record<string, string> = {}) =>
  new Request('https://w.example/read', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-app-key': APP_KEY, 'x-device-id': 'device-12345678', ...headers },
    body: JSON.stringify(body),
  });

const geminiAnswer = (obj: unknown, status = 200) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] }), { status });

const good = {
  name_eng: 'Tasty Nuts Shing Bhujia', name_marathi: null, brand: 'Tasty Nuts', net_qty: '38 g', mrp: 10,
  mfg_date: null, expiry_date: null, barcode: null,
  confidence: { name_eng: 0.9, name_marathi: 0, brand: 0.9, net_qty: 0.85, mrp: 0.9, mfg_date: 0, expiry_date: 0, barcode: 0 },
};

let logs: string[];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('worker', () => {
  it('reads a pack', async () => {
    const fetchMock = vi.fn(async () => geminiAnswer(good));
    vi.stubGlobal('fetch', fetchMock);
    const res = await worker.fetch(req(), makeEnv());
    const body = await res.json() as { ok: boolean; read: { mrp: number; net_qty: string }; model: string };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.read.mrp).toBe(10);
    expect(body.model).toBe('gemini-3.5-flash-lite');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/models/gemini-3.5-flash-lite:generateContent');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe(API_KEY);   // key only in the header
    expect(url).not.toContain(API_KEY);
  });

  it('kill switch', async () => {
    const res = await worker.fetch(req(), makeEnv({ ENABLED: 'false' }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, error: 'disabled' });
  });

  it('auth: wrong or missing key; previous key accepted during rotation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => geminiAnswer(good)));
    expect((await worker.fetch(req(undefined, { 'x-app-key': 'nope' }), makeEnv())).status).toBe(401);
    expect((await worker.fetch(req(undefined, { 'x-app-key': '' }), makeEnv())).status).toBe(401);
    expect((await worker.fetch(req(undefined, { 'x-app-key': 'old-key-123' }), makeEnv({ APP_KEY_PREVIOUS: 'old-key-123' }))).status).toBe(200);
    expect((await worker.fetch(req(undefined, { 'x-app-key': '' }), makeEnv({ APP_KEY_PREVIOUS: '' }))).status).toBe(401);
  });

  it('device id, per-device rate limit and daily cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => geminiAnswer(good)));
    expect((await worker.fetch(req(undefined, { 'x-device-id': 'x' }), makeEnv())).status).toBe(400);
    expect((await worker.fetch(req(), makeEnv({}, true))).status).toBe(429);
    const env = makeEnv();
    expect((await worker.fetch(req(), env)).status).toBe(200);
    expect((await worker.fetch(req(), env)).status).toBe(200);
    const third = await worker.fetch(req(), env);
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ ok: false, error: 'daily_cap' });
  });

  it('size and image checks', async () => {
    expect((await worker.fetch(req(undefined, { 'content-length': '2000000' }), makeEnv())).status).toBe(413);
    expect((await worker.fetch(req({ images: [] }), makeEnv())).status).toBe(400);
    expect((await worker.fetch(req({ images: ['iVBOR'] }), makeEnv())).status).toBe(400);
  });

  it('builds valid JSON for Gemini with the photos spliced in', async () => {
    const fetchMock = vi.fn(async () => geminiAnswer(good));
    vi.stubGlobal('fetch', fetchMock);
    await worker.fetch(req({ images: [jpeg, jpeg + 'B'] }), makeEnv());
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.contents[0].parts.map((p: { inline_data?: { data: string } }) => p.inline_data?.data)).toEqual([undefined, jpeg, jpeg + 'B']);
    expect(sent.generationConfig.responseMimeType).toBe('application/json');
    expect(sent.systemInstruction.parts[0].text).toContain('Never guess');
  });

  it('Gemini failures become short error codes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429 })));
    expect(await (await worker.fetch(req(), makeEnv())).json()).toEqual({ ok: false, error: 'quota' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    expect(await (await worker.fetch(req(), makeEnv())).json()).toEqual({ ok: false, error: 'upstream_500' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }))));
    expect(await (await worker.fetch(req(), makeEnv())).json()).toEqual({ ok: false, error: 'bad_answer' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network'); }));
    expect(await (await worker.fetch(req(), makeEnv())).json()).toEqual({ ok: false, error: 'upstream' });
  });

  it('never logs the keys or image data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await worker.fetch(req(), makeEnv());
    await worker.fetch(req(undefined, { 'x-app-key': 'wrong' }), makeEnv());
    const all = logs.join('\n');
    expect(all).not.toContain(API_KEY);
    expect(all).not.toContain(APP_KEY);
    expect(all).not.toContain(jpeg);
  });
});

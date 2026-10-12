// Rough local estimate of the Worker's own CPU time per scan (the free plan allows 10 ms per request).
// Runs the bundled Worker (npx wrangler deploy --dry-run --outdir dist) in Node with Gemini mocked, for a
// maximum-size request: 5 JPEGs, ~1.45 MB of base64 in total. Waiting on Gemini is not CPU time on Workers,
// so only the Worker's parse / check / build steps are timed here. Node on a PC is not the Workers runtime:
// treat the numbers as an order of magnitude only.
import { performance } from 'node:perf_hooks';

const { default: worker } = await import('../dist/index.js');

const image = '/9j/' + 'A'.repeat(290_000 - 4);   // ~290 KB of base64 per photo (≈ a 1280 px JPEG at quality 80)
const body = JSON.stringify({ images: Array.from({ length: 5 }, () => image) });
const answer = JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
  name_eng: 'Tasty Nuts Shing Bhujia', name_marathi: null, brand: 'Tasty Nuts', net_qty: '38 g', mrp: 10,
  mfg_date: null, expiry_date: null, barcode: null,
  confidence: { name_eng: 0.9, name_marathi: 0, brand: 0.9, net_qty: 0.9, mrp: 0.9, mfg_date: 0, expiry_date: 0, barcode: 0 },
}) }] } }] });
globalThis.fetch = async () => new Response(answer);   // Gemini mocked: no network wait in the timing
const store = new Map();
const env = {
  GEMINI_API_KEY: 'k', APP_KEY: 'app-key-123456', GEMINI_MODEL: 'gemini-3.5-flash-lite', DAILY_CAP: '1000000', ENABLED: 'true',
  USAGE: { get: async k => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); } },
  DEVICE_LIMITER: { limit: async () => ({ success: true }) },
};
const make = () => new Request('https://w.example/read', {
  method: 'POST', headers: { 'x-app-key': 'app-key-123456', 'x-device-id': 'device-12345678' }, body,
});

console.log(`request body: ${(body.length / 1e6).toFixed(2)} MB`);
for (let i = 0; i < 5; i++) await worker.fetch(make(), env);   // warm-up (JIT)
const times = [];
for (let i = 0; i < 30; i++) {
  const req = make();
  const t = performance.now();
  const res = await worker.fetch(req, env);
  await res.text();
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.log(`worker time per scan (ms): median ${times[15].toFixed(2)}, p90 ${times[27].toFixed(2)}, max ${times[29].toFixed(2)}`);

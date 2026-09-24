// ECPay relay for admin-pages.html (Cloudflare Worker, or Vercel through api/[route].js).
// The HTML file can't receive ECPay's result or read ECPay's query API (the browser blocks it),
// so this relay does both on its behalf. It stores nothing.
//
//   GET  /status?tradeNo=SX...  → asks ECPay (QueryTradeInfo) and returns { status: 'paid' | 'unpaid', ... }
//   GET  /find?from=YYYY-MM-DD  → paid SX... trades since that day (ECPay reconciliation file), to recover
//                                 payments whose trade number the page didn't keep
//   POST /notify                → ECPay's background notification (ReturnURL); answers 1|OK

const TRADE_NO = /^SX[0-9A-Z]{6,18}$/;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // Works at the root (Cloudflare) or under /api (Vercel).
    const path = url.pathname.replace(/^[/]api(?=[/])/, '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (path === '/status' && req.method === 'GET') return status(url.searchParams.get('tradeNo') || '', env);
    if (path === '/find' && req.method === 'GET') return find(url.searchParams.get('from') || '', env);
    if (path === '/notify' && req.method === 'POST') {
      const fields = parseForm(await req.text(), true);
      const ok = await verify(fields, env);
      return new Response(ok ? '1|OK' : '0|CheckMacValue Error', { headers: { 'Content-Type': 'text/plain' } });
    }
    return json({ error: 'not found' }, 404);
  },
};

async function status(tradeNo, env) {
  if (!TRADE_NO.test(tradeNo)) return json({ error: 'invalid tradeNo' }, 400);
  const params = { MerchantID: env.MERCHANT_ID, MerchantTradeNo: tradeNo, TimeStamp: String(Math.floor(Date.now() / 1000)) };
  params.CheckMacValue = await checkMacValue(params, env);
  let text;
  try {
    const res = await fetch(env.ECPAY_QUERY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    text = await res.text();
    if (!res.ok) return json({ error: 'ecpay http ' + res.status }, 502);
  } catch (e) {
    return json({ error: 'ecpay unreachable' }, 502);
  }
  const r = parseForm(text, false);
  if (r.MerchantTradeNo !== tradeNo || !(await verify(r, env))) return json({ error: 'unverified ecpay response' }, 502);
  // TradeStatus: 1 = paid; 0 = not paid yet (e.g. ATM waiting for the transfer); 10200047 = payment page never submitted.
  const s = r.TradeStatus === '1' ? 'paid' : 'unpaid';
  return json({
    tradeNo, status: s, tradeStatus: r.TradeStatus,
    amount: Number(r.TradeAmt || 0), paymentDate: r.PaymentDate || '', paymentType: r.PaymentType || '', ecpayTradeNo: r.TradeNo || '',
  });
}

// Reconciliation file (下載特店對帳媒體檔): every trade of the merchant by order date, as CSV cells like ="value".
const MEDIA_URL = 'https://vendor-stage.ecpay.com.tw/PaymentMedia/TradeNoAio';
// ECPay allows one reconciliation download per minute, and every refused request restarts that minute,
// so ECPay is asked at most once every 65 seconds; in between, the last result is reused.
let findCache = null;
let lastMediaCall = 0;
async function find(from, env) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return json({ error: 'invalid from' }, 400);
  if (Date.now() - lastMediaCall < 65000) {
    return findCache && findCache.from <= from ? json({ trades: findCache.trades, cached: true }) : json({ error: 'rate limited, try again in a minute' }, 429);
  }
  lastMediaCall = Date.now();
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const earliest = new Date(Date.now() + 8 * 3600e3 - 60 * 86400e3).toISOString().slice(0, 10);
  const params = {
    MerchantID: env.MERCHANT_ID, DateType: '6', BeginDate: from < earliest ? earliest : from, EndDate: today,
    MediaFormated: '1', CharSet: '2',
  };
  params.CheckMacValue = await checkMacValue(params, env, 'md5');
  let text;
  try {
    const res = await fetch(env.ECPAY_MEDIA_URL || MEDIA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    text = await res.text();
    if (!res.ok) return json({ error: 'ecpay http ' + res.status }, 502);
  } catch (e) {
    return json({ error: 'ecpay unreachable' }, 502);
  }
  if (text.includes('一分鐘之內僅限下載一個媒體檔')) {
    return findCache ? json({ trades: findCache.trades, cached: true }) : json({ error: 'rate limited, try again in a minute' }, 429);
  }
  const trades = [];
  for (const line of text.split(/\r?\n/)) {
    const cells = [...line.matchAll(/=(?:"([^"]*)"|([-0-9.]+))/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
    // 0 訂單日期, 1 廠商訂單編號, 6 付款方式, 11 付款狀態, 12 交易金額, 21 商品名稱
    if (cells.length < 22 || !TRADE_NO.test(cells[1]) || !cells[11].includes('已付款')) continue;
    trades.push({
      tradeNo: cells[1], orderDate: cells[0], paidAt: cells[11].slice(0, 19).replace(/-/g, '/'),
      amount: Number(cells[12]), items: cells[21], paymentType: cells[6],
    });
  }
  findCache = { at: Date.now(), from: params.BeginDate, trades };
  return json({ trades });
}

function json(body, code = 200) {
  return new Response(JSON.stringify(body), { status: code, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
}

// QueryTradeInfo answers with raw (not URL-encoded) values; the notification is URL-encoded.
function parseForm(text, decode) {
  const out = {};
  for (const part of text.split('&')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i), v = part.slice(i + 1);
    out[k] = decode ? decodeURIComponent(v.replace(/\+/g, ' ')) : v;
  }
  return out;
}

// Same rules as smarter_billing/payment/ecpay.py _generate_check_mac_value (.NET-style URL encoding, SHA-256).
async function checkMacValue(params, env, algo = 'sha256') {
  const keys = Object.keys(params).filter((k) => k !== 'CheckMacValue').sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  const raw = 'HashKey=' + env.HASH_KEY + '&' + keys.map((k) => k + '=' + params[k]).join('&') + '&HashIV=' + env.HASH_IV;
  const encoded = encodeURIComponent(raw).replace(/%20/g, '+').replace(/'/g, '%27').replace(/~/g, '%7e').toLowerCase();
  if (algo === 'md5') return md5(encoded).toUpperCase();
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// MD5 (RFC 1321) of an ASCII string; the reconciliation API still signs with MD5, which Web Crypto doesn't offer.
function md5(str) {
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const bytes = [...str].map((c) => c.charCodeAt(0) & 0xff);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 0; i < 8; i++) bytes.push(i < 4 ? (bitLen >>> (8 * i)) & 0xff : 0);
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
  for (let off = 0; off < bytes.length; off += 64) {
    const M = Array.from({ length: 16 }, (_, i) => bytes[off + i * 4] | (bytes[off + i * 4 + 1] << 8) | (bytes[off + i * 4 + 2] << 16) | (bytes[off + i * 4 + 3] << 24));
    let [A, B, C, D] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      const tmp = D; D = C; C = B;
      const x = (A + F + K[i] + M[g]) | 0;
      const r = S[(i >> 4) * 4 + (i % 4)];
      B = (B + ((x << r) | (x >>> (32 - r)))) | 0;
      A = tmp;
    }
    a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
  }
  return [a0, b0, c0, d0].map((v) => [0, 1, 2, 3].map((i) => ((v >>> (8 * i)) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}
async function verify(fields, env) {
  return !!fields.CheckMacValue && fields.CheckMacValue === (await checkMacValue(fields, env));
}

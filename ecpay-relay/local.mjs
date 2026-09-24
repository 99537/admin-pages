// Runs the ECPay relay on this computer: http://localhost:8787
// Start: double-click start-relay.bat (or: node local.mjs). Keep the window open while using admin-pages.html.
// Only outgoing calls to ECPay are needed, so nothing has to be reachable from the internet.
import http from 'node:http';
import relay from './worker.js';

const PORT = 8787;
const env = {
  MERCHANT_ID: process.env.MERCHANT_ID || '3002607',
  HASH_KEY: process.env.HASH_KEY || 'pwFHCqoQZGmho4w6',
  HASH_IV: process.env.HASH_IV || 'EkRm7iFT261dpevs',
  ECPAY_QUERY_URL: process.env.ECPAY_QUERY_URL || 'https://payment-stage.ecpay.com.tw/Cashier/QueryTradeInfo/V5',
};

http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' ? undefined : Buffer.concat(chunks);
    const r = await relay.fetch(new Request('http://localhost:' + PORT + req.url, { method: req.method, body }), env);
    res.writeHead(r.status, { ...Object.fromEntries(r.headers), 'Access-Control-Allow-Private-Network': 'true' });
    res.end(Buffer.from(await r.arrayBuffer()));
    const q = new URL(req.url, 'http://x').searchParams.get('tradeNo');
    if (q) console.log(new Date().toLocaleTimeString(), 'checked', q, '->', r.status);
  } catch (e) {
    res.writeHead(500); res.end('relay error');
    console.error(e);
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log('ECPay payment check is running at http://localhost:' + PORT);
  console.log('Keep this window open while using admin-pages.html. Close it to stop.');
}).on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? 'Port ' + PORT + ' is already in use (the relay may already be running).' : e.message);
  process.exitCode = 1;
});

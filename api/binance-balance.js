// 文件：api/binance-balance.js
import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.BINANCE_KEY;
  const secretKey = process.env.BINANCE_SECRET;

  if (!apiKey || !secretKey) {
    return res.status(500).json({ error: 'Missing BINANCE_KEY or BINANCE_SECRET' });
  }

  try {
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;

    const signature = crypto
      .createHmac('sha256', secretKey)
      .update(queryString)
      .digest('hex');

    const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': apiKey
      }
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(500).json({
        error: 'binance request failed',
        status: resp.status,
        body: text
      });
    }

    const data = await resp.json();
    const usdtObj = (data.balances || []).find((item) => item.asset === 'USDT');
    const free = usdtObj ? Number(usdtObj.free || 0) : 0;
    const locked = usdtObj ? Number(usdtObj.locked || 0) : 0;
    const total = free + locked;

    return res.status(200).json({ usdt: total });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

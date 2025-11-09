// pages/api/binance-balance.js
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
    // 1. 先查现货 /api/v3/account
    const spot = await fetchSpotUsdt(apiKey, secretKey);

    // 2. 再查合约 U 本位 /fapi/v2/balance
    const futures = await fetchFuturesUsdt(apiKey, secretKey);

    // 3. 汇总给你看
    const total = spot + futures;

    return res.status(200).json({
      spotUsdt: spot,
      futuresUsdt: futures,
      totalUsdt: total
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

async function fetchSpotUsdt(apiKey, secretKey) {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');

  const url = `https://api.binance.com/api/v3/account?${queryString}&signature=${signature}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'X-MBX-APIKEY': apiKey
    }
  });

  if (!resp.ok) {
    // 现货失败就当 0，不要让整个接口挂掉
    return 0;
  }

  const data = await resp.json();
  const usdtObj = (data.balances || []).find((item) => item.asset === 'USDT');
  const free = usdtObj ? Number(usdtObj.free || 0) : 0;
  const locked = usdtObj ? Number(usdtObj.locked || 0) : 0;
  return free + locked;
}

async function fetchFuturesUsdt(apiKey, secretKey) {
  // U本位合约的余额接口：GET /fapi/v2/balance
  // 文档里是同样的签名方式：timestamp + signature
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');

  const url = `https://fapi.binance.com/fapi/v2/balance?${queryString}&signature=${signature}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'X-MBX-APIKEY': apiKey
    }
  });

  if (!resp.ok) {
    // 合约失败就当 0
    return 0;
  }

  const data = await resp.json();
  // 返回的是一个数组，每个资产一条，咱们找 USDT
  const usdtObj = (data || []).find((item) => item.asset === 'USDT');
  if (!usdtObj) return 0;

  // 合约这个接口里余额字段叫 balance
  return Number(usdtObj.balance || 0);
}

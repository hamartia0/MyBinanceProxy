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
    // 1. 获取所有币种价格（公开API，不需要签名）
    const prices = await fetchAllPrices();

    // 2. 先查现货账户，获取所有币种并换算为USDT
    const spot = await fetchSpotTotalUsdt(apiKey, secretKey, prices);

    // 3. 查合约账户余额（包含全仓和逐仓，逐仓通常包含网格机器人资金）
    const futures = await fetchFuturesBalance(apiKey, secretKey);

    // 4. 查交易机器人账户余额 (SAPI)
    const tradingBotSapi = await fetchTradingBotBalance(apiKey, secretKey, prices);

    // 5. 汇总
    const total = spot + futures.total + tradingBotSapi;

    return res.status(200).json({
      spotUsdt: spot,
      futuresCrossUsdt: futures.cross,
      futuresIsolatedUsdt: futures.isolated,
      futuresTotalUsdt: futures.total,
      tradingBotSapiUsdt: tradingBotSapi,
      totalUsdt: total
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || String(err) });
  }
}

/**
 * 获取所有交易对的价格（公开API，不需要签名）
 */
async function fetchAllPrices() {
  const url = 'https://api.binance.com/api/v3/ticker/price';
  const resp = await fetch(url);

  if (!resp.ok) {
    throw new Error('Failed to fetch prices: ' + resp.status);
  }

  const priceList = await resp.json();
  const priceMap = {};
  for (const item of priceList) {
    priceMap[item.symbol] = parseFloat(item.price);
  }
  return priceMap;
}

/**
 * 获取币种对USDT的价格
 * 支持直接交易对（如BTCUSDT）或间接换算（如通过BTC或BNB中转）
 */
function getPriceInUsdt(asset, prices) {
  // 如果是USDT，直接返回1
  if (asset === 'USDT') {
    return 1;
  }

  // 尝试直接交易对，如 BTCUSDT
  const directPair = asset + 'USDT';
  if (prices[directPair]) {
    return prices[directPair];
  }

  // 尝试通过BTC中转，如 ETHBTC * BTCUSDT
  const btcPair = asset + 'BTC';
  if (prices[btcPair] && prices['BTCUSDT']) {
    return prices[btcPair] * prices['BTCUSDT'];
  }

  // 尝试通过BNB中转，如 ETHBNB * BNBUSDT
  const bnbPair = asset + 'BNB';
  if (prices[bnbPair] && prices['BNBUSDT']) {
    return prices[bnbPair] * prices['BNBUSDT'];
  }

  // 如果找不到价格，返回0
  console.warn(`Warning: Cannot find price for ${asset}`);
  return 0;
}

/**
 * 获取现货账户所有币种换算为USDT的总价值
 */
async function fetchSpotTotalUsdt(apiKey, secretKey, prices) {
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
  let totalUsdt = 0;

  for (const balance of data.balances || []) {
    const free = parseFloat(balance.free || 0);
    const locked = parseFloat(balance.locked || 0);
    const total = free + locked;

    // 跳过余额为0的币种
    if (total <= 0) {
      continue;
    }

    const asset = balance.asset;
    const priceInUsdt = getPriceInUsdt(asset, prices);
    const assetValueInUsdt = total * priceInUsdt;
    totalUsdt += assetValueInUsdt;
  }

  return totalUsdt;
}

/**
 * 获取合约账户余额（全仓 + 逐仓）
 * 逐仓模式常用于合约网格机器人，这部分资金不包含在 totalMarginBalance 中
 */
async function fetchFuturesBalance(apiKey, secretKey) {
  const timestamp = Date.now();
  const queryString = `timestamp=${timestamp}`;
  const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');

  const url = `https://fapi.binance.com/fapi/v2/account?${queryString}&signature=${signature}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      'X-MBX-APIKEY': apiKey
    }
  });

  if (!resp.ok) {
    console.warn('Failed to fetch futures balance:', resp.status);
    return { cross: 0, isolated: 0, total: 0 };
  }

  const data = await resp.json();
  
  // 1. 全仓余额
  const cross = parseFloat(data.totalMarginBalance || 0);
  
  // 2. 逐仓余额
  let isolated = 0;
  for (const position of data.positions || []) {
    // 检查是否为逐仓
    if (position.isolated === true || String(position.isolated) === 'true') {
      const wallet = parseFloat(position.isolatedWallet || 0);
      const pnl = parseFloat(position.unrealizedProfit || 0);
      isolated += (wallet + pnl);
    }
  }
  
  return {
    cross: cross,
    isolated: isolated,
    total: cross + isolated
  };
}

/**
 * 获取交易机器人账户余额
 * 交易机器人账户是一个逻辑账户，实际上是聚合了现货或合约账户中被策略订单锁定的资金
 * 需要通过算法交易（Algo）接口查询所有活跃策略，计算投入资金和未实现盈亏
 * 
 * API 接口：
 * - 现货机器人：GET /sapi/v1/algo/spot/openOrders
 * - 合约机器人：GET /sapi/v1/algo/futures/openOrders
 * 
 * 计算逻辑：遍历所有活跃策略，将投入资金（Investment）和未实现盈亏（Unrealized PnL）相加
 */
async function fetchTradingBotBalance(apiKey, secretKey, prices) {
  try {
    // 1. 获取现货算法策略的余额
    const spotBotBalance = await fetchSpotAlgoBalance(apiKey, secretKey);
    
    // 2. 获取合约算法策略的余额
    const futuresBotBalance = await fetchFuturesAlgoBalance(apiKey, secretKey);
    
    // 3. 汇总
    return spotBotBalance + futuresBotBalance;
  } catch (err) {
    // 如果获取交易机器人账户失败，返回0，不让整个接口挂掉
    console.warn('Error fetching trading bot balance:', err.message);
    return 0;
  }
}

/**
 * 获取现货算法策略（交易机器人）余额
 * GET /sapi/v1/algo/spot/openOrders
 */
async function fetchSpotAlgoBalance(apiKey, secretKey) {
  try {
    const timestamp = Date.now();
    // 添加 recvWindow=60000 防止时间误差导致的 401/1021 错误
    const queryString = `timestamp=${timestamp}&recvWindow=60000`;
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');

    const url = `https://api.binance.com/sapi/v1/algo/spot/openOrders?${queryString}&signature=${signature}`;
    
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!resp.ok) {
      if (resp.status === 401) {
        const errText = await resp.text();
        console.warn(`Spot algo API 401: 权限验证失败。请确保API Key已开启"Enable Spot & Margin Trading" (即使是读取) - ${errText}`);
      } else {
        const errText = await resp.text();
        console.warn(`Spot algo API error ${resp.status}: ${errText}`);
      }
      return 0;
    }

    const data = await resp.json();
    const orders = Array.isArray(data) ? data : (data.orders || []);
    
    if (!orders || orders.length === 0) {
      return 0;
    }

    let totalBalance = 0;
    for (const order of orders) {
      const invested = parseFloat(order.investedQty || order.totalInvested || order.amount || 0);
      const unrealizedPnl = parseFloat(order.unrealizedPnl || order.pnl || 0);
      const orderValue = invested + unrealizedPnl;
      if (orderValue > 0) {
        totalBalance += orderValue;
      }
    }
    return totalBalance;
  } catch (err) {
    console.warn('Error fetching spot algo balance:', err.message);
    return 0;
  }
}

/**
 * 获取合约算法策略（交易机器人）余额
 * GET /sapi/v1/algo/futures/openOrders
 */
async function fetchFuturesAlgoBalance(apiKey, secretKey) {
  try {
    const timestamp = Date.now();
    // 添加 recvWindow=60000
    const queryString = `timestamp=${timestamp}&recvWindow=60000`;
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');

    const url = `https://api.binance.com/sapi/v1/algo/futures/openOrders?${queryString}&signature=${signature}`;
    
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!resp.ok) {
      if (resp.status === 401) {
        const errText = await resp.text();
        console.warn(`Futures algo API 401: 权限验证失败。请确保API Key已开启"Enable Futures" (即使是读取) - ${errText}`);
      } else {
        const errText = await resp.text();
        console.warn(`Futures algo API error ${resp.status}: ${errText}`);
      }
      return 0;
    }

    const data = await resp.json();
    const orders = Array.isArray(data) ? data : (data.orders || []);
    
    if (!orders || orders.length === 0) {
      return 0;
    }

    let totalBalance = 0;
    for (const order of orders) {
      const invested = parseFloat(order.investedQty || order.totalInvested || order.amount || 0);
      const unrealizedPnl = parseFloat(order.unrealizedPnl || order.pnl || 0);
      const orderValue = invested + unrealizedPnl;
      if (orderValue > 0) {
        totalBalance += orderValue;
      }
    }
    return totalBalance;
  } catch (err) {
    console.warn('Error fetching futures algo balance:', err.message);
    return 0;
  }
}

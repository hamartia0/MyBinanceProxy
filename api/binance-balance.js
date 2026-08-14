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
    // 使用统一钱包接口获取所有账户余额（包括交易机器人）
    // 接口：GET /sapi/v1/asset/wallet/balance
    // 优势：一次性获取所有账户余额，已经折算成 USDT，包含交易机器人账户
    // 这是币安官方推荐的方式，可以获取到完整的账户总览
    const walletBalances = await fetchWalletBalances(apiKey, secretKey);
    
    // 解析统一钱包接口返回的数据
    let spotUsdt = 0;
    let fundingUsdt = 0;
    let futuresTotalUsdt = 0;
    let coinMFuturesUsdt = 0;
    let marginUsdt = 0;
    let earnUsdt = 0;
    let tradingBotUsdt = 0;
    let optionsUsdt = 0;
    let copyTradingUsdt = 0;
    let totalUsdt = 0;
    
    // 遍历所有钱包类型，提取各个账户余额
    for (const wallet of walletBalances || []) {
      const balance = parseFloat(wallet.balance || 0);
      const walletName = wallet.walletName || '';
      
      // 根据钱包名称匹配对应的账户
      if (walletName === 'Spot') {
        spotUsdt = balance;
      } else if (walletName === 'Funding') {
        fundingUsdt = balance;
      } else if (walletName === 'USDⓈ-M Futures' || walletName === 'USDT-M Futures') {
        futuresTotalUsdt = balance;
      } else if (walletName === 'COIN-M Futures') {
        coinMFuturesUsdt = balance;
      } else if (walletName === 'Cross Margin' || walletName === 'Isolated Margin') {
        marginUsdt += balance;
      } else if (walletName === 'Earn') {
        earnUsdt = balance;
      } else if (walletName === 'Trading Bots') {
        tradingBotUsdt = balance; // 交易机器人账户余额（网格、DCA 等策略资金）
      } else if (walletName === 'Options') {
        optionsUsdt = balance;
      } else if (walletName === 'Copy Trading') {
        copyTradingUsdt = balance;
      }
      
      // 累加所有激活的钱包余额得到总资产
      // 注意：统一钱包接口返回的总资产已经包含了所有账户，不需要手动累加单个账户
      if (wallet.activate && balance > 0) {
        totalUsdt += balance;
      }
    }
    
    // 统一钱包失败时不能回退到不完整口径，否则会把缺少的钱包静默记成 0。
    if (!walletBalances || walletBalances.length === 0) {
      throw new Error('Binance wallet balance returned no wallets');
    }

    const mainTotalUsdt = totalUsdt;
    const subAccounts = await fetchSubAccountsTotalUsdt(apiKey, secretKey);
    totalUsdt += subAccounts.totalUsdt;

    return res.status(200).json({
      spotUsdt: spotUsdt,
      fundingUsdt: fundingUsdt,
      futuresCrossUsdt: futuresTotalUsdt, // 统一钱包接口返回的是总合约余额
      futuresIsolatedUsdt: 0, // 统一钱包接口不区分逐仓
      futuresTotalUsdt: futuresTotalUsdt,
      coinMFuturesUsdt: coinMFuturesUsdt,
      marginUsdt: marginUsdt,
      earnUsdt: earnUsdt,
      tradingBotUsdt: tradingBotUsdt, // 这是真正的交易机器人账户余额！
      tradingBotSapiUsdt: 0, // 保留字段，但统一钱包接口已经包含了
      optionsUsdt: optionsUsdt,
      copyTradingUsdt: copyTradingUsdt,
      mainTotalUsdt: mainTotalUsdt,
      subAccountCount: subAccounts.count,
      subAccountsSpotUsdt: subAccounts.spotUsdt,
      subAccountsUsdMFuturesUsdt: subAccounts.usdMFuturesUsdt,
      subAccountsCoinMFuturesUsdt: subAccounts.coinMFuturesUsdt,
      subAccountsMarginUsdt: subAccounts.marginUsdt,
      subAccountsTotalUsdt: subAccounts.totalUsdt,
      totalUsdt: totalUsdt
    });
  } catch (err) {
    console.error('API Handler Error:', err.message);
    // 确保始终返回有效的 JSON，即使是错误
    return res.status(500).json({ 
      error: err.message || 'Internal server error',
      totalUsdt: 0,
      spotUsdt: 0,
      futuresTotalUsdt: 0,
      tradingBotUsdt: 0
    });
  }
}

/**
 * 获取统一钱包余额（包含所有账户：现货、合约、交易机器人等）
 * GET /sapi/v1/asset/wallet/balance
 * 这个接口已经把所有账户的余额都折算成指定的计价资产（默认BTC，可以指定USDT）
 */
async function fetchWalletBalances(apiKey, secretKey) {
  try {
    const timestamp = Date.now();
    const queryString = `quoteAsset=USDT&timestamp=${timestamp}&recvWindow=60000`;
    const signature = crypto.createHmac('sha256', secretKey).update(queryString).digest('hex');

    const url = `https://api.binance.com/sapi/v1/asset/wallet/balance?${queryString}&signature=${signature}`;

    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': apiKey
      }
    });

    if (!resp.ok) {
      console.warn('Wallet balance API failed:', resp.status);
      return [];
    }

    const data = await resp.json();
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.warn('Error fetching wallet balances:', err.message);
    return [];
  }
}

/**
 * 主账户的 wallet/balance 不包含子账户。这里使用主账户只读接口，汇总所有启用子账户：
 * - 现货：spotSummary 返回 BTC 估值
 * - U 本位合约：totalMarginBalance（含未实现盈亏）
 * - 币本位合约：逐资产 marginBalance 换算成 USDT
 * - 杠杆：totalNetAssetOfBtc（净资产，已扣负债）
 * 任一必需接口失败时直接报错，避免把不完整余额写进每日统计。
 */
async function fetchSubAccountsTotalUsdt(apiKey, secretKey) {
  const list = await signedGet('/sapi/v1/sub-account/list', {}, apiKey, secretKey);
  const subAccounts = (list.subAccounts || []).filter(account => account.isFreeze !== true);

  if (subAccounts.length === 0) {
    return emptySubAccountSummary();
  }

  const [statuses, prices] = await Promise.all([
    signedGet('/sapi/v1/sub-account/status', {}, apiKey, secretKey),
    fetchAllPrices()
  ]);

  if (!prices.BTCUSDT) {
    throw new Error('BTCUSDT price unavailable for sub-account valuation');
  }

  const statusByEmail = new Map(
    (Array.isArray(statuses) ? statuses : []).map(status => [status.email, status])
  );

  const summaries = await Promise.all(subAccounts.map(account => {
    const status = statusByEmail.get(account.email);
    if (!status) {
      throw new Error('Sub-account status unavailable');
    }
    return fetchOneSubAccountUsdt(
      account.email,
      status,
      prices,
      apiKey,
      secretKey
    );
  }));

  return summaries.reduce((total, item) => ({
    count: total.count + 1,
    spotUsdt: total.spotUsdt + item.spotUsdt,
    usdMFuturesUsdt: total.usdMFuturesUsdt + item.usdMFuturesUsdt,
    coinMFuturesUsdt: total.coinMFuturesUsdt + item.coinMFuturesUsdt,
    marginUsdt: total.marginUsdt + item.marginUsdt,
    totalUsdt: total.totalUsdt + item.totalUsdt
  }), emptySubAccountSummary());
}

function emptySubAccountSummary() {
  return {
    count: 0,
    spotUsdt: 0,
    usdMFuturesUsdt: 0,
    coinMFuturesUsdt: 0,
    marginUsdt: 0,
    totalUsdt: 0
  };
}

async function fetchOneSubAccountUsdt(email, status, prices, apiKey, secretKey) {
  const requests = [
    fetchSubAccountSpotUsdt(email, prices, apiKey, secretKey),
    status.isFutureEnabled === true
      ? fetchSubAccountUsdMFuturesUsdt(email, apiKey, secretKey)
      : Promise.resolve(0),
    status.isFutureEnabled === true
      ? fetchSubAccountCoinMFuturesUsdt(email, prices, apiKey, secretKey)
      : Promise.resolve(0),
    status.isMarginEnabled === true
      ? fetchSubAccountMarginUsdt(email, prices, apiKey, secretKey)
      : Promise.resolve(0)
  ];

  const [spotUsdt, usdMFuturesUsdt, coinMFuturesUsdt, marginUsdt] = await Promise.all(requests);

  return {
    spotUsdt,
    usdMFuturesUsdt,
    coinMFuturesUsdt,
    marginUsdt,
    totalUsdt: spotUsdt + usdMFuturesUsdt + coinMFuturesUsdt + marginUsdt
  };
}

async function fetchSubAccountSpotUsdt(email, prices, apiKey, secretKey) {
  const data = await signedGet(
    '/sapi/v1/sub-account/spotSummary',
    { email },
    apiKey,
    secretKey
  );
  const rows = data.spotSubUserAssetBtcVoList || [];
  const account = rows.find(row => row.email === email) || rows[0];
  if (!account) {
    throw new Error('Sub-account spot summary unavailable');
  }
  return parseFloat(account?.totalAsset || 0) * prices.BTCUSDT;
}

async function fetchSubAccountUsdMFuturesUsdt(email, apiKey, secretKey) {
  const data = await signedGet(
    '/sapi/v2/sub-account/futures/account',
    { email, futuresType: 1 },
    apiKey,
    secretKey
  );
  if (!data.futureAccountResp) {
    throw new Error('Sub-account USD-M futures summary unavailable');
  }
  return parseFloat(data.futureAccountResp?.totalMarginBalance || 0);
}

async function fetchSubAccountCoinMFuturesUsdt(email, prices, apiKey, secretKey) {
  const data = await signedGet(
    '/sapi/v2/sub-account/futures/account',
    { email, futuresType: 2 },
    apiKey,
    secretKey
  );
  if (!data.deliveryAccountResp) {
    throw new Error('Sub-account COIN-M futures summary unavailable');
  }
  const assets = data.deliveryAccountResp?.assets || [];

  return assets.reduce((total, asset) => {
    const marginBalance = parseFloat(asset.marginBalance || 0);
    if (marginBalance === 0) {
      return total;
    }
    const price = requirePriceInUsdt(asset.asset, prices);
    return total + marginBalance * price;
  }, 0);
}

async function fetchSubAccountMarginUsdt(email, prices, apiKey, secretKey) {
  const data = await signedGet(
    '/sapi/v1/sub-account/margin/account',
    { email },
    apiKey,
    secretKey
  );
  if (data.totalNetAssetOfBtc === undefined) {
    throw new Error('Sub-account margin summary unavailable');
  }
  return parseFloat(data.totalNetAssetOfBtc || 0) * prices.BTCUSDT;
}

function requirePriceInUsdt(asset, prices) {
  if (asset === 'USD' || asset === 'USDT') {
    return 1;
  }
  const price = getPriceInUsdt(asset, prices);
  if (!price) {
    throw new Error(`USDT price unavailable for ${asset}`);
  }
  return price;
}

async function signedGet(path, params, apiKey, secretKey) {
  const query = new URLSearchParams({
    ...params,
    timestamp: String(Date.now()),
    recvWindow: '60000'
  });
  const signature = crypto
    .createHmac('sha256', secretKey)
    .update(query.toString())
    .digest('hex');

  const resp = await fetch(
    `https://api.binance.com${path}?${query.toString()}&signature=${signature}`,
    {
      method: 'GET',
      headers: { 'X-MBX-APIKEY': apiKey }
    }
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Binance ${path} failed: ${resp.status} ${body.slice(0, 200)}`);
  }

  return resp.json();
}

/**
 * 获取所有交易对的价格（公开API，不需要签名）
 */
async function fetchAllPrices() {
  try {
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
  } catch (err) {
    // 价格获取失败不应该让整个接口崩溃，返回空对象
    console.error('Error fetching prices:', err.message);
    return {};
  }
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

  // 如果找不到价格，返回0（不记录警告，避免日志噪音）
  return 0;
}

/**
 * 获取现货账户所有币种换算为USDT的总价值
 */
async function fetchSpotTotalUsdt(apiKey, secretKey, prices) {
  try {
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
      console.warn('Spot account API failed:', resp.status);
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
  } catch (err) {
    console.error('Error fetching spot balance:', err.message);
    return 0;
  }
}

/**
 * 获取合约账户余额（全仓 + 逐仓）
 * 逐仓模式常用于合约网格机器人，这部分资金不包含在 totalMarginBalance 中
 */
async function fetchFuturesBalance(apiKey, secretKey) {
  try {
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
  } catch (err) {
    console.warn('Error fetching futures balance:', err.message);
    return { cross: 0, isolated: 0, total: 0 };
  }
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
      // 权限错误（401）是预期的（用户可能未开启现货算法权限），不记录警告
      // 其他错误也静默处理，避免日志噪音
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
      // 权限错误（401）是预期的（用户可能未开启合约算法权限），不记录警告
      // 其他错误也静默处理，避免日志噪音
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

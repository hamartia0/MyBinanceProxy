# MyBinanceProxy

币安账户余额查询 API 代理服务

## 功能

- ✅ 查询现货账户余额（所有币种换算为 USDT）
- ✅ 查询合约账户余额（全仓 + 逐仓）
- ✅ 支持算法交易订单查询（需要相应权限）
- ✅ 自动汇总所有账户总资产

## 项目结构

```
MyBinanceProxy/
├── api/
│   └── binance-balance.js  # 核心 API 处理逻辑
├── test-api.js              # 本地测试脚本
├── package.json
├── .env                     # 环境变量（不提交到 Git）
└── README.md
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

创建 `.env` 文件：

```env
BINANCE_KEY=your_api_key_here
BINANCE_SECRET=your_secret_key_here
```

### 3. 运行测试

```bash
npm test
# 或
node test-api.js
```

## API 响应格式

```json
{
  "spotUsdt": 2322.20,
  "futuresCrossUsdt": 6260.11,
  "futuresIsolatedUsdt": 0.00,
  "futuresTotalUsdt": 6260.11,
  "tradingBotSapiUsdt": 0.00,
  "totalUsdt": 8582.30
}
```

## API 权限要求

- **基础功能**：`允许读取` (Enable Reading)
- **合约账户**：`允许合约` (Enable Futures) - 推荐开启
- **算法订单**：`允许现货及杠杆交易` 或 `允许合约` - 可选

## 部署到 Vercel

详见 `VERCEL_DEPLOY.md`

## 注意事项

- `.env` 文件已添加到 `.gitignore`，不会提交到 Git
- API Key 和 Secret 请妥善保管，不要泄露
- 建议在生产环境使用 Vercel 的环境变量配置

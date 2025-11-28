# Vercel 部署说明

## 环境变量配置

在 Vercel 项目设置中配置以下环境变量：

1. 进入你的 Vercel 项目
2. 进入 **Settings** → **Environment Variables**
3. 添加以下环境变量：
   - `BINANCE_KEY`: 你的币安 API Key
   - `BINANCE_SECRET`: 你的币安 Secret Key

## 部署方式

### 方式一：作为 Next.js 项目部署（推荐）

如果你的项目是 Next.js 项目，需要将 API 文件放在正确的目录：

1. 创建 `pages/api/` 目录
2. 将 `api/binance-balance.js` 移动到 `pages/api/binance-balance.js`
3. 部署到 Vercel

### 方式二：作为 Serverless Function 部署

如果你的项目使用 Vercel 的 Serverless Functions：

1. 确保文件在 `api/` 目录（当前结构）
2. 创建 `vercel.json` 配置文件
3. 部署到 Vercel

## 测试部署后的 API

部署成功后，你可以通过以下方式访问：

```
GET https://your-project.vercel.app/api/binance-balance
```

## 注意事项

- ✅ 代码已经支持环境变量，无需修改
- ✅ Vercel 会自动读取环境变量，与本地 `.env` 行为一致
- ✅ 环境变量在 Vercel 中是加密存储的，更安全
- ⚠️ 确保 API Key 有正确的权限（只读权限即可）
- ⚠️ 建议在生产环境禁用或限制 API Key 的 IP 白名单功能，因为 Vercel 的 IP 是动态的


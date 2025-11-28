// 测试脚本 - 用于本地测试 API
import dotenv from 'dotenv';
import handler from './api/binance-balance.js';

// 加载 .env 文件
dotenv.config();

// 模拟 Next.js 的请求和响应对象
const mockReq = {
  method: 'GET',
  query: {},
  body: null,
  headers: {}
};

const mockRes = {
  statusCode: 200,
  status: function(code) {
    this.statusCode = code;
    return this;
  },
  json: function(data) {
    console.log('\n=== API 响应结果 ===');
    console.log('状态码:', this.statusCode);
    console.log('响应数据:');
    console.log(JSON.stringify(data, null, 2));
    
    // 如果成功，显示格式化结果
    if (this.statusCode === 200 && data.totalUsdt !== undefined) {
      console.log('\n=== 账户余额汇总 ===');
      console.log(`现货账户 (USDT): ${data.spotUsdt.toFixed(2)}`);
      console.log(`合约全仓 (USDT): ${data.futuresCrossUsdt.toFixed(2)}`);
      console.log(`合约逐仓/机器人 (USDT): ${data.futuresIsolatedUsdt.toFixed(2)}`);
      console.log(`总资产 (USDT): ${data.totalUsdt.toFixed(2)}`);
    }
    
    return this;
  }
};

// 运行测试
console.log('开始测试币安余额查询 API...');
console.log('环境变量检查:');
console.log('- BINANCE_KEY:', process.env.BINANCE_KEY ? '已设置 ✓' : '未设置 ✗');
console.log('- BINANCE_SECRET:', process.env.BINANCE_SECRET ? '已设置 ✓' : '未设置 ✗');
console.log('');

handler(mockReq, mockRes).catch(err => {
  console.error('\n=== 错误信息 ===');
  console.error(err);
  process.exit(1);
});


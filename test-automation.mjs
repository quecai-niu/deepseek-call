/**
 * 自动化测试脚本 — 使用 Playwright 驱动 Chrome 运行 test.html 的全部测试场景
 *
 * 用法: node test-automation.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = join(fileURLToPath(import.meta.url), '..');
const PORT = 8765;
const BASE_URL = `http://localhost:${PORT}`;

/* ===================================================================
 * MIME 类型映射
 * =================================================================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.wav':  'audio/wav',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/* ===================================================================
 * 简易 HTTP 服务器（为 test.html 提供文件服务）
 * =================================================================== */
function startServer(rootDir, port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let filePath = join(rootDir, req.url === '/' ? 'test.html' : req.url);
      // 安全检查：防止路径穿越
      if (!filePath.startsWith(rootDir)) {
        res.writeHead(403); res.end('Forbidden');
        return;
      }
      if (!existsSync(filePath)) {
        res.writeHead(404); res.end('Not Found');
        return;
      }
      const ext = extname(filePath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      const content = readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
      res.end(content);
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`[SERVER] 测试服务器已启动: http://localhost:${port}`);
      resolve(server);
    });
  });
}

/* ===================================================================
 * 测试场景定义（与 test.html 中的 TEST_SCENARIOS 保持一致）
 * =================================================================== */
const SCENARIOS = [
  { idx: 0, name: '天气询问',       file: 'test_weather.wav' },
  { idx: 1, name: '写诗请求',       file: 'test_poem.wav' },
  { idx: 2, name: '长句含停顿',     file: 'test_long.wav' },
  { idx: 3, name: '多句连续',       file: 'test_multiple.wav' },
  { idx: 4, name: '数字计算',       file: 'test_math.wav' },
  { idx: 5, name: '写代码请求',     file: 'test_code.wav' },
  { idx: 6, name: '翻译请求',       file: 'test_translate.wav' },
  { idx: 7, name: '拼接500ms短间隔', file: 'test_concat_short.wav' },
  { idx: 8, name: '拼接2000ms长间隔',file: 'test_concat_long.wav' },
  { idx: 9, name: '拼接两短句500ms', file: 'test_concat_two.wav' },
];

/* ===================================================================
 * 等待函数
 * =================================================================== */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ===================================================================
 * 测试运行器
 * =================================================================== */
async function runTests() {
  const projectDir = join(__dirname);
  const server = await startServer(projectDir, PORT);

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║     DeepSeek Call — 自动录音识别测试                    ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');

  const browser = await chromium.launch({
    headless: false,      // 可见模式，方便观察
    args: [
      '--use-fake-device-for-media-stream',  // 无真实麦克风也能工作
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  });

  const results = [];
  let testPassCount = 0;
  let testFailCount = 0;
  let testErrorCount = 0;

  try {
    const context = await browser.newContext({
      // 授予麦克风权限
      permissions: ['microphone'],
      // 禁用权限提示
    });

    const page = await context.newPage();

    // 捕获控制台日志
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

    // 导航到测试页面
    console.log('[BROWSER] 正在打开 test.html ...');
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });

    // 等待页面完全加载（环境检测完成）
    await page.waitForSelector('#infoSR:not(:has-text("检测中"))', { timeout: 10000 });
    console.log('[BROWSER] 页面加载完成');
    console.log('');

    // 检查浏览器是否支持自动测试
    const srStatus = await page.textContent('#infoSR');
    console.log(`  SpeechRecognition: ${srStatus}`);

    // 获取识别 API 状态
    const hasSR = !srStatus.includes('不可用');

    if (!hasSR) {
      console.log('');
      console.log('[SKIP] 浏览器不支持 SpeechRecognition，跳过测试');
      console.log('       Chrome 133+ 是运行此测试的必要条件');
    } else {
      // 尝试运行自动识别测试
      await testAllScenarios(page, results);
    }

    // 输出统计
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║     测试结果汇总                                        ║');
    console.log('╚══════════════════════════════════════════════════════════╝');

    for (const r of results) {
      const icon = r.status === 'PASS' ? '✓' : (r.status === 'FAIL' ? '✗' : '⚠');
      console.log(`  ${icon} [${r.status}] ${r.name}`);
      if (r.detail) console.log(`      ${r.detail}`);
    }
    console.log('');
    console.log(`  总计: ${results.length}  |  通过: ${results.filter(r => r.status === 'PASS').length}  |  ` +
      `失败: ${results.filter(r => r.status === 'FAIL').length}  |  错误: ${results.filter(r => r.status === 'ERROR').length}`);
    console.log('');

  } catch (err) {
    console.error('[FATAL] 测试执行异常:', err.message);
    console.error(err.stack);
  } finally {
    await browser.close();
    server.close();
    console.log('[DONE] 浏览器已关闭，服务器已停止');
  }

  // 返回结果供调用方判断
  const totalFail = results.filter(r => r.status !== 'PASS').length;
  process.exit(totalFail > 0 ? 1 : 0);
}

/* ===================================================================
 * 执行所有测试场景
 * =================================================================== */
async function testAllScenarios(page, results) {
  for (const scenario of SCENARIOS) {
    console.log(`[TEST] 场景 ${scenario.idx + 1}/${SCENARIOS.length}: ${scenario.name}`);

    try {
      const result = await runSingleScenario(page, scenario);
      results.push(result);
      const icon = result.status === 'PASS' ? '✓' : (result.status === 'FAIL' ? '✗' : '⚠');
      console.log(`  ${icon} ${result.status}: ${result.detail || '无详细'}`);
    } catch (err) {
      console.log(`  ⚠ ERROR: ${err.message}`);
      results.push({ status: 'ERROR', name: scenario.name, detail: err.message });
    }
    console.log('');
  }
}

/* ===================================================================
 * 执行单个测试场景
 * =================================================================== */
async function runSingleScenario(page, scenario) {
  // 1. 选择测试场景
  await page.selectOption('#autoScenario', String(scenario.idx));
  await sleep(200);

  // 2. 点击"运行测试"
  await page.click('#btnAutoTest');
  await sleep(500);

  // 3. 等待测试结果出现（最多 30 秒）
  try {
    await page.waitForSelector('.auto-test-result.pass, .auto-test-result.fail, .auto-test-result.error', {
      timeout: 30000,
    });
  } catch (timeoutErr) {
    // 超时处理：检查页面状态
    const progressHtml = await page.innerHTML('#autoProgress');
    return {
      status: 'ERROR',
      name: scenario.name,
      detail: `测试超时（30秒），进度条状态: ${progressHtml.replace(/<[^>]+>/g, ' ').trim()}`
    };
  }

  await sleep(300); // 等待最终渲染

  // 4. 读取结果
  const resultEl = await page.$('.auto-test-result');
  if (!resultEl) {
    return { status: 'ERROR', name: scenario.name, detail: '结果元素未找到' };
  }

  const resultClass = await resultEl.getAttribute('class');
  const resultText = await resultEl.textContent();

  const status = resultClass.includes('pass') ? 'PASS' :
                 resultClass.includes('fail') ? 'FAIL' : 'ERROR';

  return {
    status,
    name: scenario.name,
    detail: resultText.replace(/\s+/g, ' ').trim().substring(0, 200),
  };
}

// 启动
runTests();

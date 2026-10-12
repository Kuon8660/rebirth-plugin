import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import Renderer from '../../../../lib/renderer/Renderer.js';
import { log, loadConfig, todayStamp } from './infra.js';

/**
 * 产出层（image）：一切「把数据变成一张图」的能力
 * ------------------------------------------------------------
 *   · reRender()        转生卡：HTML 模板 → PNG（框架 Renderer + puppeteer）
 *   · requestAiImage()  AI 立绘：即梦（Jimeng）文生图 → 图片 Buffer
 *
 * 本文件由原 core/render.js 与 app/aiDraw.js 的「提示词 + 即梦调用」部分合并而来。
 * 只负责「怎么产出一张图」，不含任何流程编排（编排见 core/flow.js）。
 */

// ============================================================
// 一、转生卡渲染：HTML → PNG
// ============================================================
// 实例化渲染器
const rbrenderer = new Renderer({
  id: 'rebirth-plugin',    // 渲染器唯一标识
  type: 'image'            // 渲染器类型
});

// 使用 puppeteer 渲染 HTML 为图片
const renderHtmlToImage = async (htmlPath, outputPath) => {
  const browser = await puppeteer.launch();
  log('debug', `浏览器已启动，开始渲染HTML文件：${htmlPath}`);

  const page = await browser.newPage();
  log('debug', `新页面已创建，正在加载HTML文件：${htmlPath}`);

  // 设置页面视口大小，宽度为480px
  await page.setViewport({ width: 480, height: 758 });

  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
  log('debug', `HTML文件加载完成，开始截图：${outputPath}`);

  // 确保目标目录存在
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log('debug', `目录已创建：${dir}`);
  }

  await page.screenshot({ path: outputPath, fullPage: true });
  log('debug', `截图完成，保存路径：${outputPath}`);

  await browser.close();
  log('debug', '浏览器已关闭');
};

/**
 * 渲染转生卡：把模板变量填进 HTML 模板并截图。
 * @param {object} data    模板变量（见 core/flow.js 的 buildRenderData）
 * @param {string} [tplFile] 模板路径（相对 cwd）；默认 AI 版 index.html
 * @returns {Promise<string>} 生成的图片相对路径
 */
export const reRender = async (data, tplFile = './plugins/rebirth-plugin/resources/rebirth/index.html') => {
  try {
    // 调用模板处理方法
    const htmlPath = path.resolve(rbrenderer.dealTpl('rebirth-plugin', {
      tplFile,
      ...data // 传入的模板变量
    }));

    // 生成图片路径
    const now = new Date();
    const dateString = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}-${data.user_id}`;
    const outputPath = `./plugins/rebirth-plugin/tmp/rebirth/${dateString}.png`;

    // 渲染 HTML 为图片
    await renderHtmlToImage(htmlPath, outputPath);
    log('info', `图片保存在 ${outputPath}`);

    // 返回生成的图片路径
    return outputPath;
  } catch (err) {
    log('error', `图片渲染失败： ${err}`);
    throw err;
  }
};

// ============================================================
// 二、AI 立绘：即梦（Jimeng）文生图
// ============================================================
// 配置：ai.json（缺失自动从 ai.default.json 生成，sessionid 为空），
// 已被 .gitignore 忽略、不随仓库分发，避免真实 sessionid 泄露。
// 读取失败/文件异常时兜底为未启用（enable:false），不影响插件其它命令。
let aiConfig = { enable: false };
try {
  aiConfig = loadConfig('ai.json', { enable: false });
} catch (err) {
  log('error', `加载 AI 配置文件失败: ${err.message}`);
}
export { aiConfig };

// ---------- AI 图片保存目录（cwd 相对，供 segment.image 与 CSS 使用） ----------
// 产物落在 tmp/ 下（已被 .gitignore 忽略），与转生卡渲染产物同源、便于统一清理
const aiSaveDirRel = './plugins/rebirth-plugin/tmp/rebirth/ai';

// AI 图片保存相对路径（cwd 相对，与 reRender 输出风格一致）
export function aiImageRelPath(userId) {
  const name = `${userId}_${todayStamp()}.png`;
  const dir = path.resolve(process.cwd(), aiSaveDirRel);
  const abs = path.join(dir, name);
  return path.relative(process.cwd(), abs).split(path.sep).join('/');
}

// ---------- 中文标签 → 英文生成词 ----------
export function translateLabel(category, value) {
  const map = aiConfig._labelEnMap?.[category] || {};
  return map[value] || value;
}

// ---------- 组装英文提示词 ----------
export function buildPrompt(info) {
  const p = aiConfig.prompt || {};
  const parts = [];
  if (p.stylePrefix) parts.push(p.stylePrefix.trim());

  const bodyType = translateLabel('bodyType', info.bodyType);
  const race = translateLabel('race', info.race);
  const job = translateLabel('job', info.job);
  const hairColor = translateLabel('hairColor', info.hairColor);
  const eyeColor = translateLabel('eyeColor', info.eyeColor);
  const genderTag = info.gender === '男' ? '1boy, male' : '1girl, female';

  parts.push(genderTag);
  parts.push(`${bodyType} ${race} ${job}, ${hairColor}, ${eyeColor}`);

  if (aiConfig.prompt?.includeSkill && info.specialSkill) {
    parts.push(`${info.specialSkill} skill effect`);
  }

  // 随机动作：从 prompt.actions 池取 1 条作为本次动作/姿势描述；
  // 未配置 actions(空/缺省)时回退到默认动态动作，保证向后兼容。
  const actions = Array.isArray(p.actions) ? p.actions.filter((a) => typeof a === 'string' && a.trim()) : [];
  if (actions.length > 0) {
    parts.push(actions[Math.floor(Math.random() * actions.length)]);
  } else {
    parts.push('dynamic action pose, energetic motion');
  }

  let prompt = parts.filter(Boolean).join(', ');
  prompt = prompt.replace(/,(\s*,)+/g, ',').replace(/,\s*$/, '');
  if (p.suffix) prompt += p.suffix;
  return prompt;
}

// ---------- 即梦文生图调用 ----------
// 参考 siliconflow-plugin/apps/Jimeng.js 实现：
//   POST {base_url}/v1/images/generations
//   headers: Authorization: Bearer {sessionid}
//   body   : { model, prompt, ratio, resolution, negative_prompt }
//   响应   : data[]，每项含 url
//
// 多 Sessionid 支持：ai.json 的 jimeng.sessionid 可以是单个字符串
//   "sessionid": "abc123"
//   也可以是一个数组（多个即梦账号轮流使用 / 负载均衡 / 失效自动切换）
//   "sessionid": ["abc123", "def456", "ghi789"]
// 每次请求按 round-robin 顺序取一个；若某个 key 请求失败(非 2xx)，自动尝试下一个，全部失败才报错。
// 轮询游标存模块级变量，不跨重启持久化（重启后从头开始）。
let jimengSessionIndex = 0;
function jimengSessionList(jm) {
  const raw = jm?.sessionid;
  const arr = (Array.isArray(raw) ? raw : [raw])
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean);
  return arr;
}

/**
 * 调即梦生成一张图并下载为 Buffer。
 * @param {string} prompt 英文提示词
 * @param {string} [negativePrompt] 负面提示词
 * @returns {Promise<Buffer>}
 */
export async function requestAiImage(prompt, negativePrompt) {
  const jm = aiConfig.jimeng || {};
  const baseUrl = (jm.base_url || 'http://localhost:5100').replace(/\/+$/, '');
  const sessions = jimengSessionList(jm);

  if (!sessions.length) {
    throw new Error('未配置即梦 Sessionid，请在 config/ai.json 的 jimeng.sessionid 中填写。');
  }

  const endpoint = `${baseUrl}/v1/images/generations`;
  const requestBody = {
    model: jm.model || 'jimeng-5.0',
    prompt: prompt || '美丽的少女，胶片感',
    ratio: jm.ratio || undefined,
    resolution: jm.resolution || undefined,
    negative_prompt: negativePrompt || jm.negative_prompt || undefined,
  };
  // 过滤 undefined
  const body = Object.fromEntries(Object.entries(requestBody).filter(([, v]) => v !== undefined));
  const timeoutMs = jm.timeoutMs || 3600000;

  // 从当前游标取起，遍历全部 sessionid，遇到成功即返回；全失败则抛最后一个错误
  const attempts = sessions.length;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const sessionid = sessions[(jimengSessionIndex + i) % attempts];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp;
    try {
      log('info', `即梦文生图请求已发送: ${endpoint} (model=${body.model}, session 用第 ${((jimengSessionIndex + i) % attempts) + 1}/${attempts} 个)`);
      resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionid}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = new Error(err.name === 'AbortError' ? '请求超时' : err.message);
      continue; // 网络/超时错误 → 换下一个 key 重试
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      lastErr = new Error(`即梦返回错误 ${resp.status}: ${errText.slice(0, 300)}`);
      continue; // 该 key 失败(过期/限流等) → 换下一个
    }

    // 请求成功，推进游标供下次轮换
    jimengSessionIndex = (jimengSessionIndex + i + 1) % attempts;
    const data = await resp.json().catch(() => null);
    const imgUrl = data?.data?.[0]?.url;
    if (!imgUrl) {
      throw new Error(`即梦返回无图片 url：${JSON.stringify(data)?.slice(0, 300)}`);
    }

    // 下载图片
    const imgResp = await fetch(imgUrl);
    if (!imgResp.ok) throw new Error(`图片下载失败: ${imgResp.status}`);
    return Buffer.from(await imgResp.arrayBuffer());
  }

  throw lastErr || new Error('即梦请求失败');
}

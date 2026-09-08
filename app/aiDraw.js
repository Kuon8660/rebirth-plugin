import fs from 'fs';
import path from 'path';
import { log } from './log.js';
import { loadConfig } from './config.js';
import { reRender } from './reRender.js';
import { getOrCreateRebirthInfo, updateAiImage } from './rebirthCore.js';
import { afterRebirth } from './rpgHook.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置加载 ----------
// 用 config.js 统一 ensure+读取 ai.json；缺失自动从 ai.default.json 生成（sessionid 为空），
// 且 ai.json 已被 .gitignore 忽略、不随仓库分发，避免真实 sessionid 泄露。
// 读取失败/文件异常时兜底为未启用（enable:false），不影响插件其它命令。
let aiConfig = { enable: false };
try {
  aiConfig = loadConfig('ai.json', { enable: false });
} catch (err) {
  log('error', `加载 AI 配置文件失败: ${err.message}`);
}

// ---------- AI 图片保存目录（cwd 相对，供 segment.image 与 CSS 使用） ----------
const aiSaveDirRel = './plugins/rebirth-plugin/resources/rebirth/ai';

// 本地时区 yyyyMMdd
function todayStr() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

// AI 图片保存相对路径（cwd 相对，与 reRender 输出风格一致）
function aiImageRelPath(userId) {
  const name = `${userId}_${todayStr()}.png`;
  const dir = path.resolve(process.cwd(), aiSaveDirRel);
  const abs = path.join(dir, name);
  return path.relative(process.cwd(), abs).split(path.sep).join('/');
}

// ---------- 中文标签 → 英文生成词 ----------
function translateLabel(category, value) {
  const map = aiConfig._labelEnMap?.[category] || {};
  return map[value] || value;
}

// ---------- 组装英文提示词 ----------
function buildPrompt(info) {
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

  let prompt = parts.filter(Boolean).join(', ');
  prompt = prompt.replace(/,(\s*,)+/g, ',').replace(/,\s*$/, '');
  if (p.suffix) prompt += p.suffix;
  return prompt;
}

// ---------- 即梦(Jimeng) 文生图调用 ----------
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
async function requestJimengImage(prompt, negativePrompt) {
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

// 兼容旧引用：ensureTransferred 里调用 requestJimengImage
const requestImage = requestJimengImage;

// ---------- 核心流程：确保转生信息 + 确保 AI 图存在并入库 ----------
// 返回 { info, aiImageRel, cached }
async function ensureTransferredAndAiImage(userId) {
  // 1. 生成/复用当日转生信息（返回的完整行含 aiImage 列）
  const info = await getOrCreateRebirthInfo(userId);

  // 2. 目标 AI 图相对路径
  const targetRel = aiImageRelPath(userId);

  // 3. 若数据库已存该转生的 AI 图且文件仍存在 → 复用，不再调 API
  const stored = info.aiImage;
  if (stored && fs.existsSync(path.resolve(process.cwd(), stored))) {
    log('info', `用户 ${userId} 已存在 AI 立绘，复用: ${stored}`);
    return { info, aiImageRel: stored, cached: true };
  }

  // 4. 调 AI 绘图生成
  const prompt = buildPrompt(info);
  log('debug', `即梦生图提示词: ${prompt}`);

  let buf;
  try {
    buf = await requestImage(prompt, '');
  } catch (err) {
    throw new Error(`AI 绘图失败：${err.message}`);
  }

  // 5. 保存本地（确保目录存在）
  const abs = path.resolve(process.cwd(), targetRel);
  const absDir = path.dirname(abs);
  if (!fs.existsSync(absDir)) fs.mkdirSync(absDir, { recursive: true });
  fs.writeFileSync(abs, buf);
  log('info', `AI 立绘已保存: ${targetRel}`);

  // 6. 图片路径写入数据库
  await updateAiImage(userId, targetRel);
  return { info: { ...info, aiImage: targetRel }, aiImageRel: targetRel, cached: false };
}

// 读取本地图片转成 base64 data uri（用于 HTML 背景，规避跨目录相对路径问题）
function fileToDataUri(relPath) {
  const abs = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(abs)) return '';
  const mime = relPath.toLowerCase().endsWith('.jpg') || relPath.toLowerCase().endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

// ---------- 插件命令 ----------
export default class AiDrawPlugin extends plugin {
  constructor() {
    super({
      name: '异世界转生·AI立绘',
      dsc: 'ai异世界转生 / #ai异世界转生：生成转生信息并调用 AI 绘图渲染整卡',
      event: 'message',
      priority: 4999,
      rule: [
        {
          // 不区分大小写，且 # 可选：ai异世界转生 / #ai异世界转生 / AI异世界转生 / #AI异世界转生 均可
          reg: /^#?ai异世界转生$/i,
          fnc: 'aiRebirth',
          permission: 'all',
        },
      ],
    });
  }

  async aiRebirth() {
    // 1. 先判断是否启用 AI 绘图
    if (!aiConfig.enable) {
      this.reply('AI 绘图功能未启用。请先在 config/ai.json 中把 enable 设为 true，并配置即梦 base_url 与 sessionid。');
      return;
    }

    const targetUserId = this.e.at || this.e.user_id;
    this.reply('正在为你转生并绘制角色，请稍候…');

    try {
      // 2. 转生 + 生图 + 入库（info 为含 aiImage 的转生信息）
      const { info: baseInfo, aiImageRel, cached } = await ensureTransferredAndAiImage(targetUserId);

      // 2b. RPG 签到 + 把属性点加成叠加到转生四维展示（失败不阻断）；level/exp/expNext 为 RPG 等级与经验进度
      const { info, notice, level, exp, expNext, expPct, maxed } = await afterRebirth(targetUserId, baseInfo);

      // 3. 读取昵称/头像（群聊取群名片，私聊取好友昵称；取不到则用 uid 兜底）
      // 注：不同适配器 getInfo/getAvatarUrl 可能是同步返回字符串或返回 Promise，
      // 用 Promise.resolve() 统一包裹后再 catch，避免 “xxx.catch is not a function”
      const userInfo = await Promise.resolve(Bot.pickFriend(targetUserId).getInfo?.() ?? {}).catch(() => null);
      let nick = (userInfo && (userInfo.nickname || userInfo.card)) || String(targetUserId);
      if (this.e.group?.pickMember) {
        const gm = await Promise.resolve(this.e.group.pickMember(targetUserId).getInfo?.() ?? null).catch(() => null);
        if (gm && (gm.card || gm.nickname)) nick = gm.card || gm.nickname;
      }
      const avatarUrl = await Promise.resolve(Bot.pickFriend(targetUserId).getAvatarUrl?.() ?? '').catch(() => '');

      // 4. 组装渲染数据：aiImageDataUri 用作 HTML 背景
      const renderData = {
        user_id: targetUserId,
        title: '异世界转生',
        content: '测试内容',
        userName: nick,
        avatarUrl,
        level,
        exp,
        expNext,
        expPct,
        maxed,
        race: info.race,
        job: info.job,
        gender: info.gender,
        bodyType: info.bodyType,
        hairColor: info.hairColor,
        eyeColor: info.eyeColor,
        strength: info.strength,
        agility: info.agility,
        intelligence: info.intelligence,
        charisma: info.charisma,
        luckValue: info.luckValue,
        specialSkill: info.specialSkill,
        aiImageDataUri: fileToDataUri(aiImageRel),
      };

      // 5. 渲染整卡（AI 版模板：AI 立绘铺底 + 透明卡 + 等级/经验条）
      const image = await reRender(renderData, './plugins/rebirth-plugin/resources/rebirth/index.html');
      if (cached) this.reply('（今日 AI 立绘已生成，展示缓存）');
      this.reply(segment.image(image));
      if (notice) this.reply(notice, false, { at: targetUserId });
    } catch (err) {
      log('error', `AI 异世界转生执行异常: ${err}`);
      this.reply(`生成失败：${err.message}`);
    }
  }
}

// 导出核心纯逻辑，便于测试
export { translateLabel, buildPrompt, todayStr, aiImageRelPath, fileToDataUri };

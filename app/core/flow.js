import fs from 'fs';
import path from 'path';
import { log } from './infra.js';
import {
  getOrCreateRebirthInfo,
  getBonus,
  dailyCheckIn,
  getPlayer,
  expToNext,
  MAX_LEVEL,
  updateAiImage,
  recordCollection,
  getCollectedCounts,
  getDataTotals,
  formatProgressText,
} from './data.js';
import { buildPrompt, requestAiImage, aiImageRelPath } from './image.js';

/**
 * 编排层（flow）：把「原子数据操作」编成一个可复用的用例
 * ------------------------------------------------------------
 *   · afterRebirth()      转生后置：签到 + 升级结算 + 把加成叠加到转生四维
 *   · collectAndReport()  登记本次收集并生成进度文本
 *   · ensureAiImage()     确保 AI 立绘存在（缓存复用 → 生图 → 落盘 → 入库）
 *   · buildRenderData()   把领域数据映射成卡片模板变量
 *
 * 本层只做「步骤串联」，具体的读写落在 core/data.js、出图落在 core/image.js。
 * 由原 app/rpgHook.js + 转生流程里的收集/生图/渲染数据组装合并而来。
 */

const BONUS_KEYS = { strength: '力量', agility: '敏捷', intelligence: '智力', charisma: '魅力' };

// ============================================================
// 一、转生后置：签到 + 升级 + 四维加成叠加
// ============================================================
/**
 * 转生成功后统一钩子：把 RPG 加成叠加到转生四维展示，并触发当日签到。
 * @param {number} userId 目标用户
 * @param {object} info   转生信息（含 strength/agility/intelligence/charisma）
 * @returns {Promise<{ info, notice, level, exp, expNext, expPct, maxed }>}
 *   - info 为叠加 RPG 加成后的副本（四维数值已加大）
 *   - notice 为要追加到回复的签到/升级提示文本（空串则不需要追加）
 *   - level/exp/expNext/expPct/maxed 为 RPG 等级与经验进度
 */
export async function afterRebirth(userId, info) {
  let notice = '';
  let bonus = { strength: 0, agility: 0, intelligence: 0, charisma: 0 };
  let level = 0;
  let exp = 0;

  try {
    bonus = await getBonus(userId);

    // 今日签到
    const r = await dailyCheckIn(userId);
    const p = r.player;
    level = p.level;
    exp = p.exp;
    if (r.already) {
      notice = `\n【异世界等级 Lv.${p.level}】今日已签到。`;
    } else {
      let parts = [`\n【异世界等级】签到成功 +${r.gainedExp} 经验`];
      if (r.levelUp > 0) {
        parts.push(`升级至 Lv.${r.newLevel}`);
        if (p.points > 0) parts.push(`获得属性点，当前 ${p.points} 点（#异世界加点 力量 1）`);
      }
      if (r.newLevel >= MAX_LEVEL) parts.push('已达到满级 Lv.100！');
      notice = parts.join('，');
    }
  } catch (err) {
    log('warn', `RPG 签到/加成失败(不阻断转生): ${err.message}`);
    // 签到异常时仍尽力取当前等级/经验，保证卡片能显示（失败则保持 0）
    try {
      const p = await getPlayer(userId);
      level = p.level ?? 0;
      exp = p.exp ?? 0;
    } catch { /* 忽略 */ }
  }

  // 叠加加成到四维（仅用于展示副本，不改写 rebirth_info 随机基值）
  const out = { ...info };
  for (const key of Object.keys(BONUS_KEYS)) {
    if (typeof out[key] === 'number') out[key] += bonus[key] || 0;
  }
  const maxed = level >= MAX_LEVEL;
  const expNext = maxed ? 0 : expToNext(level);
  const expPct = maxed ? 100 : Math.min(100, Math.round((exp / expNext) * 100));
  return { info: out, notice, level, exp, expNext, expPct, maxed };
}

// ============================================================
// 二、收集图鉴
// ============================================================
/**
 * 转生时调用：按需登记收集 + 返回给用户看的收集进度文本。
 * @param {number} userId
 * @param {{race?:string, job?:string}} info 转生信息
 * @param {boolean} isNew 本次是否为新生成的转生（复用当日转生时不重复计数）
 * @returns {Promise<string>} 进度文本；失败返回空串（不阻断转生主流程）
 */
export async function collectAndReport(userId, info, isNew) {
  try {
    let newRaces = [];
    let newJobs = [];
    if (isNew) {
      const r = await recordCollection(userId, info?.race, info?.job);
      newRaces = r.newRaces;
      newJobs = r.newJobs;
    }
    const counts = await getCollectedCounts(userId);
    return formatProgressText(counts, getDataTotals(), newRaces, newJobs);
  } catch (err) {
    log('warn', `收集进度处理失败(不阻断转生)：${err.message}`);
    return '';
  }
}

// ============================================================
// 三、AI 立绘：确保存在（缓存 → 生图 → 落盘 → 入库）
// ============================================================
/**
 * 确保某用户的 AI 立绘可用：库里有且文件在 → 复用；否则生成并落盘、写回数据库。
 * @param {number} userId
 * @returns {Promise<{ info, aiImageRel, cached }>}
 */
export async function ensureAiImage(userId) {
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
    buf = await requestAiImage(prompt, '');
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

// ============================================================
// 四、卡片数据组装
// ============================================================
/**
 * 组装渲染卡片数据（两条转生命令共用同一字段集，避免各自维护一份）。
 * @param {object} o
 * @param {number|string} o.user_id
 * @param {object} o.info 转生信息（含 race/job/gender/bodyType/hairColor/eyeColor/四维/luckValue/specialSkill）
 * @param {string} [o.nick]  昵称
 * @param {string} [o.avatarUrl] 头像
 * @param {number} [o.level] @param {number} [o.exp] @param {number} [o.expNext]
 * @param {number} [o.expPct] @param {boolean} [o.maxed]
 * @param {string} [o.aiImageDataUri] AI 立绘 data uri（AI 版整卡背景）
 */
export function buildRenderData({
  user_id,
  info,
  nick,
  avatarUrl,
  level = 0,
  exp = 0,
  expNext = 0,
  expPct = 0,
  maxed = false,
  aiImageDataUri = '',
}) {
  return {
    user_id,
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
    aiImageDataUri,
  };
}

export { BONUS_KEYS };

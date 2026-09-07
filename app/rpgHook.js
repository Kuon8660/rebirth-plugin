import { getBonus, dailyCheckIn, MAX_LEVEL } from './rebirthRpg.js';
import { log } from './log.js';

const BONUS_KEYS = { strength: '力量', agility: '敏捷', intelligence: '智力', charisma: '魅力' };

/**
 * 转生成功后统一钩子：把 RPG 加成叠加到转生四维展示，并触发当日签到。
 * @param {number} userId 目标用户
 * @param {object} info   转生信息（含 strength/agility/intelligence/charisma）
 * @returns {Promise<{ info, notice }>}
 *   - info 为叠加 RPG 加成后的副本（四维数值已加大）
 *   - notice 为要追加到回复的签到/升级提示文本（空串则不需要追加）
 */
export async function afterRebirth(userId, info) {
  let notice = '';
  let bonus = { strength: 0, agility: 0, intelligence: 0, charisma: 0 };

  try {
    bonus = await getBonus(userId);

    // 今日签到
    const r = await dailyCheckIn(userId);
    const p = r.player;
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
  }

  // 叠加加成到四维（仅用于展示副本，不改写 rebirth_info 随机基值）
  const out = { ...info };
  for (const key of Object.keys(BONUS_KEYS)) {
    if (typeof out[key] === 'number') out[key] += bonus[key] || 0;
  }
  return { info: out, notice };
}

export { BONUS_KEYS };

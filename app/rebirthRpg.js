import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { log } from './log.js';
import { loadConfig } from './config.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 独立数据库 ----------
const rpgDbPath = path.resolve(__dirname, '../data/rpg.db');
const rpgDbDir = path.dirname(rpgDbPath);

// ---------- 独立配置 ----------
// 先内建默认值，再用 config.js 统一 ensure+读取 rpg.json（缺失自动从 rpg.default.json 生成）
let cfg = {
  maxLevel: 100,
  expPerCheckin: 10,
  expCoeff: 0.081,
  expPower: 1.6,
  minExpToNext: 5,
  attrPointEveryLevels: 5,
  startLevel: 0,
};
try {
  cfg = { ...cfg, ...loadConfig('rpg.json') };
} catch (err) {
  log('error', `加载 RPG 配置文件失败: ${err.message}`);
}

const MAX_LEVEL = cfg.maxLevel;
const EXP_PER_CHECKIN = cfg.expPerCheckin;
const EXP_COEFF = cfg.expCoeff;
const EXP_POWER = cfg.expPower;
const MIN_EXP_TO_NEXT = cfg.minExpToNext;
const EXP_STEP = cfg.expStepPerLevel ?? 1;   // 等差递增步长；缺省 1（即 10,11,12…）
const ATTR_POINT_EVERY = cfg.attrPointEveryLevels;

// 可加点的属性（对应转生四维）
const ATTR_KEYS = ['strength', 'agility', 'intelligence', 'charisma'];
const ATTR_NAMES = { strength: '力量', agility: '敏捷', intelligence: '智力', charisma: '魅力' };

// ---------- 建库建表 ----------
if (!fs.existsSync(rpgDbDir)) fs.mkdirSync(rpgDbDir, { recursive: true });
const db = new sqlite3.Database(rpgDbPath, (err) => {
  if (err) {
    log('error', `RPG 数据库连接失败: ${err.message}`);
    return;
  }
  db.run(
    `CREATE TABLE IF NOT EXISTS rpg_user (
      user_id INTEGER PRIMARY KEY,
      level INTEGER DEFAULT 0,
      exp INTEGER DEFAULT 0,
      points INTEGER DEFAULT 0,
      bonus_strength INTEGER DEFAULT 0,
      bonus_agility INTEGER DEFAULT 0,
      bonus_intelligence INTEGER DEFAULT 0,
      bonus_charisma INTEGER DEFAULT 0,
      last_checkin TEXT,
      created_time DATETIME DEFAULT (datetime('now','localtime'))
    )`,
    (e2) => {
      if (e2) log('error', `RPG 建表失败: ${e2.message}`);
      else log('info', 'RPG 表已创建');
    },
  );
});

// 今天日期(本地时区) yyyy-mm-dd
function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

// 从当前 level 升到 level+1 所需的经验
function expToNext(level) {
  // 等差递增：Lv.0→1 需 MIN_EXP_TO_NEXT(=起点)，之后每级再 +EXP_STEP。
  // 满足「最低起点经验、每下一级比上一级高(严格递增)」，不受幂曲线低端平顶影响。
  return MIN_EXP_TO_NEXT + level * EXP_STEP;
}

// 获取玩家记录（无则创建初始 Lv0）
function getPlayer(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM rpg_user WHERE user_id = ?', [userId], (err, row) => {
      if (err) return reject(new Error(`RPG 查询失败: ${err.message}`));
      if (row) return resolve(row);
      db.run('INSERT INTO rpg_user (user_id) VALUES (?)', [userId], (e2) => {
        if (e2) return reject(new Error(`RPG 建号失败: ${e2.message}`));
        db.get('SELECT * FROM rpg_user WHERE user_id = ?', [userId], (e3, row2) =>
          e3 ? reject(new Error(e3.message)) : resolve(row2),
        );
      });
    });
  });
}

/**
 * 每日签到：若今日已签到返回 {already:true, player}，否则加经验并结算升级。
 * 返回值含升级信息，便于上层展示。
 */
function dailyCheckIn(userId) {
  return new Promise(async (resolve, reject) => {
    try {
      let player = await getPlayer(userId);
      const today = todayStr();

      if (player.last_checkin === today) {
        return resolve({ already: true, player, levelUp: 0, gainedExp: 0, newLevel: player.level });
      }

      const gainedExp = EXP_PER_CHECKIN;
      let level = player.level;
      let exp = player.exp + gainedExp;
      let levelUp = 0;

      // 结算升级：exp 足够则升级，累计升级次数
      while (level < MAX_LEVEL && exp >= expToNext(level)) {
        exp -= expToNext(level);
        level += 1;
        levelUp += 1;
      }

      // 每 5 级发 1 属性点
      const pointsDelta = Math.floor(level / ATTR_POINT_EVERY) - Math.floor(player.level / ATTR_POINT_EVERY);
      const points = player.points + pointsDelta;

      db.run(
        `UPDATE rpg_user SET level=?, exp=?, points=?, last_checkin=? WHERE user_id=?`,
        [level, exp, points, today, userId],
        (err) => {
          if (err) return reject(new Error(`RPG 签到失败: ${err.message}`));
          player.level = level;
          player.exp = exp;
          player.points = points;
          player.last_checkin = today;
          resolve({ already: false, player, levelUp, gainedExp, newLevel: level });
        },
      );
    } catch (err) {
      reject(err);
    }
  });
}

// 分配属性点：消耗 points，加到指定属性
function allocatePoint(userId, attrKey, amount) {
  return new Promise((resolve, reject) => {
    if (!ATTR_KEYS.includes(attrKey)) {
      return reject(new Error(`不支持的属性：${attrKey}`));
    }
    getPlayer(userId)
      .then((player) => {
        amount = Math.floor(amount);
        if (!(amount >= 1)) return reject(new Error('加点的数值需为正整数。'));
        if (player.points < amount) {
          return reject(new Error(`属性点不足。你当前有 ${player.points} 点，需要 ${amount} 点。`));
        }
        const col = `bonus_${attrKey}`;
        db.run(`UPDATE rpg_user SET points = points - ?, ${col} = ${col} + ? WHERE user_id = ?`, [amount, amount, userId], (err) => {
          if (err) return reject(new Error(`加点失败: ${err.message}`));
          db.get('SELECT * FROM rpg_user WHERE user_id = ?', [userId], (e2, row2) =>
            e2 ? reject(new Error(e2.message)) : resolve(row2),
          );
        });
      })
      .catch(reject);
  });
}

// 读取玩家的加成属性对象 { strength, agility, intelligence, charisma }
async function getBonus(userId) {
  const p = await getPlayer(userId);
  return {
    strength: p.bonus_strength,
    agility: p.bonus_agility,
    intelligence: p.bonus_intelligence,
    charisma: p.bonus_charisma,
  };
}

// 面板文本
async function formatPanel(userId) {
  const p = await getPlayer(userId);
  const need = level < MAX_LEVEL ? expToNext(p.level) : 0;
  const next = p.level >= MAX_LEVEL ? '已满级' : `距 Lv${p.level + 1} 还需 ${need - p.exp} 经验`;
  const lines = [
    `—— 异世界等级 Lv.${p.level} / Lv.${MAX_LEVEL} ——`,
    `经验：${p.exp} / ${p.level >= MAX_LEVEL ? 'MAX' : expToNext(p.level)}`,
    next,
    `可用属性点：${p.points}`,
    `力量 +${p.bonus_strength} | 敏捷 +${p.bonus_agility} | 智力 +${p.bonus_intelligence} | 魅力 +${p.bonus_charisma}`,
    `提示：每 ${ATTR_POINT_EVERY} 级获得 1 属性点；用「#异世界加点 力量 2」分配。`,
  ];
  return lines.join('\n');
}

export { db as rpgDb, expToNext, todayStr, getPlayer, dailyCheckIn, allocatePoint, getBonus, formatPanel, ATTR_KEYS, ATTR_NAMES, MAX_LEVEL };

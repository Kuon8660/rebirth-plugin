import fs from 'fs';
import path from 'path';
import { log, loadConfig, configDir, dataDir, todayStr, randomPick, openDb, runAsync } from './infra.js';

/**
 * 领域数据层（data）
 * ------------------------------------------------------------
 * rebirth 领域的全部持久化读写，按数据来源分四段：
 *
 *   ① 内容目录   config/races · config/jobs → 种族/职业列表与四维加成（只读、启动扫一次、不碰 DB）
 *   ② 转生信息   rebirth.db → rebirth_info        （当日缓存，按创建日期过滤）
 *   ③ RPG 等级   rpg.db     → rpg_user            （等级 / 经验 / 属性点，跨天持久）
 *   ④ 收集图鉴   rpg.db     → rebirth_collection  （累计收集，跨天持久）
 *
 * 本文件只做「数据存取 + 数据→文本」；把多个数据操作编排成一个用例的工作放在 core/flow.js。
 * 两个库的连接统一走 core/infra.js 的 openDb()，消费 DDL 前先 await 对应 ready。
 */

// ---------- 共用常量 ----------
// 四维属性键：内容加成解析、转生四维、RPG 加点三处共用同一套键
const ATTR_KEYS = ['strength', 'agility', 'intelligence', 'charisma'];
const ATTR_NAMES = { strength: '力量', agility: '敏捷', intelligence: '智力', charisma: '魅力' };
// 允许在种族/职业文件里写中文键名，等价于英文键
const ATTR_ALIAS = { 力量: 'strength', 敏捷: 'agility', 智力: 'intelligence', 魅力: 'charisma' };

// ============================================================
// ① 内容目录：config/races · config/jobs
// ============================================================
// 种族/职业的属性加成按「一个种族/职业一个 JSON 文件」存放。
// 启动时扫描目录 → 得到列表 + 各自四维加成；增删文件即增删种族/职业。
const racesDir = path.join(configDir, 'races');
const jobsDir = path.join(configDir, 'jobs');

// 上次启动的扫描快照（记录种族/职业的增加与减少，仅日志用途）
const manifestPath = path.join(dataDir, 'rebirth-data-manifest.json');

// ---------- 内存态扫描结果 ----------
let RACES = [];
let JOBS = [];
let RACE_MODIFIERS = {};
let JOB_MODIFIERS = {};
let initialized = false;

// 去掉 UTF-8 BOM、整行 // 注释与尾随逗号，容忍手写 JSON
function tolerantJsonParse(text) {
  let s = String(text).replace(/^\uFEFF/, '');
  s = s
    .split(/\r?\n/)
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(s);
}

// 列出目录下可用的数据文件（只认 .json，忽略 _ 开头的模板/说明文件）
function listDataFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.json') && !f.startsWith('_'))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

// 文件名中 Windows 非法字符替换为下划线（正常种族/职业名不会触发）
function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').trim() || 'unknown';
}

// 扫描一个目录 → { names: [], modifiers: {} }
function scanDir(dir, kindLabel) {
  const files = listDataFiles(dir);
  const names = [];
  const modifiers = {};

  for (const file of files) {
    const base = file.replace(/\.json$/i, '');
    let obj;
    try {
      obj = tolerantJsonParse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      log('warn', `[rebirth-data] ${kindLabel}文件解析失败，已跳过：${file}（${err.message}）`);
      continue;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      log('warn', `[rebirth-data] ${kindLabel}文件内容不是对象，已跳过：${file}`);
      continue;
    }

    const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : base;
    if (Object.prototype.hasOwnProperty.call(modifiers, name)) {
      log('warn', `[rebirth-data] ${kindLabel}「${name}」被重复定义，已跳过：${file}`);
      continue;
    }

    const mod = {};
    for (const key of ATTR_KEYS) {
      // 优先英文键；没写则回退同名中文键（力量/敏捷/智力/魅力）
      let raw = obj[key];
      if (raw === undefined) {
        const cn = Object.keys(ATTR_ALIAS).find((k) => ATTR_ALIAS[k] === key);
        raw = obj[cn];
      }
      const v = Number(raw);
      mod[key] = Number.isFinite(v) ? v : 0;
    }

    names.push(name);
    modifiers[name] = mod;
  }

  return { names, modifiers };
}

// 把一个种族/职业导出成单个 JSON 文件
function writeOneFile(dir, name, mod) {
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    name,
    strength: mod?.strength || 0,
    agility: mod?.agility || 0,
    intelligence: mod?.intelligence || 0,
    charisma: mod?.charisma || 0,
  };
  const file = path.join(dir, `${safeFileName(name)}.json`);
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return true;
}

// 读取仓库内模板/运行时配置里的旧种族职业数据（仅用于首次导出与极端兜底）
function readLegacySource() {
  for (const file of ['rebirth.default.json', 'rebirth.json']) {
    try {
      const obj = JSON.parse(fs.readFileSync(path.join(configDir, file), 'utf8'));
      if (Array.isArray(obj?.races) && Array.isArray(obj?.jobs)) return obj;
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

// 首次使用（目录不存在或没有数据文件）时，把旧配置里的种族/职业导出成单文件，保证平滑迁移
function bootstrapFromLegacy() {
  const legacy = readLegacySource();
  if (!legacy) return false;

  let raceCount = 0;
  let jobCount = 0;
  for (const name of legacy.races) {
    if (writeOneFile(racesDir, name, legacy.raceModifiers?.[name])) raceCount++;
  }
  for (const name of legacy.jobs) {
    if (writeOneFile(jobsDir, name, legacy.jobModifiers?.[name])) jobCount++;
  }
  if (raceCount || jobCount) {
    log('warn', `[rebirth-data] 首次初始化：已从旧配置导出 ${raceCount} 个种族、${jobCount} 个职业到 config/races、config/jobs`);
  }
  return raceCount + jobCount > 0;
}

// 与上次启动快照对比，报告种族/职业的新增与移除
function diffWithManifest(key, label, names) {
  let prev = null;
  try {
    prev = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch { /* 首次运行无快照 */ }
  const old = prev && Array.isArray(prev[key]) ? prev[key] : null;
  if (!old) {
    log('info', `[rebirth-data] ${label}扫描完成：${names.length} 个`);
    return;
  }
  const added = names.filter((n) => !old.includes(n));
  const removed = old.filter((n) => !names.includes(n));
  const parts = [`${names.length} 个`];
  parts.push(`新增 ${added.length}${added.length ? `（${added.join('、')}）` : ''}`);
  parts.push(`移除 ${removed.length}${removed.length ? `（${removed.join('、')}）` : ''}`);
  log('info', `[rebirth-data] ${label}扫描完成：${parts.join('，')}`);
}

function saveManifest() {
  try {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ races: RACES, jobs: JOBS, scannedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch (err) {
    log('warn', `[rebirth-data] 写入扫描快照失败：${err.message}`);
  }
}

/**
 * 启动时调用：扫描 config/races 与 config/jobs，构建种族/职业列表与四维加成。
 * 幂等；目录为空时自动从旧配置导出一份单文件作为初始数据。
 */
function initRebirthData() {
  if (initialized) return;

  // 1. 首次使用：目录缺失/为空 → 从旧配置导出单文件
  if (listDataFiles(racesDir).length === 0 || listDataFiles(jobsDir).length === 0) {
    try {
      bootstrapFromLegacy();
    } catch (err) {
      log('error', `[rebirth-data] 初始化导出失败：${err.message}`);
    }
  }

  // 2. 扫描目录（目录即唯一数据源）
  const races = scanDir(racesDir, '种族');
  const jobs = scanDir(jobsDir, '职业');

  RACES = races.names;
  RACE_MODIFIERS = races.modifiers;
  JOBS = jobs.names;
  JOB_MODIFIERS = jobs.modifiers;

  // 3. 极端兜底：目录读不到任何条目时，回退旧配置，避免插件整体不可用
  if (RACES.length === 0 || JOBS.length === 0) {
    const legacy = readLegacySource();
    if (legacy) {
      if (RACES.length === 0) {
        RACES = legacy.races.slice();
        RACE_MODIFIERS = {};
        for (const n of RACES) RACE_MODIFIERS[n] = { ...(legacy.raceModifiers?.[n] || {}) };
        log('warn', `[rebirth-data] config/races 无可用文件，已临时回退旧配置的 ${RACES.length} 个种族`);
      }
      if (JOBS.length === 0) {
        JOBS = legacy.jobs.slice();
        JOB_MODIFIERS = {};
        for (const n of JOBS) JOB_MODIFIERS[n] = { ...(legacy.jobModifiers?.[n] || {}) };
        log('warn', `[rebirth-data] config/jobs 无可用文件，已临时回退旧配置的 ${JOBS.length} 个职业`);
      }
    }
  }

  if (RACES.length === 0) log('error', '[rebirth-data] 未扫描到任何种族，请检查 config/races 目录');
  if (JOBS.length === 0) log('error', '[rebirth-data] 未扫描到任何职业，请检查 config/jobs 目录');

  // 4. 报告本次启动相对上次的增加/减少
  diffWithManifest('races', '种族', RACES);
  diffWithManifest('jobs', '职业', JOBS);
  saveManifest();

  initialized = true;
}

// ---------- 对外读取接口 ----------
function getRaces() {
  if (!initialized) initRebirthData();
  return RACES;
}
function getJobs() {
  if (!initialized) initRebirthData();
  return JOBS;
}
function getRaceModifiers(name) {
  if (!initialized) initRebirthData();
  return RACE_MODIFIERS[name] || {};
}
function getJobModifiers(name) {
  if (!initialized) initRebirthData();
  return JOB_MODIFIERS[name] || {};
}
function getDataTotals() {
  if (!initialized) initRebirthData();
  return { races: RACES.length, jobs: JOBS.length };
}

// ============================================================
// ② 转生信息：rebirth.db → rebirth_info（当日缓存）
// ============================================================
// 用 infra.js 统一 ensure+读取 rebirth.json（缺失自动从 rebirth.default.json 生成）
const rebirth = loadConfig('rebirth.json');

// rebirthReady = 连接打开 + rebirth_info 建表 + aiImage 补列 完成。
// 所有读写都应先 await 它，避免在 open 完成前入队的语句抢先执行报 “no such table”。
const { db: rebirthDb, ready: rebirthReady, dbPath } = openDb('rebirth.db', async (d) => {
  await runAsync(
    d,
    `CREATE TABLE IF NOT EXISTS rebirth_info (
      user_id INTEGER PRIMARY KEY,
      race TEXT,
      job TEXT,
      gender TEXT,
      bodyType TEXT,
      hairColor TEXT,
      eyeColor TEXT,
      strength INTEGER,
      agility INTEGER,
      intelligence INTEGER,
      charisma INTEGER,
      luckValue INTEGER,
      specialSkill TEXT,
      aiImage TEXT,
      createdTime DATETIME DEFAULT (datetime('now','localtime'))
    )`,
  );
  log('info', '表已创建');
  // 为已存在的旧表补充 aiImage 列（CREATE IF NOT EXISTS 不会改旧表结构）
  try {
    await runAsync(d, 'ALTER TABLE rebirth_info ADD COLUMN aiImage TEXT');
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) {
      log('warn', `补充 aiImage 列失败(可能已存在): ${e.message}`);
    }
  }
});

// 清除每天凌晨的数据
function clearOldData() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const timeUntilMidnight = nextMidnight - now;
  setTimeout(() => {
    rebirthDb.run('DELETE FROM rebirth_info', (err) => {
      if (err) {
        log('error', `无法清除数据: ${err.message}`);
      } else {
        log('info', '数据已清除');
      }
    });
    clearOldData();
  }, timeUntilMidnight);
}
clearOldData();

// 随机取数组元素（保留原函数名的别名；实现见 core/infra.js 的 randomPick）
const getRandomElement = randomPick;

// 读取用户「今日」的转生信息（无则返回 null）。
// ⚠️ 必须按创建日期过滤：rebirth_info 是「当日转生缓存」，
// 由 clearOldData() 的午夜定时器清空；但 bot 若停机跨天后再启动，表里会残留旧日期的行。
// 若只判断“行是否存在”，就会把旧转生误判为“今日已转生”→ 复用旧数据、且跳过收集图鉴。
async function getRebirthInfo(userId) {
  await rebirthReady; // 等表建好，避免首次调用与建表竞态
  return new Promise((resolve, reject) => {
    rebirthDb.get(
      'SELECT * FROM rebirth_info WHERE user_id = ? AND substr(createdTime, 1, 10) = ?',
      [userId, todayStr()],
      (err, row) => {
        if (err) {
          log('error', `查询数据库失败: ${err.message}`);
          return reject(new Error('查询数据库失败'));
        }
        resolve(row || null);
      },
    );
  });
}

// 若用户当日尚无转生信息，则随机生成并入库；否则直接返回已有记录。
// 返回一个干净的转生信息对象（含 aiImage 字段，可能为 null）；
// 附带的 isNew 标记本次是否为新生成（供收集图鉴判断是否计入新收集，不入库）。
async function getOrCreateRebirthInfo(userId) {
  const exist = await getRebirthInfo(userId);
  if (exist) {
    log('info', `用户 ${userId} 已有转生信息，直接复用`);
    return { ...exist, isNew: false };
  }

  // 种族/职业列表与其四维加成来自 config/races、config/jobs 目录（启动时扫描）
  const newInfo = {
    user_id: userId,
    race: getRandomElement(getRaces()),
    job: getRandomElement(getJobs()),
    gender: getRandomElement(rebirth.genders),
    bodyType: getRandomElement(rebirth.bodyTypes),
    hairColor: getRandomElement(rebirth.hairColors),
    eyeColor: getRandomElement(rebirth.eyeColors),
    specialSkill: getRandomElement(rebirth.specialSkills),
    luckValue: Math.floor(Math.random() * 100) + 1,
    aiImage: null,
  };

  // 根据种族和职业调整属性
  const raceModifiers = getRaceModifiers(newInfo.race);
  const jobModifiers = getJobModifiers(newInfo.job);
  newInfo.strength =
    Math.floor(Math.random() * 10) + 1 + (raceModifiers.strength || 0) + (jobModifiers.strength || 0);
  newInfo.agility =
    Math.floor(Math.random() * 10) + 1 + (raceModifiers.agility || 0) + (jobModifiers.agility || 0);
  newInfo.intelligence =
    Math.floor(Math.random() * 10) + 1 + (raceModifiers.intelligence || 0) + (jobModifiers.intelligence || 0);
  newInfo.charisma =
    Math.floor(Math.random() * 10) + 1 + (raceModifiers.charisma || 0) + (jobModifiers.charisma || 0);

  // 先清掉该用户可能残留的旧日转生行（user_id 是主键，旧行会让 INSERT 主键冲突；
  // 上面按日期查询已确保这里不会命中“今日”的有效行）。
  await new Promise((resolve) => {
    rebirthDb.run('DELETE FROM rebirth_info WHERE user_id = ?', [userId], () => resolve());
  });

  await new Promise((resolve, reject) => {
    rebirthDb.run(
      `INSERT INTO rebirth_info
        (user_id, race, job, gender, bodyType, hairColor, eyeColor,
         strength, agility, intelligence, charisma, luckValue, specialSkill, aiImage)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId, newInfo.race, newInfo.job, newInfo.gender, newInfo.bodyType,
        newInfo.hairColor, newInfo.eyeColor, newInfo.strength, newInfo.agility,
        newInfo.intelligence, newInfo.charisma, newInfo.luckValue, newInfo.specialSkill,
        newInfo.aiImage,
      ],
      (err) => {
        if (err) {
          log('error', `插入数据库失败: ${err.message}`);
          return reject(new Error('插入数据库失败'));
        }
        log('info', `用户 ${userId} 生成了新的转生信息: 种族=${newInfo.race}, 职业=${newInfo.job}`);
        resolve();
      },
    );
  });
  // 标记为新生成：收集图鉴据此把这次的种族/职业计入“新收集”
  return { ...newInfo, isNew: true };
}

// 更新用户的 AI 图片路径
async function updateAiImage(userId, imagePath) {
  await rebirthReady; // 同上：确保表已就绪
  return new Promise((resolve, reject) => {
    rebirthDb.run('UPDATE rebirth_info SET aiImage = ? WHERE user_id = ?', [imagePath, userId], (err) => {
      if (err) {
        log('error', `更新 aiImage 失败: ${err.message}`);
        return reject(new Error('更新 AI 图片路径失败'));
      }
      log('info', `用户 ${userId} 的 aiImage 已更新: ${imagePath}`);
      resolve();
    });
  });
}

// ============================================================
// ③ RPG 等级：rpg.db → rpg_user
// ============================================================
// 先内建默认值，再用 infra.js 统一 ensure+读取 rpg.json（缺失自动从 rpg.default.json 生成）
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

// rpgReady = 连接打开 + rpg_user 建表完成。其它表（如收集图鉴）必须 await 它
// 之后再建自己的表，否则语句可能先于建表执行，报 “no such table” 竞态。
const { db: rpgDb, ready: rpgReady } = openDb('rpg.db', (d) =>
  runAsync(
    d,
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
  ).then(() => log('info', 'RPG 表已创建')),
);

// 从当前 level 升到 level+1 所需的经验
function expToNext(level) {
  // 等差递增：Lv.0→1 需 MIN_EXP_TO_NEXT(=起点)，之后每级再 +EXP_STEP。
  // 满足「最低起点经验、每下一级比上一级高(严格递增)」，不受幂曲线低端平顶影响。
  return MIN_EXP_TO_NEXT + level * EXP_STEP;
}

// 获取玩家记录（无则创建初始 Lv0）
function getPlayer(userId) {
  return new Promise((resolve, reject) => {
    rpgDb.get('SELECT * FROM rpg_user WHERE user_id = ?', [userId], (err, row) => {
      if (err) return reject(new Error(`RPG 查询失败: ${err.message}`));
      if (row) return resolve(row);
      rpgDb.run('INSERT INTO rpg_user (user_id) VALUES (?)', [userId], (e2) => {
        if (e2) return reject(new Error(`RPG 建号失败: ${e2.message}`));
        rpgDb.get('SELECT * FROM rpg_user WHERE user_id = ?', [userId], (e3, row2) =>
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

      rpgDb.run(
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
        rpgDb.run(`UPDATE rpg_user SET points = points - ?, ${col} = ${col} + ? WHERE user_id = ?`, [amount, amount, userId], (err) => {
          if (err) return reject(new Error(`加点失败: ${err.message}`));
          rpgDb.get('SELECT * FROM rpg_user WHERE user_id = ?', [userId], (e2, row2) =>
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
  const maxed = p.level >= MAX_LEVEL;
  const need = maxed ? 0 : expToNext(p.level);
  const next = maxed ? '已满级' : `距 Lv${p.level + 1} 还需 ${need - p.exp} 经验`;
  const lines = [
    `—— 异世界等级 Lv.${p.level} / Lv.${MAX_LEVEL} ——`,
    `经验：${p.exp} / ${maxed ? 'MAX' : expToNext(p.level)}`,
    next,
    `可用属性点：${p.points}`,
    `力量 +${p.bonus_strength} | 敏捷 +${p.bonus_agility} | 智力 +${p.bonus_intelligence} | 魅力 +${p.bonus_charisma}`,
    `提示：每 ${ATTR_POINT_EVERY} 级获得 1 属性点；用「#异世界加点 力量 2」分配。`,
  ];
  return lines.join('\n');
}

// ============================================================
// ④ 收集图鉴：rpg.db → rebirth_collection（累计，跨天持久）
// ============================================================
// 记录每个用户「累计」收集到的种族与职业（永久，不随每日转生重置）。
// 数据表建在 rpg.db 内（与等级/属性同库，同为跨天持久化的用户数据）。
//
// 注意：建表必须等 rpg.db 连接就绪后再执行（sqlite3 在 open 前入队的语句
// 可能被之后的语句抢先执行，导致 “no such table” 竞态）。
const DB_SCHEMA = `CREATE TABLE IF NOT EXISTS rebirth_collection (
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  first_date TEXT,
  count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, kind, name)
)`;

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = rpgReady
      .then(() => new Promise((resolve, reject) => rpgDb.run(DB_SCHEMA, (err) => (err ? reject(err) : resolve()))))
      .then(() => log('info', '收集表已创建'))
      .catch((err) => {
        log('error', `收集表创建失败：${err.message}`);
        tableReady = null; // 允许下次重试
        throw err;
      });
  }
  return tableReady;
}
// 启动即预热建表
ensureTable().catch(() => {});

// 记录一次收集事件（同一种族/职业重复获得只累加次数，不再计入“新收集”）
function recordOne(userId, kind, name, newList) {
  return new Promise((resolve) => {
    rpgDb.run(
      'INSERT OR IGNORE INTO rebirth_collection (user_id, kind, name, first_date, count) VALUES (?, ?, ?, ?, 1)',
      [userId, kind, name, todayStr()],
      function (err) {
        if (err) {
          log('warn', `收集记录失败(${kind}/${name})：${err.message}`);
          return resolve();
        }
        if (this.changes > 0) {
          // 首次收集 → 计入新收集
          newList.push(name);
          return resolve();
        }
        rpgDb.run(
          'UPDATE rebirth_collection SET count = count + 1 WHERE user_id = ? AND kind = ? AND name = ?',
          [userId, kind, name],
          (e2) => {
            if (e2) log('warn', `收集次数累加失败(${kind}/${name})：${e2.message}`);
            resolve();
          },
        );
      },
    );
  });
}

/**
 * 记录本次转生获得的种族/职业。
 * @returns {Promise<{ newRaces: string[], newJobs: string[] }>}
 */
async function recordCollection(userId, race, job) {
  await ensureTable();
  const newRaces = [];
  const newJobs = [];
  if (race) await recordOne(userId, 'race', race, newRaces);
  if (job) await recordOne(userId, 'job', job, newJobs);
  return { newRaces, newJobs };
}

// 读取该用户已收集数量
async function getCollectedCounts(userId) {
  await ensureTable();
  return new Promise((resolve) => {
    rpgDb.all(
      'SELECT kind, COUNT(*) AS c FROM rebirth_collection WHERE user_id = ? GROUP BY kind',
      [userId],
      (err, rows) => {
        if (err) {
          log('warn', `查询收集进度失败：${err.message}`);
          return resolve({ race: 0, job: 0 });
        }
        const out = { race: 0, job: 0 };
        for (const r of rows || []) {
          if (r.kind === 'race') out.race = r.c;
          else if (r.kind === 'job') out.job = r.c;
        }
        resolve(out);
      },
    );
  });
}

// 组装收集进度提示文本
function formatProgressText(counts, totals, newRaces = [], newJobs = []) {
  const lines = [`【异世界收集】种族 ${counts.race}/${totals.races} · 职业 ${counts.job}/${totals.jobs}`];
  const gains = [];
  if (newRaces.length) gains.push(`种族「${newRaces.join('」「')}」`);
  if (newJobs.length) gains.push(`职业「${newJobs.join('」「')}」`);
  if (gains.length) lines.push(`本次新收集：${gains.join('、')}`);
  return lines.join('\n');
}

// ============================================================
// 导出（对外名与合并前保持一致）
// ============================================================
export {
  // ① 内容目录
  initRebirthData,
  getRaces,
  getJobs,
  getRaceModifiers,
  getJobModifiers,
  getDataTotals,
  racesDir,
  jobsDir,
  // ② 转生信息
  rebirth,
  dbPath,
  rebirthReady,
  getRandomElement,
  getRebirthInfo,
  getOrCreateRebirthInfo,
  updateAiImage,
  // ③ RPG 等级
  rpgDb,
  rpgReady,
  expToNext,
  getPlayer,
  dailyCheckIn,
  allocatePoint,
  getBonus,
  formatPanel,
  MAX_LEVEL,
  ATTR_KEYS,
  ATTR_NAMES,
  // ④ 收集图鉴
  recordCollection,
  getCollectedCounts,
  formatProgressText,
};

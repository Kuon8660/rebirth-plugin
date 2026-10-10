import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 配置目录 ----------
// 种族/职业的属性加成改为「一个种族/职业一个 JSON 文件」，放在这两个独立目录里。
// 启动时扫描目录 → 得到种族/职业列表 + 各自的四维加成；增删文件即增删种族/职业。
const configDir = path.resolve(__dirname, '../config');
const racesDir = path.join(configDir, 'races');
const jobsDir = path.join(configDir, 'jobs');

// 上次启动的扫描快照（记录种族/职业的增加与减少，仅日志用途）
const manifestPath = path.resolve(__dirname, '../data/rebirth-data-manifest.json');

// 四维属性键（与重生数据、RPG 加成保持一致）
const ATTR_KEYS = ['strength', 'agility', 'intelligence', 'charisma'];
// 允许在文件里写中文键名，等价于英文键
const ATTR_ALIAS = { 力量: 'strength', 敏捷: 'agility', 智力: 'intelligence', 魅力: 'charisma' };

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

export {
  initRebirthData,
  getRaces,
  getJobs,
  getRaceModifiers,
  getJobModifiers,
  getDataTotals,
  racesDir,
  jobsDir,
};

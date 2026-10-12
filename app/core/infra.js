import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import util from '../../../../lib/util.js';

/**
 * 基础层（infra）
 * ------------------------------------------------------------
 * 插件的「底座」：日志 / 配置 / 路径与通用工具 / SQLite 连接。
 *
 * 只依赖框架 lib 与 node 内置模块，不依赖任何业务代码；
 * 上层（数据 data / 产出 image / 编排 flow / 命令 commands）都从这里取基础能力。
 * 本文件由原 core/log.js + core/config.js + core/util.js + core/db.js 合并而来，
 * 对外能力（导出名）与原四模块保持一致。
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- 路径常量（相对本模块 ../.. = 插件根目录） ----------
export const pluginRoot = path.resolve(__dirname, '../..'); // plugins/rebirth-plugin
export const configDir = path.join(pluginRoot, 'config');
export const dataDir = path.join(pluginRoot, 'data');

// ============================================================
// 日志
// ============================================================
/**
 * 包装框架 util.makeLog：统一加 [rebirth-plugin] 前缀。
 * @param {string} level trace/debug/info/warn/error/fatal/mark
 * @param {string|array} msg
 * @param {string} [id]
 * @param {boolean} [force]
 */
export function log(level, msg, id, force) {
  util.makeLog(level, '[rebirth-plugin]' + msg, id, force);
}

// ============================================================
// 日期（本地时区）
// ============================================================
// yyyy-mm-dd：与 rebirth_info / rpg_user 的日期字段格式一致
export function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}

// yyyyMMdd：用于 AI 立绘文件名 {qq}_{yyyyMMdd}.png
export function todayStamp() {
  const n = new Date();
  return `${n.getFullYear()}${String(n.getMonth() + 1).padStart(2, '0')}${String(n.getDate()).padStart(2, '0')}`;
}

// ============================================================
// 通用小工具
// ============================================================
// 随机取数组元素
export function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 本地文件 → base64 data uri（用于 HTML 背景，规避跨目录相对路径问题）
export function fileToDataUri(relPath) {
  const abs = path.resolve(process.cwd(), relPath);
  if (!fs.existsSync(abs)) return '';
  const lower = relPath.toLowerCase();
  const mime = lower.endsWith('.jpg') || lower.endsWith('.jpeg') ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(abs).toString('base64')}`;
}

/**
 * 读取用户昵称与头像（群聊优先取群名片，私聊取好友昵称；取不到用 uid 兜底）。
 * 注：不同适配器 getInfo/getAvatarUrl 可能同步返回，一律 Promise.resolve 包裹后再 catch，
 * 避免 “xxx.catch is not a function”。
 * @param {object} e 事件对象（可含 e.group）
 * @param {number|string} userId
 * @returns {Promise<{ nick: string, avatarUrl: string }>}
 */
export async function fetchUserProfile(e, userId) {
  const userInfo = await Promise.resolve(Bot.pickFriend(userId).getInfo?.() ?? {}).catch(() => null);
  let nick = (userInfo && (userInfo.nickname || userInfo.card)) || String(userId);
  if (e?.group?.pickMember) {
    const gm = await Promise.resolve(e.group.pickMember(userId).getInfo?.() ?? null).catch(() => null);
    if (gm && (gm.card || gm.nickname)) nick = gm.card || gm.nickname;
  }
  const avatarUrl = await Promise.resolve(Bot.pickFriend(userId).getAvatarUrl?.() ?? '').catch(() => '');
  return { nick, avatarUrl };
}

// ============================================================
// 配置（运行时 JSON：缺失则从 *.default.json 自动生成）
// ============================================================
// 需要自动检测并生成默认配置的运行时配置文件。
//   例：ai.json <- ai.default.json（sessionid 为空，防泄露）
const RUNTIME_CONFIGS = ['config.json', 'rebirth.json', 'rpg.json', 'ai.json'];

// 运行时配置名 -> 默认模板名（ai.default.json 等）
function defaultFor(name) {
  return name.replace(/\.json$/, '.default.json');
}

/**
 * 确保单个运行时配置存在：缺失则从仓库内默认模板复制生成。
 * 幂等：文件已存在则直接返回，绝不覆盖用户已有配置（避免冲掉已填的 sessionid）。
 * @param {string} name 配置文件名，如 'ai.json'
 * @returns {string} 配置文件绝对路径
 */
export function ensureConfig(name) {
  const live = path.join(configDir, name);
  if (fs.existsSync(live)) return live;

  try {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const def = path.join(configDir, defaultFor(name));
    if (fs.existsSync(def)) {
      fs.copyFileSync(def, live);
      log('warn', `检测到配置文件缺失，已从默认模板生成: config/${name}`);
      if (name === 'ai.json') {
        log('warn', 'config/ai.json 已自动生成，请填写 jimeng.sessionid 后即可启用 AI 异世界立绘');
      }
    } else {
      fs.writeFileSync(live, '{}\n', 'utf8');
      log('warn', `配置文件缺失且无默认模板，已生成空配置: config/${name}`);
    }
  } catch (err) {
    log('error', `自动生成配置文件失败 config/${name}: ${err.message}`);
  }
  return live;
}

/** 启动时调用一次：确保所有运行时配置都已生成（缺则补）。 */
export function ensureAllConfigs() {
  for (const name of RUNTIME_CONFIGS) ensureConfig(name);
}

/**
 * 统一读取运行时 JSON 配置：先 ensure 再读，读不到则返回 fallback（不抛错）。
 * @param {string} name 配置文件名，如 'config.json'
 * @param {object} [fallback] 读取失败时的兜底对象
 * @returns {object} 解析后的配置对象
 */
export function loadConfig(name, fallback = {}) {
  ensureConfig(name);
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
  } catch (err) {
    log('error', `读取配置 config/${name} 失败: ${err.message}`);
    return fallback;
  }
}

// ============================================================
// SQLite 统一访问层
// ============================================================
// 插件目前有两个库，都固定落在 data/ 下（路径不可改，改了会读不到已有用户数据）：
//   rebirth.db → rebirth_info                    （当日转生缓存）
//   rpg.db     → rpg_user / rebirth_collection   （等级经验、收集图鉴）
//
// 集中在这里的原因：sqlite3 的 new Database() 是「异步打开」的，
// open 回调触发之前入队的语句可能被之后发出的语句抢先执行，从而报 “no such table”。
// 统一后两个库都走同一条「连接 → 初始化(建表/补列) → 就绪」链，消费方一律先 await ready。

/**
 * 打开 data/ 下的一个 SQLite 库，并把「连接成功 + 初始化完成」固化成一条 ready Promise。
 * @param {string} fileName 数据库文件名，如 'rebirth.db'（固定在 data/ 下）
 * @param {(db: import('sqlite3').Database) => any} [init] 建表/补列等初始化（连接成功后执行）
 * @returns {{ db: import('sqlite3').Database, ready: Promise, dbPath: string }}
 *   ready 在 init 完成后 resolve(db)；连接或 init 失败则 reject。
 */
export function openDb(fileName, init) {
  const dbPath = path.join(dataDir, fileName);
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    log('info', `数据库文件夹不存在，正在创建: ${dbDir}`);
  }

  let markReady;
  let markFail;
  const ready = new Promise((resolve, reject) => {
    markReady = resolve;
    markFail = reject;
  });
  // 就绪失败不应变成「未捕获的 rejection」噪音；消费方仍可 await ready 拿到错误
  ready.catch(() => {});

  const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      log('error', `数据库连接失败 ${fileName}: ${err.message}`);
      markFail(err);
      return;
    }
    log('info', `数据库连接成功: ${fileName}`);
    Promise.resolve()
      .then(() => (typeof init === 'function' ? init(db) : undefined))
      .then(() => markReady(db))
      .catch((e2) => {
        log('error', `数据库初始化失败 ${fileName}: ${e2?.message || e2}`);
        markFail(e2);
      });
  });

  return { db, ready, dbPath };
}

/** Promise 化的 db.run（建表、补列等初始化语句用） */
export function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

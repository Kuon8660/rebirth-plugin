import { log } from './log.js';
import { rpgDb as db, rpgReady, todayStr } from './rebirthRpg.js';
import { getDataTotals } from './rebirthData.js';

// 收集图鉴：记录每个用户「累计」收集到的种族与职业（永久，不随每日转生重置）。
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
      .then(() => new Promise((resolve, reject) => db.run(DB_SCHEMA, (err) => (err ? reject(err) : resolve()))))
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
    db.run(
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
        db.run(
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
 * @param {number} userId
 * @param {string} race
 * @param {string} job
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
    db.all(
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

/**
 * 转生时调用：按需登记收集 + 返回给用户看的收集进度文本。
 * @param {number} userId
 * @param {{race?:string, job?:string}} info 转生信息
 * @param {boolean} isNew 本次是否为新生成的转生（复用当日转生时不重复计数）
 * @returns {Promise<string>} 进度文本；失败返回空串（不阻断转生主流程）
 */
async function collectAndReport(userId, info, isNew) {
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

export { recordCollection, getCollectedCounts, formatProgressText, collectAndReport };

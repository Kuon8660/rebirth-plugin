import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { log } from './log.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = path.resolve(__dirname, '../data/rebirth.db');
const dbDir = path.dirname(dbPath);

const rebirthPath = path.resolve(__dirname, '../config/rebirth.json');
const rebirth = JSON.parse(fs.readFileSync(rebirthPath, 'utf8'));

// 确保数据库目录存在
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  log('info', `数据库文件夹不存在，正在创建: ${dbDir}`);
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    log('error', `无法打开数据库: ${err.message}`);
    return;
  }
  log('info', '数据库连接成功');
  db.run(
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
    (err) => {
      if (err) {
        log('error', `创建表失败: ${err.message}`);
        return;
      }
      log('info', '表已创建');
      // 为已存在的旧表补充 aiImage 列（CREATE IF NOT EXISTS 不会改旧表结构）
      db.run('ALTER TABLE rebirth_info ADD COLUMN aiImage TEXT', (err) => {
        if (err && !/duplicate column/i.test(err.message)) {
          log('warn', `补充 aiImage 列失败(可能已存在): ${err.message}`);
        }
      });
    },
  );
});

// 清除每天凌晨的数据
function clearOldData() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const timeUntilMidnight = nextMidnight - now;
  setTimeout(() => {
    db.run('DELETE FROM rebirth_info', (err) => {
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

// 随机取数组元素
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 读取用户转生信息（无则返回 null）
function getRebirthInfo(userId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM rebirth_info WHERE user_id = ?', [userId], (err, row) => {
      if (err) {
        log('error', `查询数据库失败: ${err.message}`);
        return reject(new Error('查询数据库失败'));
      }
      resolve(row || null);
    });
  });
}

// 若用户当日尚无转生信息，则随机生成并入库；否则直接返回已有记录。
// 返回一个干净的转生信息对象（含 aiImage 字段，可能为 null）。
async function getOrCreateRebirthInfo(userId) {
  const exist = await getRebirthInfo(userId);
  if (exist) {
    log('info', `用户 ${userId} 已有转生信息，直接复用`);
    return exist;
  }

  const newInfo = {
    user_id: userId,
    race: getRandomElement(rebirth.races),
    job: getRandomElement(rebirth.jobs),
    gender: getRandomElement(rebirth.genders),
    bodyType: getRandomElement(rebirth.bodyTypes),
    hairColor: getRandomElement(rebirth.hairColors),
    eyeColor: getRandomElement(rebirth.eyeColors),
    specialSkill: getRandomElement(rebirth.specialSkills),
    luckValue: Math.floor(Math.random() * 100) + 1,
    aiImage: null,
  };

  // 根据种族和职业调整属性
  const raceModifiers = rebirth.raceModifiers[newInfo.race] || {};
  const jobModifiers = rebirth.jobModifiers[newInfo.job] || {};
  newInfo.strength =
    Math.floor(Math.random() * 10) + 1 + (raceModifiers.strength || 0) + (jobModifiers.strength || 0);
  newInfo.agility =
    Math.floor(Math.random() * 10) + 1 + (raceModifiers.agility || 0) + (jobModifiers.agility || 0);
  newInfo.intelligence =
    Math.floor(Math.random() * 10) + 1 + (raceModifiers.intelligence || 0) + (jobModifiers.intelligence || 0);
  newInfo.charisma =
    Math.floor(Math.random() * 10) + 1 + (raceModifiers.charisma || 0) + (jobModifiers.charisma || 0);

  await new Promise((resolve, reject) => {
    db.run(
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
  return newInfo;
}

// 更新用户的 AI 图片路径
function updateAiImage(userId, imagePath) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE rebirth_info SET aiImage = ? WHERE user_id = ?', [imagePath, userId], (err) => {
      if (err) {
        log('error', `更新 aiImage 失败: ${err.message}`);
        return reject(new Error('更新 AI 图片路径失败'));
      }
      log('info', `用户 ${userId} 的 aiImage 已更新: ${imagePath}`);
      resolve();
    });
  });
}

export { rebirth, dbPath, getRandomElement, getRebirthInfo, getOrCreateRebirthInfo, updateAiImage };

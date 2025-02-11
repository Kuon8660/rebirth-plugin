import { log } from "./log.js";
import sqlite3 from 'sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 获取当前模块的目录名
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 初始化数据库
const dbPath = path.resolve(__dirname, '../data/rebirth.db');
const dbDir = path.dirname(dbPath);

// 检查并创建文件夹
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
  log("info", `数据库文件夹不存在，正在创建: ${dbDir}`);
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    log("error", `无法打开数据库: ${err.message}`);
  } else {
    log("info", "数据库连接成功");
    // 初始化表结构
    db.run(`CREATE TABLE IF NOT EXISTS rebirth_info (
      user_id TEXT PRIMARY KEY,
      race TEXT,
      job TEXT,
      rpg_attributes TEXT,
      special_skill TEXT,
      gender TEXT,
      body_type TEXT,
      hair_color TEXT,
      eye_color TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
      if (err) {
        log("error", `创建表失败: ${err.message}`);
      } else {
        log("info", "表已创建");
      }
    });
  }
});

// 加载配置文件
const configPath = path.resolve(__dirname, '../config/rebirth.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// 随机选择一个数组中的元素
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 根据种族和职业生成RPG属性
function generateRpgAttributes(race, job) {
  const baseAttributes = {
    strength: Math.floor(Math.random() * 10) + 1,
    agility: Math.floor(Math.random() * 10) + 1,
    intelligence: Math.floor(Math.random() * 10) + 1,
    charisma: Math.floor(Math.random() * 10) + 1
  };

  // 根据种族和职业调整属性
  const raceModifiers = config.raceModifiers[race] || {};
  const jobModifiers = config.jobModifiers[job] || {};

  baseAttributes.strength += (raceModifiers.strength || 0) + (jobModifiers.strength || 0);
  baseAttributes.agility += (raceModifiers.agility || 0) + (jobModifiers.agility || 0);
  baseAttributes.intelligence += (raceModifiers.intelligence || 0) + (jobModifiers.intelligence || 0);
  baseAttributes.charisma += (raceModifiers.charisma || 0) + (jobModifiers.charisma || 0);

  return baseAttributes;
}

// 清除每天凌晨的数据
function clearOldData() {
  const now = new Date();
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);
  const timeUntilMidnight = nextMidnight - now;

  setTimeout(() => {
    db.run('DELETE FROM rebirth_info', (err) => {
      if (err) {
        log("error", `无法清除数据: ${err.message}`);
      } else {
        log("info", "数据已清除");
      }
    });
    clearOldData(); // 重新设置定时器
  }, timeUntilMidnight);
}

clearOldData(); // 初始调用

/**
 * 获取at的id,没有则返回用户id
 * @param {string|string[]} at
 * @param {string} id
 * @returns {string}
 */
export function getAtUid(at, id) {
  return at || id;
}

export default class RebirthPlugin extends plugin {
  constructor() {
    super({
      name: "异世界转生",
      dsc: "异世界转生插件",
      event: "message",
      priority: 5000,
      rule: [
        {
          reg: "^异世界转生$",
          fnc: "rebirth",
          permission: "all",
        }
      ]
    });
  }

  async rebirth() {
    // 获取当前用户的ID
    const userId = this.e.user_id;

    // 获取消息中@的用户ID
    const message = this.e.at;

    // 记录消息内容到调试日志
    log("debug", message);

    // 如果消息内容存在，则使用消息内容作为目标用户ID，否则使用当前用户ID
    const targetUserId = message || userId;

    // 查询数据库
    db.get('SELECT * FROM rebirth_info WHERE user_id = ?', [targetUserId], (err, row) => {
      if (err) {
        log("error", `查询数据库失败: ${err.message}`);
        return this.reply("查询数据库失败，请稍后再试", true, { at: true });
      }

      if (row) {
        // 如果存在记录，返回记录信息
        log("info", `用户 ${targetUserId} 已有转生信息`);
        const replyMessage = this.formatRebirthInfo(row);
        log("debug", this.formatRebirthInfo(row));
        return this.reply(replyMessage, true, { at: targetUserId }); // 修改: 确保回复消息内容正确传递
      } else {
        // 如果不存在记录，生成新的转生信息
        const race = getRandomElement(config.races);
        const job = getRandomElement(config.jobs);
        const rpgAttributes = generateRpgAttributes(race, job);
        const specialSkill = getRandomElement(config.specialSkills);
        const gender = getRandomElement(config.genders);
        const bodyType = getRandomElement(config.bodyTypes);
        const hairColor = getRandomElement(config.hairColors);
        const eyeColor = getRandomElement(config.eyeColors);

        const rpgAttributesString = `力量: ${rpgAttributes.strength}, 敏捷: ${rpgAttributes.agility}, 智力: ${rpgAttributes.intelligence}, 魅力: ${rpgAttributes.charisma}`;

        // 插入数据库
        db.run('INSERT INTO rebirth_info (user_id, race, job, rpg_attributes, special_skill, gender, body_type, hair_color, eye_color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [targetUserId, race, job, rpgAttributesString, specialSkill, gender, bodyType, hairColor, eyeColor],
          (err) => {
            if (err) {
              log("error", `插入数据库失败: ${err.message}`);
              return this.reply("插入数据库失败，请稍后再试", true, { at: true });
            }

            log("info", `用户 ${targetUserId} 生成了新的转生信息: 种族=${race}, 职业=${job}, RPG属性=${rpgAttributesString}, 特殊技能=${specialSkill}, 性别=${gender}, 体型=${bodyType}, 发色=${hairColor}, 瞳色=${eyeColor}`);
            const replyMessage = this.formatRebirthInfo({
              race, job, rpgAttributesString, specialSkill, gender, bodyType, hairColor, eyeColor
            });
            return this.reply(replyMessage, true, { at: targetUserId });
          });
      }
    });
  }

  // 新增函数：格式化转生信息
  formatRebirthInfo(info) {
    return `你的转生信息如下：
  种族: ${info.race}
  职业: ${info.job}
  RPG属性: ${info.rpg_attributes || info.rpgAttributesString}
  特殊技能: ${info.special_skill || info.specialSkill}
  性别: ${info.gender}
  体型: ${info.body_type || info.bodyType}
  发色: ${info.hair_color || info.hairColor}
  瞳色: ${info.eye_color || info.eyeColor}`;
  }

  // 新增函数：发送回复
  sendReply(message, targetUserId) {
    return this.reply(message, true, { at: targetUserId });
  }
}
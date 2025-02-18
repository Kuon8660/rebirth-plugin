import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { log } from "./log.js";
import { fileURLToPath } from 'url';
import { reRender } from './reRender.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = path.resolve(__dirname, '../data/rebirth.db');
const rebirthPath = path.resolve(__dirname, '../config/rebirth.json');
const configPath = path.resolve(__dirname, '../config/config.json');
const dbDir = path.dirname(dbPath);
const rebirth = JSON.parse(fs.readFileSync(rebirthPath, 'utf8'));
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

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
      user_id INTEGER PRIMARY KEY,
      race TEXT,
      job TEXT,
      rpg_attributes TEXT,
      special_skill TEXT,
      gender TEXT,
      body_type TEXT,
      hair_color TEXT,
      eye_color TEXT,
      created_at DATETIME DEFAULT (datetime('now','localtime'))
    )`, (err) => {
      if (err) {
        log("error", `创建表失败: ${err.message}`);
      } else {
        log("info", "表已创建");
      }
    });
  }
});

function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 根据种族和职业生成Rpg属性
function generateRpgAttributes(race, job) {
  const baseAttributes = {
    strength: Math.floor(Math.random() * 10) + 1,
    agility: Math.floor(Math.random() * 10) + 1,
    intelligence: Math.floor(Math.random() * 10) + 1,
    charisma: Math.floor(Math.random() * 10) + 1
  };

  // 根据种族和职业调整属性
  const raceModifiers = rebirth.raceModifiers[race] || {};
  const jobModifiers = rebirth.jobModifiers[job] || {};

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



async function getOrCreateRebirthInfo(uid, name) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT user_id AS uid, race, job, rpg_attributes, special_skill, gender, body_type, hair_color, eye_color 
            FROM rebirth_info WHERE user_id = ?`, [uid], (err, row) => {
      if (err) {
        log("error", `查询转生信息失败: ${err.message}`);
        reject(err);
        return;
      }

      if (row) {
        resolve({
          uid: row.uid,
          name: name,
          race: row.race,
          job: row.job,
          rpg_attributes: row.rpg_attributes,
          special_skill: row.special_skill,
          gender: row.gender,
          body_type: row.body_type,
          hair_color: row.hair_color,
          eye_color: row.eye_color
        });
        return;
      }

      const selectedRace = getRandomElement(rebirth.races);
      const selectedJob = getRandomElement(rebirth.jobs);

      const newData = {
        uid: uid,
        name: name,
        race: selectedRace,
        job: selectedJob,
        rpg_attributes: generateRpgAttributes(selectedRace, selectedJob), // 使用已定义的变量
        special_skill: getRandomElement(rebirth.specialSkills),
        gender: getRandomElement(rebirth.genders),
        body_type: getRandomElement(rebirth.bodyTypes),
        hair_color: getRandomElement(rebirth.hairColors),
        eye_color: getRandomElement(rebirth.eyeColors)
      };

      // 插入新记录
      db.run(`INSERT INTO rebirth_info 
             (user_id, race, job, rpg_attributes, special_skill, gender, body_type, hair_color, eye_color)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [uid, newData.race, newData.job, newData.rpg_attributes, newData.special_skill,
          newData.gender, newData.body_type, newData.hair_color, newData.eye_color],
        (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve(newData);
        });
    });
  });
}
// 新增函数：格式化转生信息
function formatRebirthInfo(data) {
  if (!data) {
    return "未找到转生信息";
  }

  const formattedInfo = `
    用户ID: ${data.uid}
    名称: ${data.name}
    种族: ${data.race}
    职业: ${data.job}
    RPG属性: ${data.rpg_attributes}
    特殊技能: ${data.special_skill}
    性别: ${data.gender}
    体型: ${data.body_type}
    发色: ${data.hair_color}
    眼色: ${data.eye_color}
  `;

  return formattedInfo;
}


export default class RebirthPlugintest extends plugin {
  constructor() {
    super({
      name: "异世界转生",
      dsc: "异世界转生插件",
      event: "message",
      priority: 5000,
      rule: [
        {
          reg: "^异世界转生test$",
          fnc: "rebirth",
          permission: "all",
        }
      ]
    });
  }

  async rebirth() {
    const targetUserId = this.e.at || this.e.user_id;

    log("info", `异世界转生用户为：${targetUserId}`);


    // 获取用户名称和群名称，以便处理群聊和私聊名称不一样
    const userName = await Bot.pickFriend(this.e.at || this.e.user_id).getInfo();
    const groupUserName = await this.e.group.pickMember(targetUserId).getInfo();
    // 获取或创建转生信息
    const data = await getOrCreateRebirthInfo(targetUserId, (groupUserName.card || userName.nickname));
    log("debug", `重生信息 ${getOrCreateRebirthInfo}`);
    if (config.useimage) {
      try {
        const image = await reRender(data); // 假设是异步操作
        this.reply(segment.image(image));
      } catch (e) {
        this.reply(`图片生成失败: ${e.message}`);
      }
    } else {
      this.reply(formatRebirthInfo(data));
    }
  }
}

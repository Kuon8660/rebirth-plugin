import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { log } from "./log.js";
import { fileURLToPath } from 'url';
import { reRender } from './reRender.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const dbPath = path.resolve(__dirname, '../data/rebirth.db');
const dbDir = path.dirname(dbPath);

const rebirthPath = path.resolve(__dirname, '../config/rebirth.json');
const rebirth = JSON.parse(fs.readFileSync(rebirthPath, 'utf8'));

const configPath = path.resolve(__dirname, '../config/config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

// 检查数据库文件是否存在，并创建文件夹
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
      createdTime DATETIME DEFAULT (datetime('now','localtime'))
    )`, (err) => {
      if (err) {
        log("error", `创建表失败: ${err.message}`);
      } else {
        log("info", "表已创建");
      }
    });
  }
});

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

//声明异世界转生数据
const data = { title: '异世界转生', content: '测试内容' }

// 异世界转生插件配置
export default class RebirthPlugin extends plugin {
  constructor() {
    super({
      name: "异世界转生",
      dsc: "异世界转生插件",
      event: "message",
      priority: 5000,
      rule: [
        {
          //异世界转生触发关键词
          reg: "^异世界转生$",
          fnc: "rebirth",
          permission: "all",
        }
      ]
    });
  }
  async rebirth() {

    // 如果at用户ID，则使用at用户作为目标用户ID，否则使用当前用户ID
    const targetUserId = this.e.at || this.e.user_id;
    log("info", `异世界转生开始处理，用户为：${targetUserId}`);

    // 获取用户名称和群名称，以便处理群聊和私聊名称不一样
    const userName = await Bot.pickFriend(this.e.at || this.e.user_id).getInfo();
    const groupUserName = await this.e.group.pickMember(targetUserId).getInfo();
    data.userName = groupUserName.card || userName.nickname;
    log("info", `异世界转生用户名为：${data.userName}`);
    data.avatarUrl = await Bot.pickFriend(targetUserId).getAvatarUrl();
    log("debug", `异世界转生用户头像为：${data.avatarUrl}`);
    await getRebirthInfo(targetUserId);
    //如果设置为true，则使用图片生成，否则使用文本生成
    if (config.useimage == "true") {
      try {
        const image = await reRender(data);
        this.reply(segment.image(image));
      } catch (e) {
        this.reply(`图片生成失败: ${e.message}`);
      }
    } else {
      this.reply(this.formatRebirthInfo(data), true, { at: targetUserId });
    }
  }
  // 新增函数：格式化转生信息
  formatRebirthInfo(info) {
    return `你的转生信息如下：
  种族: ${data.race}  职业: ${info.job}
  性别: ${info.gender}  体型: ${info.bodyType}
  属性: 力量: ${info.strength} 敏捷: ${info.agility} 智力: ${info.intelligence} 魅力: ${info.charisma}
  幸运值: ${info.luckValue}
  特殊技能: ${info.specialSkill}
  发色: ${info.hairColor}
  瞳色: ${info.eyeColor}`;
  }
}


// 随机选择一个数组中的元素
function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
// 获取异世界转生信息
async function getRebirthInfo(targetUserId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM rebirth_info WHERE user_id = ?', [targetUserId], (err, row) => {
      if (err) {
        log("error", `查询数据库失败: ${err.message}`);
        // 这里应该返回reject而不是this.reply
        return reject("查询数据库失败，请稍后再试");
      }

      if (row) {
        // 如果存在记录，返回记录信息
        log("info", `用户 ${targetUserId} 已有转生信息`);
        data.user_id = targetUserId;
        data.race = row.race;
        data.job = row.job;
        data.gender = row.gender;
        data.bodyType = row.bodyType;
        data.hairColor = row.hairColor;
        data.eyeColor = row.eyeColor;
        data.strength = row.strength;
        data.agility = row.agility;
        data.intelligence = row.intelligence;
        data.luckValue = row.luckValue;
        data.charisma = row.charisma;
        data.specialSkill = row.specialSkill;
        resolve(data);
      } else {
        data.user_id = targetUserId;
        // 如果不存在记录，生成新的转生信息
        data.race = getRandomElement(rebirth.races);
        data.job = getRandomElement(rebirth.jobs);
        data.gender = getRandomElement(rebirth.genders);
        data.bodyType = getRandomElement(rebirth.bodyTypes);
        data.hairColor = getRandomElement(rebirth.hairColors);
        data.eyeColor = getRandomElement(rebirth.eyeColors);
        data.specialSkill = getRandomElement(rebirth.specialSkills);
        data.luckValue = Math.floor(Math.random() * 100) + 1;

        // 根据种族和职业调整属性
        const raceModifiers = rebirth.raceModifiers[data.race] || {};
        const jobModifiers = rebirth.jobModifiers[data.job] || {};
        data.strength = Math.floor(Math.random() * 10) + 1 + (raceModifiers.strength || 0) + (jobModifiers.strength || 0);
        data.agility = Math.floor(Math.random() * 10) + 1 + (raceModifiers.agility || 0) + (jobModifiers.agility || 0);
        data.intelligence = Math.floor(Math.random() * 10) + 1 + (raceModifiers.intelligence || 0) + (jobModifiers.intelligence || 0);
        data.charisma = Math.floor(Math.random() * 10) + 1 + (raceModifiers.charisma || 0) + (jobModifiers.charisma || 0);

        // 插入数据库
        db.run('INSERT INTO rebirth_info (user_id, race, job, strength, agility, intelligence, charisma, specialSkill, gender, bodyType, hairColor, eyeColor,luckValue) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [targetUserId, data.race, data.job, data.strength, data.agility, data.intelligence, data.charisma, data.specialSkill, data.gender, data.bodyType, data.hairColor, data.eyeColor, data.luckValue],
          (err) => {
            if (err) {
              log("error", `插入数据库失败: ${err.message}`);
              return reject("插入数据库失败，请稍后再试");
            }

            log("info", `用户 ${targetUserId} 生成了新的转生信息: 种族=${data.race}, 职业=${data.job}, RPG属性=${data.strength},${data.agility},${data.intelligence},${data.charisma}, 特殊技能=${data.specialSkill}, 性别=${data.gender}, 体型=${data.bodyType}, 发色=${data.hairColor}, 瞳色=${data.eyeColor}, 幸运值=${data.luckValue}`);
            resolve(data);
          });
      }
    });
  });
}
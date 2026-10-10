import fs from 'fs';
import path from 'path';
import { log } from "./log.js";
import { loadConfig } from './config.js';
import { reRender } from './reRender.js';
import { getOrCreateRebirthInfo } from './rebirthCore.js';
import { afterRebirth } from './rpgHook.js';
import { collectAndReport } from './rebirthCollection.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 用 config.js 统一 ensure+读取 config.json（缺失自动从 config.default.json 生成）
const config = loadConfig('config.json');

// 异世界转生插件配置（普通转生卡）
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
    const targetUserId = this.e.at || this.e.user_id;
    log("info", `异世界转生开始处理，用户为：${targetUserId}`);

    // 生成或复用该用户当日转生信息（rebirthCore 统一管理数据库）
    const base = await getOrCreateRebirthInfo(targetUserId);
    log("info", `异世界转生用户名为：${targetUserId}`);

    // 收集图鉴：登记本次种族/职业，并拿到给用户看的收集进度文本（失败不阻断转生）
    const collectText = await collectAndReport(targetUserId, base, base.isNew);

    // RPG 签到 + 把属性点加成叠加到四维（失败不阻断）；level/exp/expNext 为 RPG 等级与经验进度
    const { info, notice, level, exp, expNext, expPct, maxed } = await afterRebirth(targetUserId, base);

    // 组装渲染/文本数据
    const renderData = {
      user_id: targetUserId,
      title: '异世界转生',
      content: '测试内容',
      level,
      exp,
      expNext,
      expPct,
      maxed,
      race: info.race,
      job: info.job,
      gender: info.gender,
      bodyType: info.bodyType,
      hairColor: info.hairColor,
      eyeColor: info.eyeColor,
      strength: info.strength,
      agility: info.agility,
      intelligence: info.intelligence,
      charisma: info.charisma,
      luckValue: info.luckValue,
      specialSkill: info.specialSkill,
      aiImageDataUri: '',
    };

    // 若开启图片渲染，补充昵称与头像后再渲染
    if (config.useimage == "true") {
      try {
        // 群聊取群名片，私聊取好友昵称
        // 注：不同适配器 getInfo/getAvatarUrl 可能是同步返回字符串或返回 Promise，
        // 用 Promise.resolve() 统一包裹后再 catch，避免 “xxx.catch is not a function”
        const userInfo = await Promise.resolve(Bot.pickFriend(targetUserId).getInfo?.() ?? {}).catch(() => null);
        let nick = (userInfo && (userInfo.nickname || userInfo.card)) || String(targetUserId);
        if (this.e.group?.pickMember) {
          const gm = await Promise.resolve(this.e.group.pickMember(targetUserId).getInfo?.() ?? null).catch(() => null);
          if (gm && (gm.card || gm.nickname)) nick = gm.card || gm.nickname;
        }
        renderData.userName = nick;
        renderData.avatarUrl = await Promise.resolve(Bot.pickFriend(targetUserId).getAvatarUrl?.() ?? '').catch(() => '');
        // 默认「异世界转生」用经典无 AI 卡模板（不透明卡、无等级/经验条）
        const image = await reRender(renderData, './plugins/rebirth-plugin/resources/rebirth/index_noai.html');
        this.reply(segment.image(image));
      } catch (e) {
        this.reply(`图片生成失败: ${e.message}`);
      }
    } else {
      this.reply(this.formatRebirthInfo(renderData), true, { at: targetUserId });
    }

    // 追加「收集进度」与 RPG 签到/升级提示（合并为一条，避免刷屏）
    const extra = [collectText, (notice || '').replace(/^\n+/, '')].filter(Boolean).join('\n');
    if (extra) this.reply(extra, false, { at: targetUserId });
  }

  formatRebirthInfo(info) {
    return `你的转生信息如下：
  种族: ${info.race}  职业: ${info.job}
  性别: ${info.gender}  体型: ${info.bodyType}
  属性: 力量: ${info.strength} 敏捷: ${info.agility} 智力: ${info.intelligence} 魅力: ${info.charisma}
  幸运值: ${info.luckValue}
  特殊技能: ${info.specialSkill}
  发色: ${info.hairColor}
  瞳色: ${info.eyeColor}`;
  }
}

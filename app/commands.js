import { log, loadConfig, fetchUserProfile, fileToDataUri } from './core/infra.js';
import { getOrCreateRebirthInfo, allocatePoint, formatPanel } from './core/data.js';
import { reRender, aiConfig } from './core/image.js';
import { afterRebirth, collectAndReport, ensureAiImage, buildRenderData } from './core/flow.js';

/**
 * 接口层（commands）：三个对外命令
 * ------------------------------------------------------------
 *   · RebirthPlugin  `异世界转生`         → 经典卡（index_noai.html）
 *   · AiDrawPlugin   `#?ai异世界转生`     → AI 立绘整卡（index.html）
 *   · RebirthRpgCmd  `#异世界加点` / `#异世界等级·面板·属性`
 *
 * 本层只做「解析输入 → 调编排/数据 → 回复」；逻辑落在 core/。
 * 三个命令类由原 app/rebirth.js + app/aiDraw.js + app/rebirthRpgCmd.js 合并而来。
 */

// 普通转生卡开关配置（缺失自动从 config.default.json 生成）
const config = loadConfig('config.json');

// ============================================================
// 命令一：异世界转生（经典卡）
// ============================================================
export class RebirthPlugin extends plugin {
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

    // 生成或复用该用户当日转生信息（core/data.js 统一管理 rebirth.db）
    const base = await getOrCreateRebirthInfo(targetUserId);
    log("info", `异世界转生用户名为：${targetUserId}`);

    // 收集图鉴：登记本次种族/职业，并拿到给用户看的收集进度文本（失败不阻断转生）
    const collectText = await collectAndReport(targetUserId, base, base.isNew);

    // RPG 签到 + 把属性点加成叠加到四维（失败不阻断）；level/exp/expNext 为 RPG 等级与经验进度
    const { info, notice, level, exp, expNext, expPct, maxed } = await afterRebirth(targetUserId, base);

    // 组装渲染/文本数据（字段集与 AI 版一致，见 core/flow.buildRenderData）
    const renderData = buildRenderData({
      user_id: targetUserId,
      info,
      level,
      exp,
      expNext,
      expPct,
      maxed,
      aiImageDataUri: '',
    });

    // 若开启图片渲染，补充昵称与头像后再渲染
    if (config.useimage == "true") {
      try {
        // 群聊取群名片，私聊取好友昵称（跨适配器的同步/异步返回已由 infra 统一处理）
        const { nick, avatarUrl } = await fetchUserProfile(this.e, targetUserId);
        renderData.userName = nick;
        renderData.avatarUrl = avatarUrl;
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

// ============================================================
// 命令二：AI 立绘整卡
// ============================================================
export class AiDrawPlugin extends plugin {
  constructor() {
    super({
      name: '异世界转生·AI立绘',
      dsc: 'ai异世界转生 / #ai异世界转生：生成转生信息并调用 AI 绘图渲染整卡',
      event: 'message',
      priority: 4999,
      rule: [
        {
          // 不区分大小写，且 # 可选：ai异世界转生 / #ai异世界转生 / AI异世界转生 / #AI异世界转生 均可
          reg: /^#?ai异世界转生$/i,
          fnc: 'aiRebirth',
          permission: 'all',
        },
      ],
    });
  }

  async aiRebirth() {
    // 1. 先判断是否启用 AI 绘图
    if (!aiConfig.enable) {
      this.reply('AI 绘图功能未启用。请先在 config/ai.json 中把 enable 设为 true，并配置即梦 base_url 与 sessionid。');
      return;
    }

    const targetUserId = this.e.at || this.e.user_id;
    // 状态提示：20s 后自动撤回，避免刷屏
    this.reply('正在为你转生并绘制角色，请稍候…', false, { recallMsg: 20 });

    // 2. 生成/复用当日转生信息
    let baseInfo;
    try {
      baseInfo = await getOrCreateRebirthInfo(targetUserId);
    } catch (err) {
      log('error', `异世界转生信息生成失败: ${err}`);
      this.reply(`生成失败：${err.message}`);
      return;
    }

    // 3. 先做 RPG 签到/加成（与生图解耦）：即便 AI 绘图失败，签到与升级提示也不受影响
    let rpg = null;
    try {
      rpg = await afterRebirth(targetUserId, baseInfo);
    } catch (err) {
      log('warn', `RPG 签到/加成失败(不阻断转生): ${err.message}`);
    }
    // 收集图鉴：登记本次种族/职业并生成进度文本（失败不阻断）
    const collectText = await collectAndReport(targetUserId, baseInfo, baseInfo.isNew);
    const notice = (rpg && rpg.notice) || '';
    const level = (rpg && rpg.level) ?? 0;
    const exp = (rpg && rpg.exp) ?? 0;
    const expNext = (rpg && rpg.expNext) ?? 0;
    const expPct = (rpg && rpg.expPct) ?? 0;
    const maxed = !!(rpg && rpg.maxed);
    // 展示信息优先用叠加 RPG 加成后的副本；签到异常时退回原始转生信息
    const info = (rpg && rpg.info) || baseInfo;

    // 4. 读取昵称/头像（群聊取群名片，私聊取好友昵称；取不到则用 uid 兜底）
    const { nick, avatarUrl } = await fetchUserProfile(this.e, targetUserId);

    // 5. 尝试生成 AI 立绘（失败不抛错，降级为经典卡展示，签到已在上一步完成）
    let aiImageRel = null;
    let cached = false;
    let aiFailMsg = null;
    try {
      const r = await ensureAiImage(targetUserId);
      aiImageRel = r.aiImageRel;
      cached = r.cached;
    } catch (err) {
      aiFailMsg = err.message || '未知错误';
      log('warn', `AI 立绘生成失败(已降级): ${aiFailMsg}`);
    }

    // 6. 组装渲染数据（生图成功 → AI 立绘铺底；失败 → 空，用经典模板展示）
    const renderData = buildRenderData({
      user_id: targetUserId,
      info,
      nick,
      avatarUrl,
      level,
      exp,
      expNext,
      expPct,
      maxed,
      aiImageDataUri: aiImageRel ? fileToDataUri(aiImageRel) : '',
    });

    // 7. 渲染整卡：AI 成功用 AI 版模板，失败降级用经典无 AI 模板
    const tpl = aiImageRel
      ? './plugins/rebirth-plugin/resources/rebirth/index.html'
      : './plugins/rebirth-plugin/resources/rebirth/index_noai.html';

    // 8. 单条回复：@用户 + 图片 + 签到/升级提示，不再分多条（群聊加 @，私聊不加）
    const segs = [];
    if (this.e.isGroup) segs.push(segment.at(targetUserId));
    let imgReady = false;
    try {
      const image = await reRender(renderData, tpl);
      segs.push(segment.image(image));
      imgReady = true;
    } catch (err) {
      log('error', `转生卡渲染失败: ${err}`);
      imgReady = false;
    }

    // 文字提示：缓存 / 签到升级 / AI 失败说明（图片失败但签到成功时也能看到升级提示）
    const textParts = [];
    if (cached && imgReady) textParts.push('（今日 AI 立绘已生成，展示缓存）');
    if (collectText) textParts.push(collectText);
    if (notice) textParts.push(notice.replace(/^\n+/, '').replace(/\s+$/, ''));
    if (aiFailMsg && !cached) textParts.push(`AI 立绘生成失败：${aiFailMsg}（转生信息与签到已正常完成）`);
    if (textParts.length) segs.push('\n' + textParts.filter(Boolean).join('\n'));

    // 兜底：若图片与文字均未能发出，至少给一句状态，避免“空回复”
    if (segs.length === 0) segs.push('异世界转生信息已为你生成。');
    this.reply(segs, false);
  }
}

// ============================================================
// 命令三：异世界等级（RPG）
// ============================================================
const ATTR_NAME_MAP = { 力量: 'strength', 敏捷: 'agility', 智力: 'intelligence', 魅力: 'charisma' };

export class RebirthRpgCmd extends plugin {
  constructor() {
    super({
      name: '异世界等级',
      dsc: '异世界类RPG系统：等级/经验/属性点',
      event: 'message',
      priority: 4998,
      rule: [
        {
          reg: '^#异世界加点\\s+([力量敏捷智力魅力]+)\\s*(-?\\d+)',
          fnc: 'allocate',
          permission: 'all',
        },
        {
          reg: '^(#异世界等级|#异世界面板|#异世界属性)$',
          fnc: 'panel',
          permission: 'all',
        },
      ],
    });
  }

  /** #异世界加点 力量 3 */
  async allocate() {
    const m = this.e.msg.match(/^#异世界加点\s+([力量敏捷智力魅力]+)\s*(-?\d+)/);
    if (!m) {
      this.reply('用法：`#异世界加点 力量 2`（属性：力量/敏捷/智力/魅力）');
      return;
    }
    const attrKey = ATTR_NAME_MAP[m[1]];
    const amount = parseInt(m[2], 10);
    const uid = this.e.at || this.e.user_id;
    try {
      const player = await allocatePoint(uid, attrKey, amount);
      this.reply(
        `加点成功！力量 +${player.bonus_strength} | 敏捷 +${player.bonus_agility} | 智力 +${player.bonus_intelligence} | 魅力 +${player.bonus_charisma}\n剩余属性点：${player.points}`,
        true,
        { at: uid },
      );
    } catch (err) {
      this.reply(`加点失败：${err.message}`);
    }
  }

  /** #异世界等级 */
  async panel() {
    const uid = this.e.at || this.e.user_id;
    try {
      const panel = await formatPanel(uid);
      this.reply(panel, true, { at: uid });
    } catch (err) {
      this.reply(`查询失败：${err.message}`);
    }
  }
}

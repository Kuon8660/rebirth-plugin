import { allocatePoint, formatPanel } from './rebirthRpg.js';

export default class RebirthRpgCmd extends plugin {
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
    const nameMap = { 力量: 'strength', 敏捷: 'agility', 智力: 'intelligence', 魅力: 'charisma' };
    const attrKey = nameMap[m[1]];
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

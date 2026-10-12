import { log, ensureAllConfigs } from "./core/infra.js";
import { initRebirthData } from "./core/data.js";
import { RebirthPlugin, AiDrawPlugin, RebirthRpgCmd } from "./commands.js";

/**
 * 入口（index）
 * ------------------------------------------------------------
 * 启动自检 + 导出插件命令类。启动顺序：
 *   1. ensureAllConfigs()  运行时配置缺失则从 *.default.json 生成
 *   2. initRebirthData()   扫描 config/races · config/jobs（报告相对上次的增删）
 *   （两个 SQLite 库的连接与建表在 core/data.js 模块加载时完成）
 */

// 启动即检测：运行时配置文件缺失则从 *.default.json 自动生成
ensureAllConfigs();

// 启动即扫描种族/职业配置目录（config/races、config/jobs），并报告相对上次的增加/减少
initRebirthData();

export { RebirthPlugin, AiDrawPlugin, RebirthRpgCmd }; // 导出插件
// 日志记录
log("info", "------rebirth-plugin------");
log("info", "rebirth-plugin 插件加载成功");
log("info", "------rebirth-plugin------");

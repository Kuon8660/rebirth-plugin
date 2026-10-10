import { log } from "./log.js";
import { ensureAllConfigs } from "./config.js";
import { initRebirthData } from "./rebirthData.js";
import RebirthPlugin from "./rebirth.js";
import AiDrawPlugin from "./aiDraw.js";
import RebirthRpgCmd from "./rebirthRpgCmd.js";

// 启动即检测：运行时配置文件缺失则从 *.default.json 自动生成
ensureAllConfigs();

// 启动即扫描种族/职业配置目录（config/races、config/jobs），并报告相对上次的增加/减少
initRebirthData();

export { RebirthPlugin, AiDrawPlugin, RebirthRpgCmd }; // 导出插件
// 日志记录
log("info", "------rebirth-plugin------");
log("info", "rebirth-plugin 插件加载成功");
log("info", "------rebirth-plugin------");

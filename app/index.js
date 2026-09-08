import { log } from "./log.js";
import { ensureAllConfigs } from "./config.js";
import RebirthPlugin from "./rebirth.js";
import AiDrawPlugin from "./aiDraw.js";
import RebirthRpgCmd from "./rebirthRpgCmd.js";

// 启动即检测：运行时配置文件缺失则从 *.default.json 自动生成
ensureAllConfigs();

export { RebirthPlugin, AiDrawPlugin, RebirthRpgCmd }; // 导出插件
// 日志记录
log("info", "------rebirth-plugin------");
log("info", "rebirth-plugin 插件加载成功");
log("info", "------rebirth-plugin------");

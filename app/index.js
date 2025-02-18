import { log } from "./log.js";
import apptest from "./apptest.js";
import RebirthPlugin from "./rebirth.js"; // 引入新的插件
import RebirthPlugintest from "./rebirth copy.js";

export { apptest, RebirthPlugin,RebirthPlugintest}; // 导出新的插件
// 日志记录
log("info", "------rebirth-plugin------");
log("info", "rebirth-plugin 插件加载成功");
log("info", "------rebirth-plugin------");
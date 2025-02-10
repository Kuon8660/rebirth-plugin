import util from "../../../lib/util.js";

/**
 * 包装 util.makeLog 的 log 函数
 * @param {string} level - 日志级别/trace/debug/info/warn/error/fatal/mark
 * @param {string|array} msg - 日志消息
 * @param {string} id - 日志ID
 * @param {boolean} force - 是否强制使用提供的ID
 */
function log(level, msg, id, force) {
  util.makeLog(level, "[rebirth-plugin]"+msg, id, force);
}

export { log };
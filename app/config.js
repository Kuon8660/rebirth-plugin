import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './log.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 运行时配置文件目录（相对本模块：../config）
const configDir = path.resolve(__dirname, '../config');

// 需要自动检测并生成默认配置的运行时配置文件。
// 每个 name 对应仓库内跟踪的默认模板 name 去掉 .json 加 .default.json。
//   例：ai.json        <- 默认模板 ai.default.json（sessionid 为空，防泄露）
//       rpg.json       <- rpg.default.json
//       config.json    <- config.default.json
//       rebirth.json   <- rebirth.default.json
const RUNTIME_CONFIGS = ['config.json', 'rebirth.json', 'rpg.json', 'ai.json'];

// 运行时配置名 -> 默认模板名（ai.default.json 等）
function defaultFor(name) {
  return name.replace(/\.json$/, '.default.json');
}

/**
 * 确保单个运行时配置存在：缺失则从仓库内默认模板复制生成。
 * 幂等：文件已存在则直接返回，绝不覆盖用户已有配置（避免冲掉已填的 sessionid）。
 * @param {string} name 配置文件名，如 'ai.json'
 * @returns {string} 配置文件绝对路径
 */
function ensureConfig(name) {
  const live = path.join(configDir, name);
  if (fs.existsSync(live)) return live;

  // 首次运行/克隆后缺配置：从默认模板生成
  try {
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
    const def = path.join(configDir, defaultFor(name));
    if (fs.existsSync(def)) {
      fs.copyFileSync(def, live);
      log('warn', `检测到配置文件缺失，已从默认模板生成: config/${name}`);
      if (name === 'ai.json') {
        log('warn', 'config/ai.json 已自动生成，请填写 jimeng.sessionid 后即可启用 AI 异世界立绘');
      }
    } else {
      fs.writeFileSync(live, '{}\n', 'utf8');
      log('warn', `配置文件缺失且无默认模板，已生成空配置: config/${name}`);
    }
  } catch (err) {
    log('error', `自动生成配置文件失败 config/${name}: ${err.message}`);
  }
  return live;
}

/**
 * 启动时调用一次：确保所有运行时配置都已生成（缺则补）。
 * 各消费模块 loadConfig 内部也会各自 ensure，此处集中补一轮便于统一日志。
 */
function ensureAllConfigs() {
  for (const name of RUNTIME_CONFIGS) ensureConfig(name);
}

/**
 * 统一读取运行时 JSON 配置：先 ensure 再读，读不到则返回 fallback（不抛错）。
 * @param {string} name 配置文件名，如 'config.json'
 * @param {object} [fallback] 读取失败时的兜底对象
 * @returns {object} 解析后的配置对象
 */
function loadConfig(name, fallback = {}) {
  ensureConfig(name);
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8'));
  } catch (err) {
    log('error', `读取配置 config/${name} 失败: ${err.message}`);
    return fallback;
  }
}

export { ensureAllConfigs, ensureConfig, loadConfig, RUNTIME_CONFIGS, configDir };

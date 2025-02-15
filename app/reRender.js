import Renderer from "../../lib/renderer/Renderer.js";
import { log } from "./log.js";
import segment from "oicq"; // 假设 oicq 模块已经导入

export default class ReRender extends Renderer {
  constructor() {
    super({
      id: "reRender",
      type: "image",
      render: "render",
    });
  }

  async render(data) {
    try {
      const { avatarUrl, race, job, gender, bodyType, rpgAttributes, specialSkill, hairColor, eyeColor } = data;
      const htmlPath = await this.dealTpl("reRender", {
        tplFile: "../../resources/index.html",
        avatarUrl,
        race,
        job,
        gender,
        bodyType,
        rpgAttributes,
        specialSkill,
        hairColor,
        eyeColor,
      });

      if (!htmlPath) {
        log("error", "生成HTML失败");
        return false;
      }

      const imgPath = await this.screenshot("reRender", { htmlPath });
      if (!imgPath) {
        log("error", "生成图片失败");
        return false;
      }

      return segment.image(imgPath); // 返回图片对象
    } catch (err) {
      log("error", `渲染失败: ${err.message}`);
      return false;
    }
  }
}
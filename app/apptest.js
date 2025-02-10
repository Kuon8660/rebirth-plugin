import { log } from "./log.js";

export default class apptest extends plugin {
  constructor() {
      super({
        name: "app测试",
        dsc: "开发测试用",
        /** https://oicqjs.github.io/oicq/#events */
        event: "message",
        priority: 50,
        rule: [
          {
            /** 命令正则匹配 */
            reg:"^#app测试",
            fnc: "appTest",
            permission: "all",
          }
        ]
      })
  }

  async appTest() {
    log("info", "app测试")
    this.reply("app测试")
    this.reply("app测试",true)
    this.reply("app测试",true,{at:true})
    this.reply("app测试",true,{recallMsg:120},true)
    return true
  }
}
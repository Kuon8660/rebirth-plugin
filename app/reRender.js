import Renderer from '../../../lib/renderer/Renderer.js';
import { log } from './log.js';
import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';

// 实例化渲染器
const rbrenderer = new Renderer({
  id: 'rebirth-plugin',    // 渲染器唯一标识
  type: 'image'         // 渲染器类型
});

// 使用 puppeteer 渲染 HTML 为图片
const renderHtmlToImage = async (htmlPath, outputPath) => {
  const browser = await puppeteer.launch();
  log('debug', `浏览器已启动，开始渲染HTML文件：${htmlPath}`);
  
  const page = await browser.newPage();
  log('debug', `新页面已创建，正在加载HTML文件：${htmlPath}`);
  
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
  log('debug', `HTML文件加载完成，开始截图：${outputPath}`);

  // 确保目标目录存在
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    log('debug', `目录已创建：${dir}`);
  }
  
  await page.screenshot({ path: outputPath, fullPage: true });
  log('debug', `截图完成，保存路径：${outputPath}`);
  
  await browser.close();
  log('debug', '浏览器已关闭');
};

// 导出可调用的 reRender 函数
export const reRender = async (data) => {
  try {
    // 调用模板处理方法
    const htmlPath = path.resolve(rbrenderer.dealTpl('rebirth-plugin', {
      tplFile: './plugins/rebirth-plugin/resources/rebirth/index.html', // 模板文件路径
      ...data // 传入的模板变量
    }));

    // 生成图片路径
    const now = new Date();
    const dateString = `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')}`;
    const outputPath = `./plugins/rebirth-plugin/tmp/rebirth/${dateString}.png`;

    // 渲染 HTML 为图片
    await renderHtmlToImage(htmlPath, outputPath);
    log('info', `图片保存在 ${outputPath}`);

    // 返回生成的图片路径
    return outputPath;
  } catch (err) {
    log('error', `图片渲染失败： ${err}`);
    throw err;
  }
};


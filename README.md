# 手机可用的图片翻译网页（Gemini 免费层）

## 你现在能直接用的方案
- 前端：手机浏览器访问网页
- 后端：Node 服务（可本地，也可部署到 Render）
- 模型：Gemini API（Free Tier）

## 1. 本地启动（快速验证）
在 `F:\TranslatingEnglish` 打开 PowerShell：

```powershell
cd F:\TranslatingEnglish
$env:GEMINI_API_KEY="你的GeminiKey"
# 可选，不填默认 gemini-2.5-flash
$env:GEMINI_MODEL="gemini-2.5-flash"
node server.js
```

访问：
- 电脑：`http://127.0.0.1:3000`
- 手机（同 Wi-Fi）：`http://你的电脑局域网IP:3000`

## 2. 部署到 Render（手机长期可用）
1. 把项目推到 GitHub 仓库
2. Render 新建 `Blueprint`，连接该仓库
3. 在环境变量里添加：
- `GEMINI_API_KEY=你的GeminiKey`
- `GEMINI_MODEL=gemini-2.5-flash`（可选）
4. 部署成功后，用 Render 给的 `https://xxx.onrender.com` 在手机直接访问

## 3. 功能说明
- 第 1 页支持：相册上传/拍照 -> 识别外文 -> 翻译中文 -> 在原图对应位置替换中文 -> 下载结果图
- 同时输出内容总结和用户下一步动作建议
- 前端会自动压缩图片，提升手机上传稳定性

## 4. 注意
- 免费层有速率/配额限制，超限后会报接口错误
- 文字覆盖位置由识别框决定，复杂版式下仍可能有轻微偏差

# Finger Pinch Symphony — 双指捏合音游

基于 **MediaPipe 双手手势识别** 的节奏音乐游戏。通过 **不同手指与拇指对捏** 来触发不同音阶，配合下落的音符节奏完成演奏。

## 本地运行

```bash
python serve.py
# 浏览器打开 http://127.0.0.1:8765
```

`serve.py` 会自动设置 COEP/COOP 头并代理 MediaPipe 模型文件。

## Web 部署

游戏需要 **SharedArrayBuffer**（MediaPipe WASM 依赖），因此托管平台必须设置以下 HTTP 响应头：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

### Cloudflare Pages

直接上传整个目录，项目已包含 `_headers` 文件，Cloudflare 会自动读取。

### Vercel

```bash
vercel --prod
```

项目已包含 `vercel.json`，自动配置 COEP/COOP 头。

### 其他静态托管

确保平台支持自定义 HTTP 头。微信内置浏览器可通过扫码直接打开部署后的 URL。

## 技术栈

- MediaPipe Hand Landmarker (tasks-vision)
- Web Audio API
- 原生 Canvas 渲染
- 纯前端，零构建依赖

## 许可

MIT
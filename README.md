# Anime Denoise Web

[打开网页版](https://hhxki.github.io/anime-denoise-web/)

在浏览器里用 WebGPU 为动漫图片去噪。图片在设备上处理，支持原图对比、局部保护和 PNG 导出。请使用支持 WebGPU 的浏览器。单张源文件上限为 10 MiB，图片最多 1677 万像素。

普通去噪首次加载约 18 MB 的超分模型。AI 人物选择默认关闭。勾选并点击识别后，浏览器才从 [SkyTNT 的 Hugging Face 仓库](https://huggingface.co/skytnt/anime-seg/blob/a0a563c41338cbe0d23dfb4bfc3e243c518e5768/isnetis.onnx) 下载约 176 MB 的官方 ONNX 模型。该功能为实验功能，适用于动漫人物。

## 本地运行

从 [models-v1](https://github.com/hhxki/anime-denoise-web/releases/tag/models-v1) 下载 `esrgan.onnx` 到 `public/models/`，然后运行：

```sh
npm ci
npm run dev
npm test
```

GitHub Actions 从 Release 获取并校验模型，构建项目后发布到 GitHub Pages。也可以运行 `npm run build`，将 `dist/` 部署到自己的 HTTPS 静态站点。

## 来源

移植自 [CXP-2024/gpt-anime-denoise](https://github.com/CXP-2024/gpt-anime-denoise)，保留上游 MIT 许可与版权声明。模型来自 [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) 和 [SkyTNT anime-seg](https://huggingface.co/skytnt/anime-seg)，模型许可证随 `public/models/` 提供。

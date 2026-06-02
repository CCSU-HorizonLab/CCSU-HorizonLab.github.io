# CCSU-Horizon-Lab.github.io

长大 Horizon 全栈实验室的 GitHub Pages 主页。

## 本地预览

```bash
bundle install
bundle exec jekyll serve
```

打开 `http://127.0.0.1:4000` 查看页面。

## 发布

1. 在 GitHub 新建仓库 `CCSU-Horizon-Lab.github.io`。
2. 把本目录内容推送到仓库 `main` 分支。
3. 进入仓库 Settings -> Pages，选择 `Deploy from a branch`，分支选择 `main`，目录选择 `/root`。
4. 等待 Actions/Pages 构建完成后访问 `https://CCSU-Horizon-Lab.github.io`。

## GitHub 数据缓存

成员和项目数据不直接依赖浏览器实时请求 GitHub API。仓库内的 GitHub Actions 会每天运行一次：

```bash
node scripts/update-github-cache.mjs
```

脚本会把公开仓库和 contributors 汇总写入 `assets/data/github.json`。页面优先读取这份本地缓存；缓存缺失时才回退到实时 API，避免访客刷新页面触发 GitHub 匿名限流。

也可以在 Actions 页面手动运行 `Update GitHub Cache`，立即刷新缓存。

# GitHub Pages 部署

本仓库是静态网站，不需要安装依赖或执行构建命令。

## 当前配置

- 仓库：<https://github.com/Anthony6560/layers-of-life>
- 发布分支：`main`
- 发布目录：`/ (root)`
- 自定义域名：`5644100.xyz`

在 GitHub 仓库的 **Settings → Pages → Build and deployment** 中，选择 **Deploy from a branch**，使用上述分支和目录。提交并推送后，GitHub Pages 自动更新；可以在 **Actions** 中查看部署结果。

根目录的 `CNAME` 保存自定义域名，`.nojekyll` 用于让 Pages 直接发布静态文件。保留这两个文件。

目前域名通过 HTTP 可正常访问；HTTPS 证书尚未匹配此域名，README 暂使用 HTTP 链接。证书配置完成后，将在线访问链接改为 HTTPS。

## 域名 DNS

裸域 `5644100.xyz` 的 `@` 添加以下四条 A 记录：

| 类型 | 主机记录 | 值 |
| --- | --- | --- |
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |

如果需要 `www.5644100.xyz`，另外添加 `www` 的 CNAME 记录，指向 `Anthony6560.github.io`。裸域仍由上述 A 记录配置。

DNS 生效后，在 **Settings → Pages** 确认域名检查通过。等待 GitHub 签发证书后，启用 **Enforce HTTPS**。如果按钮不可用，检查冲突的 A、AAAA 或 CNAME 记录，以及 DNS 是否已传播。

参考：[GitHub Pages 自定义域名](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)、[HTTPS 配置](https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https)。

## 更新检查

1. 更新页面、数据或媒体；资源移动时同时更新引用路径。
2. 使用本地 HTTP 服务检查相关页面，确认图片、音视频及模型可以加载。
3. 将修改提交并推送到 `main`，等待 Pages 部署成功。
4. 打开线上页面检查更新；必要时强制刷新，排除浏览器缓存影响。

媒体与模型使用相对于站点根目录的路径。文件名大小写必须与引用一致，不能使用本机磁盘路径。

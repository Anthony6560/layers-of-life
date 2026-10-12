# 5644100.xyz

这是「坐标之外」个人网站的 GitHub Pages 发布目录。

## 发布

1. 新建一个 GitHub 仓库，把本目录中的全部内容上传到仓库根目录。
2. 在仓库的 **Settings → Pages** 中选择 **Deploy from a branch**。
3. 选择发布分支的根目录 `/ (root)`。
4. GitHub Pages 会读取根目录中的 `CNAME`，绑定 `5644100.xyz`。
5. 在域名 DNS 中添加 GitHub Pages 的记录，等待 HTTPS 证书签发。

网站是纯静态 HTML/CSS/JavaScript，不需要 Node.js、构建命令或服务器端程序。所有运行时数据已经放在 `assets/data/`，页面引用的媒体也都在 `assets/media/`。

## DNS

裸域 `5644100.xyz` 使用 GitHub Pages 的四条 A 记录：

```text
185.199.108.153
185.199.109.153
185.199.110.153
185.199.111.153
```

如果还要使用 `www.5644100.xyz`，添加一条指向 `你的用户名.github.io` 的 CNAME 记录，并在 GitHub Pages 中设置首选域名。

## 目录说明

- `index.html`：网站入口
- `css/`：样式
- `js/`：地图、场景和交互逻辑
- `assets/data/`：预处理后的内容数据
- `assets/media/`：网站实际使用的图片、音视频和模型

原始 GIS 数据、源视频、CAD/DWG、文档、QA 浏览器缓存和构建工具保留在工作区外部，不属于线上发布包。

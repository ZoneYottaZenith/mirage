# 前端界面

前端页面文件位于：

- `admin.html`：管理后台（自包含单文件，HTML+CSS+JS 内联），由后端 `/admin` 用 `send_file` 直接返回；鉴权用 `localStorage` 存的 `wf_admin_token`，请求带 `X-Admin-Token` 头（图片用 `?token=` 查询参数）
- `../backend/templates/index.html`：用户生图工作台（Flask 模板）
- `../backend/static/app.css`：流体等比缩放样式
- `../backend/static/app.js`：交互、费用计算、文件上传与结果展示

这样保留了前后端目录边界：`frontend` 用于前端页面，`backend` 负责 Flask 服务和其运行时需要的模板/静态资源。

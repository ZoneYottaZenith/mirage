# 幻象工坊 · AI 生图工作台

<p align="center">
  <b>自托管的 AI 图像生成平台</b><br>
  无限画布 · 多中转站管理 · 零数据库依赖 · 单文件后台
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/Flask-3.x-000000?logo=flask&logoColor=white" alt="Flask">
  <img src="https://img.shields.io/badge/Frontend-Vanilla%20JS-F7DF1E?logo=javascript&logoColor=black" alt="Vanilla JS">
  <img src="https://img.shields.io/badge/Storage-JSON%20%2B%20IndexedDB-4B8BBE" alt="Storage">
  <img src="https://img.shields.io/badge/License-MIT-green" alt="License">
</p>

---

## 项目简介

**幻象工坊（UCanTech）** 是一个可以完全自托管的 AI 图像生成平台。它以「无限画布」为核心交互形态，把文生图、图生图、版本管理、本地历史整合在一个无需注册即可上手的工作台里；同时提供一套**高度可定制的管理后台**，让运营者可以自由接入任意兼容 OpenAI Images API 的中转站，独立控制模型、价格、额度与公告。

与市面上「一个站点绑死一个上游 Key」的方案不同，本项目把**中转站（Provider）当作一等公民**：你可以同时配置多个中转站、随时切换、单独指定模型、在线测试可用性，并在不停机的前提下完成所有调整。

> 技术选型上刻意做了减法 —— **没有数据库、没有前端框架、没有构建步骤**。后端是单文件 Flask 应用，数据落在 JSON 文件里；前端是原生 JS + CSS。这让部署变成一个命令的事，也让二次开发不必先啃一堆脚手架。

### 适用场景

- 想给自己的社群 / 团队搭一个可控的 AI 生图入口
- 手上有多个中转站账号，需要一个统一的分发与计费层
- 想按自己的定价策略运营（激活码、额度、流水统计）
- 需要一个能看懂、能改动的生图前端（而不是黑盒 SaaS）

---

## 项目优势

### 一、高度可定制的中转站管理 ⭐

这是本项目最核心的设计。管理后台的「中转站管理」模块支持**多站并存 + 热切换**：

| 能力 | 说明 |
|---|---|
| **多中转站并存** | 无数量上限，每站独立保存配置 |
| **一键启用切换** | 点一下即可切换当前生效的中转站，无需重启服务 |
| **地址自动补全** | 只需填域名或任意层级的路径，自动规范化为完整接口地址 |
| **独立模型配置** | 每个中转站可指定自己的模型 ID，留空则继承全局默认 |
| **在线可用性测试** | 后台直接发起真实请求，返回耗时与错误详情 |
| **调用计数** | 自动统计每个中转站的成功调用次数 |
| **Key 安全展示** | 默认掩码显示，需要时可单独复制，文件权限自动设为 `600` |
| **备注字段** | 给每个站打标签，方便管理多个账号 |

**地址自动补全**的容错设计（填什么都能用）：

```
https://host                    →  https://host/v1/images/generations
https://host/v1                 →  https://host/v1/images/generations
https://host/v1/images          →  https://host/v1/images/generations
https://host/v1/images/generations  →  原样使用
```

**模型解析优先级**：中转站单独配置 > 全局默认模型。这意味着你可以让 A 站跑 `gpt-image-2.5`、B 站跑别的模型，切换站点即切换模型，不需要改代码。

> 配置存放在 `backend/data/providers.json`，也可以直接编辑该文件批量导入。

### 二、其他可定制项

除了中转站，后台把几乎所有运营参数都开放了出来：

| 模块 | 可定制内容 |
|---|---|
| **生图模型** | 全局默认模型 ID，支持在线测试；中转站可单独覆盖 |
| **价格设置** | 1K / 2K / 4K 三档单价独立调整，前端实时同步，无需改代码 |
| **激活码** | 批量生成、按额度或按张数、启用 / 禁用 / 延期 / 删除 |
| **公告设置** | 用户端底部滚动公告，留空则不显示 |
| **购买链接** | 「购买额度」按钮的外链地址，对接你自己的支付页 |
| **监控缓存** | 生成图保留上限（1~5000 张），支持一键清空释放磁盘 |

### 三、零数据库依赖

所有数据落在文件系统里，备份 = 拷贝一个目录，迁移 = 打包带走。

```
backend/data/
├── accounts.json        用户账户与余额
├── codes.json           激活码
├── transactions.json    消费流水
├── providers.json       中转站配置
├── prices.json          价格
├── model.json           全局模型
├── announcement.json    公告
├── purchase.json        购买链接
├── cache_limit.json     缓存上限
└── generated/           生成图 + 缩略图缓存
```

写入采用**临时文件 + 原子替换**（`tmp.replace(path)`），避免写入中断导致文件损坏；金额以**微美元整数**存储（`1 USD = 1_000_000`），彻底规避浮点误差。

### 四、为性能做过针对性优化

生图站的瓶颈往往不在生成，而在**几十张 2K/4K 大图的前端渲染**。本项目在这方面做了不少工作：

- **缩略图两段式加载** —— 节点先挂服务端直出的 512px WebP 缩略图（几十 KB），用户几乎立刻看到图；需要原图时才按需拉取。列表接口的响应体积从数 MB 降到 238 字节。
- **Web Worker + OffscreenCanvas** —— 缩略图降采样完全移出主线程，队列里堆十几张图也不会掉帧。
- **内容哈希去重 + 标记清除 GC** —— 图片按内容哈希存储，同一张图在画布和历史里只占一份；无人引用的自动回收。
- **合成层动画** —— 画布平移、公告滚动等高频动画走 Web Animations API / `transform`，由合成线程执行，主线程繁忙时依然流畅。
- **拖拽跟手** —— 拖拽期间用 `transform` 位移而非 `left/top`，避免每帧重排；松手时才落回布局坐标并持久化。

### 五、安全性设计

- **服务端定价** —— 价格与扣费完全由后端决定，前端传值不可信
- **余额预扣 + 失败退款** —— 任务创建即扣费，上游失败自动退回
- **指纹绑定令牌** —— 用户身份令牌由浏览器指纹 + 服务端密钥派生，`HttpOnly` Cookie 存储，防跨设备复制
- **管理令牌派生** —— 管理员令牌由密码确定性派生（`sha256`），服务重启后依然有效
- **生图接口鉴权** —— 同步调试接口强制管理员权限，避免被当作免费生图 API 滥用

### 六、单文件管理后台

`frontend/admin.html` 是**自包含单文件**（HTML + CSS + JS 全部内联），没有构建步骤、没有依赖包。想改样式或加字段，直接编辑这一个文件即可。

---

## 核心功能

### 用户端（无限画布工作台）

| 功能 | 说明 |
|---|---|
| **无限画布** | 节点自由拖拽、画布平移缩放、移动端双指捏合 |
| **多画布** | 最多 10 个独立画布，各自保存节点与历史，一键切换 |
| **文生图 / 图生图** | 支持上传 1~8 张参考图，可拖拽排序 |
| **版本管理** | 一次生成的多张图归为同一版本，节点内 `‹ ›` 切换，不污染输入框 |
| **本地历史** | IndexedDB 存储，缩略图秒开，支持搜索、收藏、全屏查看、复制/下载 |
| **多分辨率** | 1K / 2K / 4K × 8 种画幅比例（1:1、16:9、9:16、4:3、3:4、3:2、2:3、21:9） |
| **额度体系** | 激活码兑换、余额实时显示、预估费用 |
| **移动端适配** | 整页等比缩放，窄屏自动适配，控件反向补偿保持视觉尺寸 |

### 管理后台

| 模块 | 功能 |
|---|---|
| **中转站管理** | 多站配置、热切换、测试、Key 管理、调用计数 |
| **模型设置** | 全局默认模型 + 在线测试 |
| **价格设置** | 三档单价动态调整 |
| **激活码** | 生成 / 禁用 / 延期 / 删除 |
| **账户与流水** | 注册用户数、总额度、累计消费、最近 500 条流水 |
| **监控缓存** | 保留上限、缩略图预览、一键清空 |
| **公告 / 购买链接** | 用户端展示内容配置 |

---

## 技术架构

```
┌─────────────────────────────────────────────────────────┐
│  浏览器（原生 JS）                                        │
│  ├─ 无限画布 / 节点拖拽 / 双指捏合                        │
│  ├─ IndexedDB：画布快照 + 图片（内容哈希去重）            │
│  └─ Web Worker + OffscreenCanvas：缩略图降采样            │
└────────────────────────┬────────────────────────────────┘
                         │  HTTP (JSON / multipart)
┌────────────────────────▼────────────────────────────────┐
│  Flask 3.x（单文件应用，无数据库）                        │
│  ├─ 用户端 API：任务队列 / 余额 / 兑换 / 公告             │
│  ├─ 管理端 API：中转站 / 模型 / 价格 / 激活码 / 流水      │
│  ├─ 后台线程：任务执行 + 超时清理                         │
│  ├─ Pillow：监控图缩略图生成（WebP）                      │
│  └─ 数据层：JSON 文件 + 原子写入 + 可重入锁               │
└────────────────────────┬────────────────────────────────┘
                         │  Bearer Token
┌────────────────────────▼────────────────────────────────┐
│  上游中转站（兼容 OpenAI Images API）                     │
│  POST /v1/images/generations   文生图                    │
│  POST /v1/images/edits         图生图                    │
└─────────────────────────────────────────────────────────┘
```

**技术栈**

| 层 | 选型 |
|---|---|
| 后端 | Flask 3.x · requests · Pillow |
| 前端 | 原生 JavaScript · CSS（无框架、无构建） |
| 存储 | JSON 文件（服务端） · IndexedDB（客户端） |
| 部署 | systemd · 单进程 · 支持 uv / venv |

---

## 快速开始

### 1. 安装依赖

```bash
cd backend
uv run python app.py
```

首次运行 `uv` 会自动创建虚拟环境并安装依赖（`pyproject.toml` 已声明）。

如果用 `pip`：

```bash
cd backend
pip install -r requirements.txt
python app.py
```

### 2. 访问

| 地址 | 说明 |
|---|---|
| `http://127.0.0.1:5000/` | 用户生图工作台 |
| `http://127.0.0.1:5000/admin` | 管理后台 |

### 3. 初始配置

1. 打开 `/admin`，默认密码 `admin123`（**请立刻通过环境变量 `ADMIN_PASSWORD` 修改**）
2. 在「中转站管理」中添加你的中转站：填地址 + Key，模型可留空
3. 点「测试」确认可用，然后「启用」
4. 在「激活码管理」生成几个激活码
5. 回到用户端兑换额度，开始生图

---

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | `admin123` | 管理后台密码（**生产环境必须修改**） |
| `FLASK_SECRET_KEY` | `change-this-secret-key` | Flask 会话密钥（**生产环境必须修改**） |
| `WANFA_IMAGE_API_KEY` | 空 | 生图 Key；留空则读取 `backend/.wanfa_key` 文件 |
| `WF_FINGERPRINT_SALT` | `wanfa-image-lab-salt` | 用户指纹盐值 |
| `PORT` | `5000` | 监听端口 |
| `FLASK_DEBUG` | 空 | 设为 `1` 开启调试模式（**生产环境不要开**） |

---

## 目录结构

```
.
├── backend/
│   ├── app.py                 后端主程序（单文件）
│   ├── pyproject.toml         依赖声明（uv）
│   ├── requirements.txt       依赖声明（pip）
│   ├── data/                  数据目录（备份只需拷这里）
│   ├── static/
│   │   ├── app.js             前端交互逻辑
│   │   ├── app.css            样式
│   │   └── loading.png        首屏加载图
│   └── templates/
│       └── index.html         用户端页面
└── frontend/
    └── admin.html             管理后台（自包含单文件）
```

---

## 生产部署

### systemd 服务示例

```ini
[Unit]
Description=ChatGPT Mirage
After=network.target

[Service]
Type=simple
WorkingDirectory=/root/ChatGPT-Mirage/backend
ExecStart=/root/ChatGPT-Mirage/venv/bin/python /root/ChatGPT-Mirage/backend/app.py
Environment=PORT=5000
Environment=ADMIN_PASSWORD=your-strong-password
Environment=FLASK_SECRET_KEY=your-random-secret
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now chatgpt-mirage
```

### 更新代码时保留数据

更新只需覆盖代码，**不要动 `backend/data/`**：

```bash
# 备份数据
cp -a backend/data /tmp/data_backup

# 覆盖代码（保留 data / .wanfa_key / image_tasks.json）
find backend -maxdepth 1 -mindepth 1 \
  ! -name data ! -name .wanfa_key ! -name image_tasks.json \
  -exec rm -rf {} +
cp -a new_version/backend/. backend/

# 还原数据并重启
cp -a /tmp/data_backup backend/data
systemctl restart chatgpt-mirage
```

---

## 二次开发提示

- **改价格**：后台「价格设置」直接改，或编辑 `backend/data/prices.json`
- **加中转站**：后台添加，或直接编辑 `backend/data/providers.json`
- **改样式**：`backend/static/app.css`（用户端）、`frontend/admin.html` 内联样式（后台）
- **改交互**：`backend/static/app.js`（约 2700 行，按功能分区注释）
- **加 API**：`backend/app.py`，路由按 `/api/*`（用户端）与 `/admin/*`、`/api/admin/*`（管理端）分组

---

## 许可

MIT License

---

<p align="center">
  <sub>Made with 幻象工坊 · UCanTech</sub>
</p>

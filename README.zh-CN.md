[English](README.md) | [简体中文](README.zh-CN.md)

# Codex Taskboard

一个本地优先的议题面板，可在浏览器中运行，也可通过独立 CDP 启动器或其注入脚本嵌入 Codex。同一套 HTTP API 为 React UI 和随附 Codex Skill 使用的 `taskctl` CLI 提供支持。

![Codex Taskboard 产品截图](docs/assets/codex-taskboard.png)

## 系统要求

- Node.js 22.5 或更高版本
- 构建 macOS App 和 DMG：Xcode Command Line Tools、Rust 1.88 或更高版本，以及 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` target。`npm install` 会安装本项目使用的 Tauri CLI。
- 构建 Windows NSIS：Microsoft Store 版 Codex App、Rust 1.88 或更高版本，以及带 C++ 工作负载和 Windows SDK 的 Visual Studio Build Tools。

## 本地运行

```bash
npm install
npm run build
npm start
```

打开 <http://127.0.0.1:47823>。SQLite 数据库存储在 `.data/taskboard.sqlite`。

如需在前端实时重载模式下开发：

```bash
npm run dev
```

Vite UI 运行在 <http://127.0.0.1:5173>，并将 API 请求代理到本地服务。

## 使用 CLI

在项目中运行：

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

请运行 `npm link`，以便在 shell 路径中使用 `taskctl`。设置 `CODEX_TASKBOARD_URL`，可让 CLI 指向另一个本地或局域网服务。云端部署通过**回环 companion**（本机 loopback 配套服务，不是「伴侣」）使用 `taskctl cloud login` 配置。

## 安装 Codex Skill

将 `skills/manage-taskboard` 复制或符号链接到 Codex Skill 目录，然后启动一个新的 Codex 任务：

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.agents/skills/manage-taskboard
```

桌面 App 会让该目录与内置 Skill 保持同步。该 Skill 会指导 Codex 检查议题，将其移到 `in_progress`，使用乐观版本控制，验证工作，然后将其移到 `in_review`；只有在用户明确确认接受或要求将议题标记为完成后，才会将议题移到 `done`。

## 嵌入 Codex

### 手动：使用专用 CDP 端口

让现有 Codex 窗口保持打开。在 Taskboard 仓库中，使用专用 CDP 端口启动第二个 Codex 实例：

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

新 Codex 窗口出现后，在另一个终端中运行注入器：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

使用嵌入式面板时，让注入器终端保持运行。原 Codex 窗口不会变化，新窗口会显示 Taskboard 侧边栏入口。如果端口 `9231` 已被占用，请在两个命令中使用另一个端口。

### 推荐：用一个命令启动独立 Taskboard 窗口

让现有 Codex 窗口保持打开，然后运行：

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

该命令会在需要时启动本地 Taskboard 服务。它会复用已打开且有可用 CDP 渲染器的 Codex；普通 Codex 没有 CDP 时，它会在该实例的原生浏览面板中打开 Taskboard；没有打开 Codex 时，它会使用独立配置文件和仅限回环访问的端口 `9231` 启动官方 macOS Codex App。有可用 CDP 时，它会在 Plugins 后注入一个原生外观的 Taskboard 入口，并持续监视服务和替换后的渲染器。使用嵌入式面板时，请让该命令保持运行。启动器不会修改 `ChatGPT.app` 或其 `app.asar`。

源码启动器会把带身份信息的服务地址写入 `.data/launcher-runtime.json`。通过 `npm link` 安装的 `taskctl` 默认读取此文件。因此，普通 shell 和从面板打开的 Codex 任务无需设置额外环境变量，即可使用同一个 Taskboard 服务。

### macOS App：无需终端即可打开和注入

如需进行 Tauri 开发，请运行：

```bash
npm run app:dev
```

如需构建本地 App 和 DMG，请先安装两个 Rust target，然后运行构建：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run app:build
```

从 Finder 打开 `src-tauri/target/universal-apple-darwin/release/bundle/macos/Codex Taskboard.app`。DMG 位于 `src-tauri/target/universal-apple-darwin/release/bundle/dmg/`。如果只需安装稳定版，请从 [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases/latest) 下载当前 DMG。

该 App 包含自己的 Node 运行时、Taskboard 服务、构建后的 Web UI、Skill、CLI 包装器和注入脚本。它会启动服务，复用已打开且有可用 CDP 渲染器的 Codex；普通 Codex 没有 CDP 时，它会在该实例的原生浏览面板中打开 Taskboard；没有打开 Codex 时，它会启动官方 Codex App。有可用 CDP 时，它会等待渲染器并注入侧边栏入口，然后在不显示终端窗口的情况下打开面板。该 App 可以复制到本检出目录之外；目标 Mac 只需安装官方 Codex App，不需要此仓库、系统 Node 安装或单独的 Codex CLI 安装。Taskboard 数据存储在 `~/Library/Application Support/Codex Taskboard`，启动器输出写入 `~/Library/Logs/Codex Taskboard/codex-taskboard-launcher.log`。

本地构建使用 ad-hoc 代码签名进行直接验证。公开的 macOS 下载仍需要 Developer ID 签名和 Apple 公证。

### Linux App：Ubuntu 24.04 x64 软件包

Linux 桌面版第一版仅支持 Ubuntu 24.04 LTS x64。请先安装官方 ChatGPT 桌面版 `.deb`，并确认运行 `chatgpt` 可以打开它。然后从 [GitHub Releases](https://github.com/chuspeeism/dashi-taskboard/releases/latest) 下载 Codex Taskboard `.deb` 或 `.AppImage`。请将以下命令中的 `<file>` 替换为下载的文件名。

安装 `.deb` 软件包：

```bash
sudo apt install ./<file>.deb
```

或者运行 AppImage：

```bash
chmod +x ./<file>.AppImage
./<file>.AppImage
```

如需在 Ubuntu 24.04 x64 上构建这两种软件包，请运行：

```bash
npm ci
npm run app:build:linux:x64
```

第一版不支持 ARM64、Fedora、RPM 软件包或其他 Linux 发行版。

### Windows App：托盘启动器与内置 Taskboard

先从 Microsoft Store 安装官方 Codex App。在 Windows x64 上运行以下命令构建当前用户级 NSIS 安装包：

```powershell
npm ci
npm run app:build:windows
```

安装包位于 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。它包含托盘启动器、内置 Node、本地服务、构建后的 Web UI、Skill、`taskctl.cmd` 和注入脚本。Taskboard 数据存储在 `%APPDATA%\Codex Taskboard`，日志存储在 `%LOCALAPPDATA%\Codex Taskboard\Logs`，Skill 会复制到 `%USERPROFILE%\.agents\skills\manage-taskboard`。

Windows CI 产物目前有意保持未签名，也不支持自动更新。分发前请阅读[代码签名策略](docs/code-signing-policy.md)。保留数据的行为见 [Windows 卸载说明](docs/windows-uninstall.md)。

Codex 26.715.52143 的渲染器 CSP 会阻止任意 HTTP iframe。因此，启动器会启用 CDP CSP 绕过，重新加载该渲染器一次，安装文档启动脚本，并等待 Taskboard OOPIF 实际加载。同一台机器上的其他进程访问 CDP 时不需要身份验证，因此启动器运行时只能运行受信任的本地代码。

要注入一个已经通过其他方式使用 CDP 启动的 Codex 实例，请运行：

```bash
npm run codex:inject -- --port 9229 --open
```

该命令也会保持驻留，因此服务退出后，注入的标签页可以重新启动 Taskboard。使用 `Ctrl-C` 停止该命令。

该脚本会在 Codex 侧边栏添加 Taskboard 入口，并在 Codex 的整个主工作区渲染 iframe，包括上下文标题栏区域，因此 Taskboard 自己的页眉不会留下空白条。这个完整的矩形页眉位于 Electron 可拖动层之上，并标记为 `no-drag`；由于 Taskboard 活动时会隐藏原生上下文操作，它自己的操作可以使用正常的边缘内边距，不会产生人为的右侧空隙。原生侧边栏保持挂载，此前页面的选中状态和上下文页眉会暂时隐藏；选择另一个 Codex 页面会恢复它们。

“在对话中打开”会在可用时选择对应的原生 Codex 项目，并打开一个未发送的原生 composer，其中包含 `e-taskboard` 指令和议题的真实标识符。已安装的 Skill 会根据该指令隐式选中，因此 composer 不会添加 `$manage-taskboard` 提及。只有在会话实际处理该议题后，才会记录该会话的归属关系：`taskctl` 读取 Codex 的 `CODEX_THREAD_ID`，并在议题或评论变更上记录该 ID。记录的 ID 可通过 Codex 的原生路由桥接点击。每个议题可以绑定一个 Git 分支或一个 worktree；选项从所选 Codex 项目的仓库扫描，而不是手动输入。该集成使用 Codex 现有的项目、composer 和路由标记；它不会修改 React、替换 `fetch`、加载私有 chunk 或编辑 Codex 数据文件。

要使用不同的 UI 来源，请在用户脚本运行前设置 `window.__CODEX_TASKBOARD_URL__`。

## 飞书 Auto-Cut 集成

飞书 Bridge 与 Taskboard 的集成只在本机运行。Bridge 必须通过带有 `x-taskboard-client: feishu-bridge` 和本机共享密钥 `x-feishu-bridge-secret` 的 `POST /api/local/feishu/tasks` 创建工作流任务；启动脚本会把同一个 `CODEX_FEISHU_BRIDGE_SECRET` 注入两个服务。Taskboard 会把 Base/子表/记录的来源信息作为服务端数据单独登记。普通的 `POST /api/tasks` 即使复制了飞书描述标记或 `feishu` 标签，也不能启动 Auto-Cut、上传产物或出现在 Bridge 的待处理查询中。

通过本机专用接口登记的可信飞书任务，可以在未初始化 Git 的目录中运行其本机已登记 Auto-Cut 包。Taskboard 只有在服务端来源和可信包快照都匹配后，才会向 Codex 添加非 Git 工作区参数；普通任务、复制的标记、浏览器输入和飞书单元格都不能申请该权限。

如果 Codex 在返回原生任务 ID 前就退出，把可信任务移回“待处理”并再次启动时，Taskboard 会解除失败本地会话与卡片的绑定，同时保留该会话历史，并为重试创建新会话。已经真正创建过原生 Codex 任务的会话绝不会自动解绑，避免重复执行 Auto-Cut。

Bridge 用下面的回环接口做生命周期同步：

- `GET /api/local/feishu/tasks`：按事件，或按 Base/子表/记录/触发字段范围查询可信任务；
- `POST /api/local/feishu/tasks/:id/archive`：经过乐观版本校验后，只归档可信任务；
- `POST /api/local/tasks/:id/execute`：手动点击和拖拽到“处理中”共用的唯一执行认领入口。同一任务、同一触发类型的重复请求会复用已有预约；不同触发类型仍保留“执行已在进行中”的并发保护。

每个 Base/子表会固定对应一个隔离项目，项目 ID 是 `feishu-` 加上 `sha256(baseToken:tableId)` 的前 16 个十六进制字符；Bridge 和 Taskboard 必须使用同一规则。旧项目 ID 不会自动改写，新的任务统一使用该 16 位规则。

在工作流面板可以粘贴飞书直接 `/base/{base_token}` 链接，也可以粘贴知识库中的 `/wiki/{wiki_token}` 链接，链接需来自标准 `https://*.feishu.cn` 域名。Taskboard 会把完整链接交给本机 Bridge 只读获取元数据；Wiki 链接会先确认节点确实是多维表格，再解析出真实 Base token，并保留链接中的 `table` 子表选择，绝不会把 Wiki token 直接当作 Base 身份。发现的子表都先保持草稿，只有分别选择“显示”和“启用”后才进入对应界面和 Bridge 活动白名单，“显示”与“启用”互相独立。`/base/workspace/{token}` 仍不支持；导入 Wiki 链接需要 Bridge 使用的飞书应用具有该 Wiki 节点的只读访问权限。

每个学科草稿独立保存唯一触发字段/值、手动或自动执行模式、Auto-Cut 包别名、并发限制和上传策略。点击启用前会实时校验飞书元数据和本机包配置，验证成功后才替换 Bridge 活动快照。导出的共享配置不会携带凭据、工作区路径、ZIP 获取路径、上传路径、运行状态或历史任务；导入会先合并 Bridge 实时诊断和 Taskboard 本机绑定诊断，在确认框列出实际警告/错误消息，并始终以草稿落库。
已启用子表刷新元数据后会生成新的本地草稿，保留上一次已验证的 Bridge 活动快照，直到显式重新启用该草稿。

自动执行由显式的服务策略（`allowAutomaticExecution`）控制，除非本机部署通过 `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION` 主动开启，否则默认关闭。Auto-Cut 成功后任务仍保持“处理中”，直到剪映草稿 ZIP 通过结构校验并计算 SHA-256；验证成功后，手动模式进入“待验收”，自动模式进入“已完成剪辑”。上传配置为自动时，自动任务会在 ZIP 校验后入队，手动任务会在验收进入“已完成剪辑”后入队；上传配置为手动时，则由已完成任务界面手动入队。上传任务会把已验证产物复制到配置好的本地或 UNC/NAS 路径，按学科限制上传并发，并提供手动重试和冲突保护。

工作流面板支持“手动选择”（`manual_select`）和“Auto-Cut 上报”（`driver_report`）；“监控目录”（`watch_directory`）仍为预留值并保持禁用。使用 `driver_report` 时需要配置绝对的 ZIP 来源根目录。Auto-Cut 验收本次运行生成的准确 ZIP 后，执行 `taskctl artifact report --file <验收通过 ZIP 的绝对路径>`。该命令只读取并计算这个指定文件的 SHA-256，再通过 Taskboard 为本次运行注入的专属能力上报准确路径和哈希。

Taskboard 只接受服务端登记的可信飞书任务当前活动运行所发出的上报。登记产物前，它会验证不可变的飞书来源和学科策略、task/thread/run/token 归属链、文件位于配置根目录内，并独立复算哈希和执行现有剪映 ZIP 结构校验；不会扫描来源目录、选择“最新 ZIP”，也不会根据文件名推断任务归属。上报后任务继续保持“处理中”，直到同一个运行成功结束；自动执行随后进入“已完成剪辑”，且在 `enqueueMode=automatic` 时将该运行的准确产物加入上传队列。手动执行则进入“待验收”，保留现有验收流程。

### 飞书学科统一流程看板

对于飞书学科，侧边栏当前选中的 Base 和学科子表就是流程看板的唯一范围；其他 Base 或学科的任务、视图、流程名称和说明都不会混入当前页面。首次进入一个学科时，系统只会建立一个“全部流程”系统视图，其中按固定顺序列出该学科可用的流程。它不能编辑或删除，系统也不会预先创建“剪辑流程”“上传流程”等业务视图。

要按自己的工作方式查看流程，点击“新建视图”，输入名称，勾选需要的流程并调整顺序，再点击“保存”。之后可以在流程看板选择该视图，并通过“管理视图”复制、编辑、设为默认或删除自建视图。视图和筛选只影响当前学科的显示，不会改变任务的实际状态，也不会影响其他学科。可在该学科的流程显示设置中修改每一列的名称和说明；这些文字只帮助理解卡片何时出现，不会改变 Auto-Cut、验收或上传的执行规则。

隐藏流程不会丢失任务。看板会保留隐藏流程的任务、已验证 ZIP 和上传失败计数；需要查找被隐藏的任务时，把“搜索范围”切换为“全部流程”，结果可以临时显示对应流程而不改写已保存的视图。卡片上的 ZIP 详情默认折叠，可用鼠标或键盘展开；上传失败的详情会自动展开，便于查看可重试的状态。上传列只读，不能靠拖拽改变上传状态；上传仍通过入队、上传工作器和失败重试操作推进。普通任务保留在“普通任务”标签中，不会混入学科流程。

普通本地项目仍可使用“节点模式”；飞书学科只使用统一流程看板，不显示节点模式入口。项目菜单中的“归档”可把本地项目移入“已归档 / 历史项目”，之后可选择“恢复”。只有空的手动创建项目允许永久删除，删除后无法恢复。移除 Taskboard 中的 Base 或子表只会归档本地历史和流程视图，不会删除飞书中的远程 Base、子表或记录；重新加入同一学科会恢复其本地历史。

多维表格单元格只能提供受控值和项目包别名，不能提供工作区路径、shell 命令、提示词、凭据或上传目标；这些绑定保存在本机 Taskboard/Bridge 配置中。

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `127.0.0.1` | HTTP 绑定地址；只允许本机回环地址 |
| `CODEX_TASKBOARD_PORT` | `47823` | 本地 HTTP 端口 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 数据目录 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47823` | CLI API 源地址 |
| `CODEX_TASKBOARD_ALLOW_AUTOMATIC_EXECUTION` | 未设置（关闭） | 仅在明确批准的本机部署中设置为 `1`、`true`、`yes` 或 `on` |

`npm start` 只在本机回环地址提供 Taskboard。任务、评论和附件变化通过服务器发送事件广播到所有打开的本机客户端；客户端重连后会执行完整刷新，因此不会遗漏断开连接期间发生的变化。

## 通过 Cloudflare 共享

对于两名受信任的协作者，Taskboard 可以在 Cloudflare 上运行，使用 Worker Static Assets 和 API 路由，以 D1 作为权威业务数据库，并使用私有 R2 bucket 存储附件。该部署使用带共享密码的 HTTPS Basic 身份验证，并在全局修订号变化后刷新已打开的面板。

每台设备保留自己的项目检出映射，并继续使用**本地 companion**（本机配套服务 / 环回代理）提供 Codex、Git/worktree、Skill 和 MCP 能力。请勿将 companion 译为「伴侣」，也不要把普通 Taskboard HTTP 接口称为「伴侣 API」。云端模式绝不会回退到本地 SQLite 数据库，也不会同时写入本地数据库。

请参阅[云端协作](docs/cloud-collaboration.md)，了解所有者部署、现有 GitHub 安装设置、密码轮换、本地路径映射和一次性本地数据迁移流程。

## 许可证与来源

当前独立发布地址是 [fengcong22/feishu-autocut-taskboard](https://github.com/fengcong22/feishu-autocut-taskboard)。本项目基于上游 [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)，当前飞书 Auto-Cut 功能版本在这个独立仓库中维护。

除文件自身或第三方说明另有规定外，本仓库中的项目贡献均按 [Apache 2.0 许可证](LICENSE) 发布。来源历史、第三方材料和仓库级许可证的适用范围见 [NOTICE.md](NOTICE.md)。飞书、Codex、剪映、LobeHub、X 等产品名称和标志仍受其各自所有者的条款约束。

## 验证

```bash
npm run check
```

该命令会运行 TypeScript 检查、生产前端构建、组件测试，以及服务器/CLI/注入测试套件。

## 议题 Markdown

议题描述和评论支持 GFM，包括表格和任务列表。`mermaid` 围栏代码块会在查看器加载后渲染成只读图；渲染失败时仍可阅读原始图表源码。Markdown HTML 注释（例如 `<!-- trace-analysis:v1 ... -->`）不会出现在渲染后的正文中，且不会启用原始 HTML。

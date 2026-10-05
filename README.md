# dsh-agnes

Agnes AI 图像 / 视频生成能力，作为 DSH 插件：**设置页负责配置，真正的调用走一个 bundled skill**。

- Host 半边注册 `agnes` 设置命名空间、**配置/凭据两条同源路由**，以及**一个 bundled skill**（`skills/agnes/SKILL.md`，其中的 `{{CLI}}` 会被替换成本机 CLI 的绝对路径）。**不注册任何模型工具**——能力在 skill 里，调用由 agent 用 shell 跑命令行完成。
- Client 半边在 `settings.section` 注册一个设置页（API Key、模型、尺寸、输出目录、轮询参数）。
- 执行体是 `lib/cli.mjs`：一个**纯 Node 进程**（无 Cordis、无 DSH ctx），读同一份设置文件 + Key 文件，复用 `lib/agnes-api.mjs`，产物按 `--out → 设置里的输出目录 → <当前目录>/agnes-output/<日期>/ → <DSH_HOME>/agnes-output/<日期>/` 落盘。
- **配置存在插件自己的文件里**：`<DSH_HOME>/storages/agnes/config.json`（`{version, revision, values}`）。页面通过宿主半边的同源路由读写它，CLI 读同一份；DSH 设置命名空间（导出 `Config` 派生出来的那份）只是**更低优先级的一层**。
- **API Key 有三处**：DSH 凭据存储（权威）、`<DSH_HOME>/storages/agnes/api-key`（宿主半在你保存时镜像一份，0600，供 CLI 读取）、环境变量 `AGNES_API_KEY`（优先级最高）。CLI 取用顺序就是：环境变量 → Key 文件。
- 设置页按顺序探测传输：`ctx.remote.settings` → `settingsScope`（0.1.x）→ **宿主半边路由** `/api/dsh-agnes.settings`（配置）与 `/api/dsh-agnes.credential`（凭据）。前两条在 DSH 0.2.0-rc.2 的 Web 客户端对插件上下文恒为 undefined，所以实际走第三条。候选全失败时页面显示探测报告，并在控制台打 `[agnes] no settings transport`。
- Host 半边仍按 0.2.x 文档声明「自带页面」：`configure({ auto: false }, ctx.fiber)`，挂在 `ctx.inject(['settings'], …)` 子级上 —— 没有 Settings 服务的宿主也能正常装载本行。
- **路由必须挂在 `ctx.inject(['connection'], …)` 里**：`connection` 是**晚于 profile 行装载**的（dsh-context 源码里写明这条 load-order 约定），`ctx.get('connection')` 在 apply 时恒为 undefined——这正是「宿主路由没注册」那一轮的根因。等待不会阻塞本行，注册也随注入 fiber 一起撤销。
- 客户端 bridge 适配器要求**成功响应必须是 JSON**：SPA 兜底会用 `200 + index.html` 回答未知路径；把这种「成功的空结果」当成 `describe()` 就会误报成「宿主的设置平面里没有 agnes 命名空间」（case 6 覆盖）。
- 页面自带**错误边界**：槽位系统会「退役」（abdicate）渲染抛异常的注册，退役后设置页只剩空白；边界先把异常接住并显示原因，不再变成白屏（`scripts/client-page.check.mjs` 的 case 4 专门覆盖）。
- **版本号 0.6.1 是刻意的**：registry 上的 `dsh-agnes@0.6.0` 面向 DSH 0.1.x 线——它 `import { installSettingsSection } from '@deepseek-ai/dsh-settings'`，而 0.2.0-rc.2 没有这个导出，装上会让整个 harness 起不来（bundle 行是 required 行）。本仓库是 0.2.x 线的本地分支，版本号高于 0.6.0，市场才不会把不兼容的那条当成「可升级」推给你；**请勿在市场里点 dsh-agnes 的升级**。
- `cordis.patch.yml` 只 `insert` 一行 `agnes`，不禁用也不替换任何宿主行。

## 已实测的 Agnes API 事实（2026-10 实测，非文档摘抄）

| 事实 | 证据 |
| --- | --- |
| `POST /v1/images/generations` 返回 `{data:[{url,b64_json:""}], created, task_id}`，**默认只给 URL** | 1K ≈ 10–16s，4K ≈ 40s |
| `size` 支持像素对与档位；`'2K'+aspect_ratio:'16:9'`、`'4K'+'9:16'` 均被接受 | 实测 HTTP 200 |
| 图片端点接受 **base64 data URI** 作为 `image` 输入（图生图、构图保留） | 本地 PNG → data URI → 编辑成功 |
| `images:[]` 数组被拒：`images is not supported by text image queue` | 多图合成在 v1 不承诺 |
| `POST /v1/videos` 返回 `{id, video_id, task_id, status:"queued", progress, seconds, size}` | 5s/121帧/24fps ≈ 96s |
| 视频 `image` **只接受公网 URL**：data URI 会被静默丢弃（服务端只存长度 3 的占位串） | 对照实验：URL 回显 132 字符 |
| 输出尺寸会被吸附到预设档 | 请求 1152x768 → 实际 1088x832，`size_mapping.adjusted=true` |
| `agnes-video-2.5` 对当前 key 无可用通道；`agnes-video-2.5-flash` 会 `video_queue_full` | `503 no available channel` |
| 轮询 `GET /agnesapi?video_id=..&model_name=..` 返回 `status/progress/url/size_mapping/request_params` | 完成态含 `url` 指向 mp4 |

这些事实直接决定了实现：视频不接受本地文件当首帧（改为先经一次图生图换取公网 URL，并在结果里标注画面被改写过）。

## 用法（skill + CLI）

装了插件、在 **设置 → Agnes** 填好 API Key 之后，能力就已经挂到 skill 目录里了；agent 会在需要时读到它并执行：

```powershell
node "<插件目录>\lib\cli.mjs" image --prompt "雨夜霓虹下的古镇，国风插画" --size 2K --aspect 16:9
node "<插件目录>\lib\cli.mjs" image --prompt "改成线稿风格" --images .\photo.png
node "<插件目录>\lib\cli.mjs" video --prompt "无人机掠过雪山" --size 720P --wait=180000
node "<插件目录>\lib\cli.mjs" task list            # 或 status/wait/cancel --id <taskId>
node "<插件目录>\lib\cli.mjs" models                # 当前 key 可达的模型
node "<插件目录>\lib\cli.mjs" config                # 解析后的配置（不含密钥值）
```

- `skills/agnes/SKILL.md` 里的 `{{CLI}}` 在注册时被替换成**这个安装的绝对路径**，所以模型不需要猜路径。
- **stdout 只有一个 JSON 对象**（过程信息走 stderr）：成功 `{ ok: true, files|task }`，失败 `{ ok: false, error, kind, hint }` 且退出码 1。
- 落盘顺序：`--out` → 设置里的「输出目录」→ **`<当前工作目录>/agnes-output/<日期>/`**（agent 的 shell 就在会话工作区里，这一条就是「会话工作区」）→ `<DSH_HOME>/agnes-output/<日期>/`；回退时结果里 `fellBack: true`。
- 产出**立即下载落盘**：Agnes 的输出 URL 会过期，URL 本身不作为交付物。

## 安装

用 DSH 自己的安装器，**不要手工把包目录拷进 `profiles/<profile>/node_modules`**：

```powershell
dsh plugin --profile web add dsh-agnes                   # 发布到 npm 之后
dsh plugin --profile web add file:D:\path\to\dsh-agnes   # 或直接从本地目录安装
```

装好后重启 DSH 让 profile 重新组合，然后打开 **设置 → Agnes** 填入 API Key（写入 DSH 凭据存储，不回显）。桌面端的热装载会立刻生效在宿主半边（4 个工具当即可用），但浏览器里已经加载的旧客户端包不会自己换——**刷新页面**（F5）后新设置页才生效。

### 本地目录安装前必须删掉 `node_modules` junction（实测教训）

自检用的 `node_modules` junction（见下一节）会让本地目录安装直接失败：

```
generation-install: ENOENT: no such file or directory, stat 'D:\...\dsh-agnes\node_modules\@agentclientprotocol\sdk'
```

安装器把源目录**整树复制**（`cp` with `dereference: true`）进 staging，再在 staging 里 `pnpm add file:...`；junction 会把它指向的共享 `profiles\node_modules` 整棵树都拖进复制过程，遇到任何解析不到的条目就报 ENOENT。所以：

```powershell
cmd /c rmdir "D:\path\to\dsh-agnes\node_modules"   # 只删链接，不动目标
# 然后安装；需要再自检时把 junction 建回来
```

### 依赖声明：宿主包放 peer，不要放 dependencies

`@deepseek-ai/*` 由 DSH 在运行时提供（profile 的 `pnpm-workspace.yaml` 里 `autoInstallPeers: false`），所以它们必须是 **peer** 依赖（可 `optional`），像 `dshmarket` 那样；写进 `dependencies` 会让安装器去 registry 拉宿主包，并可能被 `hoistHostSingletons` 清掉。本包真正需要的第三方库才放 `dependencies`。

### 为什么不能手工拷贝（实测教训）

桌面端在启动时校验 profile 一致性。一个「存在于 `node_modules`、却没被 profile manifest 声明」的插件包会让整个插件树加载失败：

```
Harness could not start.
Error: dsh: plugin tree failed to load: dsh: 3 entries did not activate
```

同一时刻 `logs/harness.log` 会给出真正的原因：

```
[desktop] profile inconsistency: dsh-agnes is installed but declared nowhere in the profile manifest
```

安装器的价值正在于此：它建立 `.generations/live/<pkg>+<version>+<hash>/` 布局，往 `profiles/<profile>/package.json` 写 `link:` 依赖，并登记 bundle。手工拷贝跳过了这些声明，代价是整个 harness 起不来。

### 卸载 / 回滚

用安装器对应的卸载命令，或市场 UI 卸载。手工安装的残留需要**目录与 manifest 声明一起清掉**，只处理一个仍会启动失败。

```powershell
# 仅手工安装留下残局时使用
Copy-Item "$env:DSH_HOME\profiles\web\package.json.bak-agnes" "$env:DSH_HOME\profiles\web\package.json" -Force
Remove-Item -Recurse -Force "$env:DSH_HOME\profiles\web\node_modules\dsh-agnes"
```

## 自检

```powershell
# 两个半边能否加载、注册、解析 schema（安装前必跑）
$env:AGNES_REQUIRE_SCHEMA='1'; node scripts/selfcheck.mjs

# 设置页在三种宿主下的读写（0.2.x remote.settings / 缺命名空间 / 0.1.x settingsScope）
node scripts/client-page.check.mjs

# 传输层端到端（真实调用 Agnes）
$env:AGNES_API_KEY='cpk-...'; node scripts/smoke.mjs --video-wait
```

`selfcheck.mjs` 里那一节 schema 校验需要在 checkout 里能解析 `@deepseek-ai/schemastery`，所以开发者常建一个 junction：

```powershell
cmd /c mklink /J dsh-agnes\node_modules "%APPDATA%\dsh-desktop\harness\profiles\node_modules"
```

**装之前一定要删掉它**（见上一节的安装教训）：安装器会整树复制源目录。

## 配置存储（插件自有文件）

页面与工具共用这一份文件，路径 `<DSH_HOME>/storages/agnes/config.json`（与 `tasks.json` 同目录）：

```json
{
  "version": 1,
  "revision": 3,
  "values": { "imageModel": "agnes-image-2.1-flash", "outputDir": "D:\\agnes-out" }
}
```

- **读取优先级**：内置默认值 → 行配置/`ctx.config`（旧的 DSH 设置层）→ **本文件**（最高）。文件里没有的键就用下层，`unset`（页面上的「已改 · 重置」）就是把键从文件里删掉。
- **写入**：页面 POST 到 `/api/dsh-agnes.settings`，宿主半边校验字段名与类型、带 `revision` 做冲突检测（陈旧→409），用「临时文件 + rename」原子落盘。
- **边界在哪**：这两条路由挂在 `ctx.connection.fetch.register` 上，也就是所有官方插件 API 共用的**已认证、同源 `/api` 通道**（桌面端自带的 image-generation 路由同样如此）。**不要再加 Host/loopback 白名单**——实测教训：harness 构造 handler 的 Request 时用的 host 会被正则漏掉，于是**连设置页自己的请求都被 403**，页面只能退回一个看不到本行的设置平面。防护来自通道认证 + 字段校验 + revision + 原子写。
- **手工编辑**：可以直接改文件；宿主半边按 mtime 自动重读，工具下一次调用即生效（`revision` 建议一并 +1，页面上陈旧写入会被 409 拒绝）。
- **`revision`**：每次成功写入 +1；页面读到的 revision 会随写入回传，用于防止两个窗口互相覆盖。
- **API Key 文件**：`<DSH_HOME>/storages/agnes/api-key`（单行、0600；Windows 下由数据目录的用户 ACL 兜底）。宿主半在你保存 Key 时写入，启动时若凭据已存在也会刷新一次。这是**给 CLI 的交接**——CLI 是独立进程，读不到 DSH 凭据存储。环境变量 `AGNES_API_KEY` 优先级高于该文件；不想留这份明文就删掉它并改用环境变量。

## 设置页排错（实测）

| 页面提示 | 真正的原因 | 处理 |
| --- | --- | --- |
| 设置命名空间绑定失败：当前宿主未提供 settingsScope 服务（历史版本） | 0.2.x 的 Web 客户端不给插件上下文提供 `settingsScope` | 现版本不再依赖它：优先 `remote.settings`，再 `settingsScope`，最后走宿主半边路由 |
| 设置命名空间绑定失败：当前宿主没有可用的设置传输（…） | 全部候选失败；消息括号里是最后几条失败原因，展开「原始设置快照（排查用）」可看到完整探测报告 | 看报告里 `HTTP /api/dsh-agnes.settings: …` 那行：`设置路由未注册（非 JSON）` = 宿主半边没装载或路由没注册（看 `[agnes]` 日志里有没有 `settings bridge ready at …`） |
| 宿主的设置平面里没有 “agnes” 命名空间 | ①路由根本没注册（`ctx.get('connection')` 恒 undefined，见上文 load-order），页面把 SPA 兜底的 200+HTML 误判成空 describe；②宿主半边没装载；③`@deepseek-ai/schemastery` 解析不到 ⇒ 导出不了 `Config` ⇒ 无法派生命名空间 | ①已修（改为嵌套 inject + 成功响应必须是 JSON）；②③看日志里 `[agnes]` 那几行。提示里会列出宿主**实际**暴露的命名空间清单，便于对照 |
| 设置服务不可用：只有通过本机（loopback）打开的页面才能读写设置 | 用非 loopback 地址打开 GUI | 改用 `http://127.0.0.1:<port>` |
| 当前页面只读：设置写入未开启 | 宿主判定设置文档不可写 | 检查 profile 目录与 settings.yaml 的写权限 |
| 打开设置页一片空白（历史版本） | 渲染抛异常 ⇒ 槽位系统把该注册 **abdicate**（退役），页面只剩空壳 | 现版本有 `PageBoundary`：会显示 `Agnes 设置页渲染失败：<原因>` 与堆栈，并在控制台打 `[agnes] settings page render failed` |
| 启动时 `dsh: startup failed: 1 required plugin did not activate`，指向 `installSettingsSection` | 装的是 registry 的 `dsh-agnes@0.6.0`（DSH 0.1.x 线），与 0.2.0-rc.2 的 `@deepseek-ai/dsh-settings` 不兼容 | 别在市场点「升级」；用本仓库重新安装（版本已提到 0.6.1）。桌面端会自动摘掉坏行并重启，备份在 `…\harness\recovery\plugin-removals\` |

`agnes` 这个命名空间名 = 宿主 Loader 里那一行的 **row id**（`cordis.patch.yml` 的 `insert.id`），不是 npm 包名，也不是 `include:agnes` 这种合成 entry id。改 `insert.id` 就必须同步改客户端半边里的 `NS`。

## 已知缺口（不假装已完成）

- **视频进度不在 DSH 任务面板**：`JobKindMap` 只承认 `bash | subagent` 两种 kind，插件无法注册自己的 job kind，因此改用进程内轮询 + 落盘任务记录（`<DSH_HOME>/storages/agnes/tasks.json`）。
- **`agnes_video` 的「首帧改写」是显式代价**：本地图必须先经一次图生图换公网 URL，画面会被轻微改动，结果里会写明。
- **不做自动降级**：模型不可用时把原文错误与处理建议交回，不改用其它模型（按你的决策）。
- **多图合成、2.5 的 keyframe（首尾帧）不在 v1**：前者被 API 拒绝，后者对当前 key 无通道。

## 密钥处理

API Key 只以**引用名**（默认 `AGNES_API_KEY`）出现在配置里，值存于 DSH 凭据存储；插件运行时 `ctx.credentials.resolve(ref)` 取用，日志与工具结果都不打印密钥。凭据文件里的值本身是结构化记录（`{kind, payload, version, secret}`），**不要手写**。

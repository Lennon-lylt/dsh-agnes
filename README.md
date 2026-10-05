# dsh-agnes

Agnes AI 图像 / 视频生成能力，作为 DSH 插件：**给 agent 用的结构化工具 + 在 DSH 设置里可配置**。

- Host 半边注册 4 个工具与 `agnes` 设置命名空间，视频任务后台轮询并落盘。
- Client 半边在 `settings.section` 注册一个设置页（API Key、模型、尺寸、输出目录、轮询参数）。
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

这些事实直接决定了实现：视频工具拒绝本地文件当首帧（改为先经一次图生图换取公网 URL，并在结果里标注画面被改写过）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `agnes_image` | 文生图 / 图生图（`images` 可传本地路径、data URI 或公网 URL） |
| `agnes_video` | 文生视频，或首帧驱动；返回 `task id`，`wait_ms` 可同步等待一段 |
| `agnes_task` | `list` / `status` / `wait` / `cancel` 跟踪视频任务（记录落盘，重启后仍可查） |
| `agnes_models` | 列出当前 key 可达的模型（排查「无可用通道」用） |

产出**立即下载落盘**：Agnes 的输出 URL 会过期，URL 本身不作为交付物。落盘顺序：会话工作区 `agnes-output/<日期>/` → `<DSH_HOME>/agnes-output/<日期>/`（前者不可写时回退，并在结果里标注）。

## 安装

用 DSH 自己的安装器，**不要手工把包目录拷进 `profiles/<profile>/node_modules`**：

```powershell
dsh plugin --profile web add dsh-agnes                   # 发布到 npm 之后
dsh plugin --profile web add file:D:\path\to\dsh-agnes   # 或直接从本地目录安装
```

装好后重启 DSH 让 profile 重新组合，然后打开 **设置 → Agnes** 填入 API Key（写入 DSH 凭据存储，不回显）。

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

# 传输层端到端（真实调用 Agnes）
$env:AGNES_API_KEY='cpk-...'; node scripts/smoke.mjs --video-wait
```

## 已知缺口（不假装已完成）

- **视频进度不在 DSH 任务面板**：`JobKindMap` 只承认 `bash | subagent` 两种 kind，插件无法注册自己的 job kind，因此改用进程内轮询 + 落盘任务记录（`<DSH_HOME>/storages/agnes/tasks.json`）。
- **`agnes_video` 的「首帧改写」是显式代价**：本地图必须先经一次图生图换公网 URL，画面会被轻微改动，结果里会写明。
- **不做自动降级**：模型不可用时把原文错误与处理建议交回，不改用其它模型（按你的决策）。
- **多图合成、2.5 的 keyframe（首尾帧）不在 v1**：前者被 API 拒绝，后者对当前 key 无通道。

## 密钥处理

API Key 只以**引用名**（默认 `AGNES_API_KEY`）出现在配置里，值存于 DSH 凭据存储；插件运行时 `ctx.credentials.resolve(ref)` 取用，日志与工具结果都不打印密钥。凭据文件里的值本身是结构化记录（`{kind, payload, version, secret}`），**不要手写**。

---
name: agnes
description: 用 Agnes AI 生成或编辑图片、生成短视频（文生图 / 图生图 / 文生视频 / 首帧驱动），产物直接下载落盘。当用户要求「画一张图 / 生成图片 / 改这张图 / 做一段视频」时使用。
---
# Agnes 图像 / 视频

Agnes 的能力由命令行提供；**配置在 DSH 的 设置 → Agnes 里**（API Key、默认模型、尺寸、输出目录），命令本身只负责执行。

所有命令形如：

```
node "{{CLI}}" <command> [flags]
```

## 命令

| 命令 | 用途 | 常用参数 |
| --- | --- | --- |
| `image` | 文生图 / 图生图 | `--prompt <文本>`（必填）、`--images a.png,b.jpg`（本地路径 / data URI / 公网 URL）、`--size 1K｜2K｜3K｜4K｜1024x1024`、`--aspect 16:9`、`--model <id>`、`--out <目录>` |
| `video` | 文生视频 / 首帧驱动 | `--prompt <文本>`（必填）、`--image <公网URL｜本地路径>`、`--seconds 5`、`--size 720P`、`--aspect 16:9`、`--model <id>`、`--wait[=毫秒]` |
| `task` | 视频任务跟踪 | `task list`、`task status --id <id>`、`task wait --id <id> [--wait-ms 毫秒]`、`task cancel --id <id>` |
| `models` | 列出当前 key 可达的模型 | 无 |
| `config` | 显示解析后的配置（不含密钥值） | 无 |

示例：

```
node "{{CLI}}" image --prompt "雨夜霓虹下的古镇，湿石板反光，国风插画" --size 2K --aspect 16:9
node "{{CLI}}" image --prompt "改成线稿风格，保留构图" --images ./photo.png
node "{{CLI}}" video --prompt "无人机掠过雪山，缓慢推近" --seconds 5 --size 720P --wait=180000
node "{{CLI}}" task status --id <taskId>
node "{{CLI}}" models
```

## 输出与交付

- **stdout 只有一个 JSON 对象**（过程信息走 stderr）。成功看 `ok: true` 与 `files` / `task.file`；失败是 `{ ok: false, error, kind, hint }` 且退出码 1。
- **交付物是落盘的绝对路径**，不是 URL：Agnes 的输出 URL 会过期。把 `files` 里的路径告诉用户（图片可用 `![](路径)` 直接展示）。
- 落盘顺序：`--out` → 设置里的「输出目录」→ `<当前工作目录>/agnes-output/<日期>/` → `<DSH_HOME>/agnes-output/<日期>/`。结果里的 `fellBack: true` 表示首选目录不可写、已回退。

## 需要知道的坑

- **视频是异步的**：`video` 默认只提交并返回 `task.taskId`，`task wait --id` 才会等到完成并落盘。大分辨率视频约 1–2 分钟；1K 图片约 10–16 秒。
- **首帧只接受公网 URL**：`--image` 传本地文件时，命令会先经一次图生图换取公网 URL，**画面会被轻微改写**，结果里 `restagedFirstFrame: true` 会标注。
- **模型可用性随 key 变化**：报 `no available channel` / `queue_full` 时，用 `models` 看当前可达模型（本机实测 `agnes-video-2.5` 常无通道，`agnes-video-v2.0` 稳定）。
- **不要并发刷任务**：视频队列会满（`queue_full`），命令内部已按设置里的重试次数退避重试。
- 密钥由插件宿主写在本机 `<DSH_HOME>/storages/agnes/api-key`（仅本人可读）；环境变量 `AGNES_API_KEY` 优先级更高。

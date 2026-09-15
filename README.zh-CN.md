# pi-bg-tasks

[English](README.md)

[pi coding agent](https://github.com/badlogic/pi-mono) 的后台任务工具:长命令不阻塞会话,任务结束时结果自动推送回来。

## 亮点

- **上下文注入共 ~330 token。** 实测静态注入:两个工具定义 + 一行式 promptSnippet ≈ **331 tok/请求**(chars/4 口径,echo 抓包法)。社区同类包 [`pi-background-tasks`](https://www.npmjs.com/package/pi-background-tasks) 实测 ≈ 5,000 tok(11 个工具)——**轻 ~15 倍**。
- **只有两个工具。** `bg_run` + `bg_tail`。没有 slash 命令、没有 widget、没有配置面,不给模型添乱。
- **零依赖,单文件。** 一个 ~260 行的 TypeScript 文件,`typebox` 和 pi API 都是 pi 内置打包——复制到扩展目录就能用,连包管理都不需要。
- **即发即忘。** 工具描述明确告知模型"结果会自动推送,勿轮询"——不浪费 turn 去查任务状态。任务退出时以 steering 消息自动触发一个 turn,模型立刻看到结果。

## 这是什么?

pi 内置 `bash` 工具会阻塞 agent 直到命令退出。对 dev server、构建、watcher 这类长任务,要么干等,要么逼着模型轮询。

`pi-bg-tasks` 只加两个自定义工具:

| 工具 | 用途 |
|---|---|
| `bg_run` | 后台启动命令,立即返回任务 id 和日志路径 |
| `bg_tail` | (兜底)读取任务状态和输出尾部 |

任务退出时,扩展把最后 4 KB 输出作为消息推进会话并触发 turn——模型不用被问就知道结果。

## 安装

```bash
pi install git:github.com/35iter-cn/pi-bg-tasks
```

重启 pi 后 `bg_run` / `bg_tail` 两个工具自动可用。

**免安装试用:**

```bash
pi -e git:github.com/35iter-cn/pi-bg-tasks
```

仅当前会话加载,不写入 settings。

**手动(单文件):**

不想引入包管理的话,把
[`extensions/bg-run.ts`](extensions/bg-run.ts)
复制到 `~/.pi/agent/extensions/` 即可。零依赖——`typebox` 与 pi API 均由 pi 内置。

后续更新:

```bash
pi update --extensions
```

## 工具说明

### `bg_run`

| 参数 | 类型 | 说明 |
|---|---|---|
| `command` | string,必填 | 要后台执行的 shell 命令(经 `/bin/sh -c`) |
| `name` | string,可选 | 任务短名;缺省取命令前几个词 |
| `timeoutSeconds` | number,可选 | 超时秒数,到点强杀。默认 1800,上限 86400 |

立即返回任务 id、pid 和日志路径。

### `bg_tail`

| 参数 | 类型 | 说明 |
|---|---|---|
| `id` | string,必填 | 任务 id(或无歧义前缀) |
| `bytes` | number,可选 | 日志尾部最大字节数。默认 4096,上限 65536 |

运行中读取限频为 30 秒一次,抑制轮询。

## 工作原理

- 输出写入 `~/.pi/agent/bg-tasks/<timestamp>-<id>.log`;会话启动时自动清理 7 天前的旧日志。
- 进程以 detached 方式跑在独立进程组,超时先 `SIGTERM`、5 秒宽限后 `SIGKILL` 整组击杀。
- 任务退出时,把带 4 KB 输出尾部的完成消息以 `triggerTurn` 的 steering 消息送达,agent 即时接手。
- 会话替换安全:`/new`、fork、切换会话或 `/reload` 期间任务结束,过期通知会被静默丢弃而不是崩掉 pi;日志仍在磁盘,`bg_tail` 随时可查。

## FAQ

**和内置 bash 工具有什么区别?**
`bash` 阻塞整个 turn;`bg_run` 立即返回、结果后推,agent 保持响应,不烧轮询 turn。

**支持 Windows 吗?**
不支持。命令经 `/bin/sh` 执行,仅 POSIX 系统。

**安全吗?**
它以你的用户权限运行任意 shell 命令,和 pi 内置 bash 一致。pi 扩展通用安全提醒同样适用:安装前审阅源码。

**会撑大上下文吗?**
实测每请求静态注入约 330 token,即两个紧凑的工具定义。见[亮点](#亮点)。

## License

[MIT](LICENSE)
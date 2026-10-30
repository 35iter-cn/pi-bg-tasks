# pi-bg-tasks

[English](README.md)

[pi coding agent](https://github.com/badlogic/pi-mono) 的后台任务工具:长命令不阻塞会话,任务结束时结果自动推送回来。

## 亮点

- **三个核心工具共 ~800 token 静态注入。** 按 snippet + guidelines + description + 参数 schema 计,4 字符算 1 token。其中约一半是系统提示 Rules 段里的 guidelines——就是阻止模型把服务丢进前台 bash 的那部分;两个运维工具(`bg_list`、`bg_gc`)各是一小段描述。
- **五个工具,三个是主力。** 日常循环用 `bg_run` + `bg_tail` + `bg_stop`;要接手或回收上一个会话留下的任务,用 `bg_list` / `bg_gc`。没有 slash 命令、没有 widget、没有配置面。
- **零依赖,单文件。** 一个 TypeScript 文件,`typebox` 和 pi API 都是 pi 内置打包——复制到扩展目录就能用,连包管理都不需要。
- **单轮会话也活得过。** `--print` / `json` / `rpc` 模式下会话可能几秒就退出;它起的任务继续在硬 `timeout` 看门下跑,结果在下一次会话启动时补齐。
- **即发即忘,但服务除外。** 描述只给模型一条判断规则(~10 秒及以上放后台),并说明完成结果会作为独立消息回来——交互式与一次性会话的启动回执完全一致。服务永不退出,所以就绪以日志为准:`bg_tail` 读一次,只有日志里没有就绪行时才补一次有界端口探测;也明确禁止把启动放一个调用、把检查放另一个调用(同批串行,检查根本不会启动)。

## 这是什么?

pi 内置 `bash` 工具会阻塞 agent 直到命令退出。对 dev server、构建、watcher 这类长任务,要么干等,要么逼着模型轮询。

`pi-bg-tasks` 加五个自定义工具:

| 工具 | 用途 |
|---|---|
| `bg_run` | 后台启动命令,立即返回任务 id 和日志路径 |
| `bg_tail` | (兜底)读取任务状态和输出尾部 |
| `bg_stop` | 停止任务——本会话的,或上一个会话留下的孤儿(整组击杀) |
| `bg_list` | 列出本机所有任务,含已消失会话启的那些 |
| `bg_gc` | 回收无主或已过 deadline 的任务 |

任务退出且会话还能收消息时,扩展把最后 4 KB 输出作为消息推进会话并触发 turn——模型不用被问就知道结果。

## 会话生命周期

- **回收跟随运行模式。** 交互式(`tui`)会话关掉时,仍会杀掉自己起的全部任务;一次性运行(`--print`、`json`、`rpc`,也就是各种聊天桥的跑法)关掉时**不杀**,只在台账里记下 owner 已退出,结果留到下一次会话启动时报告。
- **每个任务都有硬 deadline。** 命令跑在 `timeout -k 5 <timeoutSeconds>` 之下,即使起它的 pi 进程早就没了,到点照样死;超时会整组击杀,连包装层没亲自 fork 的孙进程一起收。
- **状态落盘,不靠进程内存。** `~/.pi/agent/bg-tasks/<id>.json`(台账:pid、pgid、`starttime`、deadline、owner、回收策略、状态)与 `<id>.exit`(退出码 + 结束时间)。退出事件能跨进程可见,靠的就是这两份文件。

## 安装

```bash
pi install git:github.com/35iter-cn/pi-bg-tasks
```

重启 pi 后 `bg_run` / `bg_tail` / `bg_stop` / `bg_list` / `bg_gc` 五个工具自动可用。

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
| `timeoutSeconds` | number,可选 | 超时秒数,到点强杀。默认 1800,上限 86400(要活过会话的服务传 86400——默认值是失控保底,不是寿命) |

立即返回任务 id、pid 和日志路径。

### `bg_stop`

| 参数 | 类型 | 说明 |
|---|---|---|
| `id` | string,必填 | 任务 id(或无歧义前缀) |

杀掉整个进程组(`SIGTERM`,1 秒宽限后 `SIGKILL`),并清除任务记录。能停本会话启动的任务,也能停上一个会话留下、仍记录在磁盘上的孤儿。

### `bg_tail`

| 参数 | 类型 | 说明 |
|---|---|---|
| `id` | string,必填 | 任务 id(或无歧义前缀) |
| `bytes` | number,可选 | 日志尾部最大字节数。默认 4096,上限 65536 |

重复读取只返回上次读之后新增的内容,没有新增就直接说。

## 工作原理

- 输出写入 `~/.pi/agent/bg-tasks/<timestamp>-<id>.log`;会话启动时自动清理 7 天前的旧日志。
- 进程以 detached 方式跑在独立进程组,超时或 `bg_stop` 先 `SIGTERM`、1 秒宽限后 `SIGKILL` 整组击杀。超时强杀时,完成消息明确告知根因(到点被杀),提示模型若为常驻服务应用 `bg_run` 加更大的 timeoutSeconds 重启。
- **任务归属于启动它的会话**:会话关闭(`/new`、切换、fork、恢复、退出 pi)时,`session_shutdown` 会杀掉该会话启动的全部任务;其他并行 pi 实例的任务不受影响。
- 任务退出时,把带 4 KB 输出尾部的完成消息以 `triggerTurn` 的 steering 消息送达,agent 即时接手。
- 会话替换安全:`/new`、fork、切换会话或 `/reload` 之后,过期通知会被静默丢弃而不是崩掉 pi;日志仍在磁盘,`bg_tail` 随时可查。注意:`/new` 等会话替按设计会先杀本会话任务,此时收到的是被杀后的退出通知。

## FAQ

**和内置 bash 工具有什么区别?**
`bash` 阻塞整个 turn;`bg_run` 立即返回、结果后推,agent 保持响应,不烧轮询 turn。

**支持 Windows 吗?**
不支持。命令经 `/bin/sh` 执行,仅 POSIX 系统。

**安全吗?**
它以你的用户权限运行任意 shell 命令,和 pi 内置 bash 一致。pi 扩展通用安全提醒同样适用:安装前审阅源码。

**会撑大上下文吗?**
实测每请求静态注入约 800 token(snippet + guidelines + description + schema),即三个紧凑的工具定义。见[亮点](#亮点)。

**pi 退出后任务还活着吗?**
不。任务归属于会话:会话正常关闭(包括退出 pi)时任务被连带杀掉。仅在 pi 被 SIGKILL/断电这类无法走清理路径的场景下,进程组会残留——属主已死,可在下个会话用 shell 手动清理。

## License

[MIT](LICENSE)
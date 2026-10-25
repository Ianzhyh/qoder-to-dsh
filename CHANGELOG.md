# Changelog

本项目所有值得注意的变化都记录在这里。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 维护约定（发版步骤）

1. `npm run release:check` 全绿：`check`（全部模块语法）+ `test`（全部用例）+
   `verify --offline`（文件与 profile 配置）。
2. 把本次变化写成下面的新版本条目（`## [X.Y.Z] - YYYY-MM-DD`，分类用
   `### Added / Changed / Fixed / Docs / Tests`，条目以 `- **短语**：` 开头）。
3. 版本号必须同步两处：`package.json` 的 `version` 与 `lib/config.mjs` 的
   `VERSION`。`npm run verify:release` 会校验两者与 tgz 内一致。
4. `npm run pack:release` 生成 tgz → `npm run verify:release [tgz]` 校验产物、
   核对文件清单并取 SHA-256。
5. `git tag vX.Y.Z` 推送；`gh release create vX.Y.Z ./qoder-to-dsh-X.Y.Z.tgz`
   附上资产，正文取 `docs/releases/vX.Y.Z.md`。
6. 可选：`npm publish`，让 `dsh plugin add qoder-to-dsh` 这条最短路径可用
   （registry 上目前未占用该包名）。

## [1.1.3] - 2026-10-25

这一版集中修流结束、令牌刷新、换号与本地账本之间的竞态。

### Fixed

- **上游半路关流又被补成成功**：外层信封翻译在流自然关闭时无条件补 `[DONE]`，
  绕过了 1.1.1 的截断判断。现在只有见到 `finish_reason` 或显式 `[DONE]` 才补；
  试跑走同一条判断，半截回复不再显示为连通成功。实机探针确认正常流仍以 `stop`
  收尾。
- **并发刷新会拿同一个 refresh token 轮换两次**：`refreshAuth()` 现在单飞合并，
  并用 `authGeneration` 隔离账号切换；旧账号的刷新结果不能覆盖新账号，也不会
  再被 `ensureAccessToken()` 误报成换号。
- **无 UID 的令牌刷新被当成换号**：刷新沿用的仍是同一个 auth 对象时保留身份，
  不再清额度或误报账号已切换。
- **导入无效 PAT 会退出原账号且仍报 ready**：直接令牌现在会校验 userinfo；
  401/403 时回滚到原账号，不会把有效登录态删掉，也不再重复触发两次 auth-change。
- **设备授权轮询重叠**：同一 pending 会话的并发轮询合并成一次上游请求。
- **目录磁盘缓存只按区域**：缓存 schema 升到 5 并记录 account；换号后重启不会
  把上一个账号的模型目录当成当前缓存。
- **清除用量被在途写盘复活**：清理期间完成的旧快照会被删除；有新 state 接管时
  不误删新数据。
- **试跑取消只停了前端**：面板请求中断现在会通过 `AbortSignal` 传到宿主与上游，
  取消不再继续等待或计费。
- **签到跨账号使用新令牌**：一次签到运行绑定启动时的 auth generation；期间换号
  不会拿新账号令牌去领取旧账号的活动。
- **换号瞬间仍显示旧账号**：auth-change 时清空主面板 status 与对话页额度胶囊，
  避免旧账号信息在新账号请求返回前继续显示。

### Tests

- 新增回归：截断信封流不补 `[DONE]`、有 `finish_reason` 无 `[DONE]` 仍正常收尾、
  试跑拒绝半截流、并发刷新单飞、旧账号刷新不得覆盖新账号、无 UID 刷新不误判、
  无效 PAT 回滚、设备轮询合并、目录缓存按账号隔离、清除用量竞态。
- 111 个用例通过；`npm run test:live` 实机探针返回 `pong` / `finish=stop`；
  `verify:release` 15 项通过。

## [1.1.2] - 2026-10-25

这一版补的是面板在「宿主刚启动 / 标签页在后台 / 账号刚切换」三种真实状态下的行为。

### Fixed

- **启动窗口的 404 不再挂到下一轮轮询**：dsh 的 Web 兜底处理器在插件路由挂上之前
  会对任何未命中路径回 404。刷新页面正好撞上这个窗口时，`getJson` 现在对
  `/qoder/` 的 GET 快速重试（350 / 800 / 1300ms）；仍然 404 时明确提示
  「完全退出并重启 dsh」，而不是只显示一句 HTTP 404。POST 不重试（避免签到
  这类动作被重复执行），但仍会给出同样的重启提示。
- **换账号后旧账号的在途响应不再覆盖新账号**：面板的 models / status / checkin /
  diagnostics 与对话页额度胶囊都加了请求序号，只有最新一次请求能落地；换号时
  同步清空旧模型与试跑模型。宿主端 `refreshExtras()` 也按 `extrasGeneration`
  隔离，旧账号的在途额度请求不会写进新账号缓存，新账号也不会复用旧 Promise。
- **后台标签页不再空转轮询**：设置页的状态 / 用量 / 账号 / 签到与对话页额度胶囊
  统一走可见性调度器。隐藏时停表，切回可见立即补一次再恢复定时；初始就在后台的
  页面会在第一次可见时启动（不会永久停更），重复的 `visibilitychange` 事件不会
  触发多轮请求。
- **超大面板请求体的 413 能被读到了**：`readJsonBody` 超过 256KB 上限时原本直接
  抛错退出，Node 会销毁请求流，客户端可能在读到 413 之前先收到 `ECONNRESET`。
  现在继续把剩余字节读掉再回 413；存入内存的部分仍以 256KB 为上限。

### Changed

- **发版校验不再被旧产物绊倒，也会拒绝过期产物**：`npm run verify:release`
  在没有参数时会选择与当前 `package.json` 版本一致的那份 tgz，并列出被忽略的
  旧版本；同一版本出现多份时仍然拒绝猜。选中本地产物后还会逐字节对比工作区，
  版本号相同但忘了重新 `pack` 会直接失败。显式传 tgz 路径或 URL 时不做这项比较。
  以前目录里留着一份旧 tgz 就会直接判失败，而版本没变的过期产物反而能混过去。

### Tests

- 新增 `tests/client.test.mjs`：用 vm 加载真实客户端 bundle，覆盖启动窗口 404
  重试、POST 不重试、重试耗尽提示、后台暂停 / 恢复 / 事件风暴 / 初始隐藏。
- `tests/qoder-api.test.mjs` 新增「换号时旧额度请求不得覆盖新缓存」的回归。
- 100 个用例通过；`verify:release` 15 项通过。

## [1.1.1] - 2026-10-25

这一版的三个修复都来自同一条判断标准：**能被上游确定性拒绝、或能被静默吞掉的问题，不该留到线上才暴露。**

### Fixed

- **断流被当成正常结束**：上游在半路关连接（有内容、没有 `finish_reason`、也没有
  `[DONE]`）时，`mapFinishReason` 落到 default 分支，只要有内容就返回 `stop`。
  结果是半截回答被当作成功：DSH 不重试，用户也不知道少了一段。现在区分「明确的
  收尾」与「没有收尾」——缺 `finish_reason` 又缺 `[DONE]` 一律以 `TRANSPORT` 结束，
  计数器按失败记账。只发 `[DONE]` 不填 `finish_reason` 的网关仍按正常结束处理。
- **工具名不合法时整轮失败且不说是哪个工具**：Qoder 网关对含点号、斜杠、空格或
  超过 64 字符的工具名回确定性 400，错误里通常不点名。现在在发往上游之前校验，
  错误消息直接指出是哪个工具、为什么不行。历史里重复带同一批工具仍按去重处理，
  不算错。
- **面板请求没有超时**：宿主半死时 `fetch` 可以一直挂着，按钮永远 busy。数据请求
  统一 20 秒超时并给出可读原因；试跑那条路径沿用调用方的取消信号，不受影响。

### Tests

- 91 个用例通过。
- 新增回归：截断流归 `TRANSPORT`、`[DONE]` 单独出现算正常收尾、工具名校验
  （合法名 / 点号 / 空格 / 超长 / 历史重复）。

## [1.1.0] - 2026-10-25

### Added

- **聊天 SSE 走持久连接**：新增 `lib/chat-transport.mjs`，用 keep-alive Agent
  代替 Node `fetch`（undici 默认约 4 秒回收空闲连接）。两条消息间隔通常超过
  4 秒，旧路径等于每条消息重做一次 TCP + TLS 握手；服务端主动断开时仍正常重连。
  插件卸载/热重载时由 `disposeChatTransport()` 释放空闲连接。
- **模型目录先返回、过期后台刷新**：命中缓存时 `prepareCall` 只是内存查表，
  过期只触发后台刷新，并发调用合并成一次；显式刷新仍等待上游。新增
  `onCatalogUpdated`，后台刷新拿到新目录后通知 DSH 选择器更新。
- **启动不在主线程扫本机账号**：桌面端 DPAPI key 改为后台子进程预热
  （`prewarmDesktopKeysAsync`），首次签到或账号页才读取候选账号；启动预热的判据
  从 `status().signedIn` 改为 `client.auth`，不再为了一个布尔值阻塞启动。
- **凭据异步写盘**：`writeEncryptedJsonAsync` 把 PowerShell DPAPI 调用放到子进程，
  Windows 上不再占用主事件循环；DPAPI 不可用时仍退回 AES-256-GCM + 本机 0600 密钥。
- **用量记录合并异步落盘**：同一次进程内的多条记录先合并，再异步写入，
  不阻塞消息结束；正常退出时同步补写。
- **请求体签名编码走 Buffer 码表**：编码热路径不再逐字符做 Map 查找和字符串拼接，
  签名改为分段哈希，避免为算 MD5 把整个编码后的请求体拼成一个大字符串。
- **聊天模板不再保留 59KB 副本**：`messages` / `tools` 每次请求都被真实内容整体
  替换，模板里不再留存一份完整的 base prompt 副本。
- **`status({ desktop })` 分离**：诊断页与四个只读工具不再触发本机账号扫描，
  只有面板、账号页这类需要候选账号的路径才扫。

### Changed

- `npm run check` 纳入 `lib/chat-transport.mjs`。
- 新增 `npm run pack:release`、`npm run verify:release`、`npm run release:check`，
  发版前可校验 tgz 的文件清单、版本一致性与 SHA-256。

### Fixed

- **账号切换后旧目录覆盖新账号**：切换或退出时在途的目录请求仍会返回，旧结果
  过去可能盖掉新账号的目录。现在按目录 generation 丢弃，并允许新账号立即发起
  自己的刷新。
- **自动签到不再触发本机账号扫描**：签到路径改用 `client.auth` 直接取当前账号与
  区域，不再调用会扫描本机账号的 `status()`，避免定时任务阻塞事件循环。

### Tests

- 新增 `tests/transport.test.mjs`：keep-alive 连接复用、SSE 逐帧下发、
  挂起请求的中止与 socket 释放。
- `tests/qoder-api.test.mjs` / `tests/state.test.mjs` / `tests/sign.test.mjs`
  补充目录 generation、用量合并写、Buffer 码表编码与码表外字符的等价性回归。
- 87 个用例通过。

## [1.0.2] - 2026-10-25

### Added

- **试跑新增「本次思考档位」**：只影响这一次试跑，不写回全局模型偏好；默认使用
  模型支持的最低档，避免一次连通性检查先等十几秒思考。
- 试跑结果显示 tok/s、首字 / 生成耗时拆分、思考 tokens，并在明显偏慢时给出提示；
  服务端校验档位，不支持的值不会发往上游。

### Fixed

- 试跑在思考强度为最高档时的等待过长（实测 GLM-5.3-Flash 短请求：max 档约 18s，
  high 档约 1.3s）。

### Tests

- 78 个用例通过；安装自检 11/11。

## [1.0.1] - 2026-10-25

### Fixed

- **MiniMax-M3.1-Flash 等上游返回字面量 `data: null` 时崩溃**：试跑 / 流式解析抛出
  `TypeError: Cannot read properties of null (reading 'error')`。上游转发层现在丢弃
  null 与非对象 SSE 帧，试跑解析层与多模态流翻译层增加 null 保护。
- 字符串形式的 `error` 帧过去被静默忽略，现在会显示为可见错误。

### Tests

- 新增 null 帧回归用例，77 个用例通过；MiniMax 实机返回 `pong`。

## [1.0.0] - 2026-10-25

首个正式版。

### Added

- 原生 `provider=qoder`：通过 `ctx.llm.registerAdapter` 接入，模型直接出现在 DSH
  选择器里；单进程、无中转端口、无额外客户端。
- 模型目录：200K / 400K / 1M 上下文档位、自动输出 32K、思考档位与价格倍率。
- 多账号、额度、每日签到；Credits 以 `usage.billable` 为准，只计实际扣费，
  免费与折扣显示为「已省」。
- 设置面板七页签：概览 / 签到 / 模型 / 试跑 / 用量 / 账号 / 诊断。
- 明暗主题跟随 DSH、窄屏适配、键盘与触控路径，失败态可就地重试。
- 四个只读工具与 `/qoder` 斜杠命令。

### Tests

- 74 个用例通过；安装自检 11/11。

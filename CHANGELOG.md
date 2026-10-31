# Changelog

本项目所有值得注意的变化都记录在这里。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## 维护约定（发版步骤）

1. `npm run release:check` 全绿：`check`（全部模块语法）+ `test`（全部用例）+
   `verify --offline`（文件与 profile 配置）。
2. 把本次变化写成下面的新版本条目（`## [X.Y.Z] - YYYY-MM-DD`，分类用
   `### Added / Changed / Fixed / Docs / Tests`，条目以 `- **短语**：` 开头）。
3. 版本号必须同步 `package.json`、`lib/config.mjs`、README 顶部、CHANGELOG 与
   `docs/releases/vX.Y.Z.md`。`tests/install-contract.test.mjs` 与
   `npm run verify:release` 会校验这些位置。
4. `npm run pack:release` 生成 tgz → `npm run verify:release [tgz]` 校验产物、
   核对文件清单并取 SHA-256。
5. `git tag vX.Y.Z` 推送；`gh release create vX.Y.Z ./qoder-to-dsh-X.Y.Z.tgz`
   附上资产，正文取 `docs/releases/vX.Y.Z.md`。
6. 可选：`npm publish`，让 `dsh plugin add qoder-to-dsh` 这条最短路径可用
   （registry 上目前未占用该包名）。

## [1.3.1] - 2026-10-31

这一版收口「看起来成功 / 看起来正常」的边角：网关故障切换不再挂死，取消与换号不再被当成可重试故障，凭据落盘失败会如实报错；面板读接口重新纳入跨站保护，图表切区间失败会明确标注仍在展示旧数据。设置面板同时完成一轮动效、材质与字阶打磨。

### Added

- **面板动效与材质**：弹簧曲线、按下反馈、玻璃浮层、可逆退场动画、rem 字阶（跟随
  浏览器字号）、图表指引线 1:1 跟手与键盘同步；账号切换面板与下拉菜单支持退场
  途中重新打开。
- **降级**：尊重 `prefers-reduced-motion` 与 `prefers-reduced-transparency`；
  深色主题和窄屏布局保持一致。

### Changed

- **面板读接口纳入跨站保护**：`/qoder/account` 与 `/qoder/models` 会触发上游额度/
  目录请求甚至凭据写入，现在和写接口一样要求 `x-qoder-panel: 1`；面板与对话页
  胶囊会自动携带。
- **凭据写入不再静默失败**：`flushAuthWrite()` 会把最后一次落盘错误抛给登录流程，
  不再提示成功但重启后丢失登录。
- **授权轮询不再等目录刷新**：设备授权成功先返回，目录在后台刷新，避免客户端
  先超时误报“授权超时”。
- **深刷新优先**：账号页“重新扫描”期间暂停 25 秒浅轮询，深结果不会被序号作废。
- **试跑预算校验**：拒绝 `Infinity` / 小数 `maxTokens`，控制器再兜底取整。

### Fixed

- **网关故障切换可永久挂起**：5xx 响应被 drain 后仍被当成可读响应，后续网关传输
  失败时 `text()` 永远等不到结束；现在清空旧响应并抛出最后的错误。
- **取消/换号被当成可重试故障**：客户端干净关流时适配器只按“缺少 finish_reason”
  判成 `TRANSPORT`；现在按取消/账号代次纠正为 `ABORTED`，用量记 `aborted`。
- **半截工具参数误报参数错误**：干净 EOF 时先命中 `toolIssue` 报 `INVALID_REQUEST`；
  现在断流判定优先，返回可重试的 `TRANSPORT`。
- **PAT 导入假成功**：userinfo 网络/5xx 失败时仍报 ready 且不落盘；现在任何验证
  失败都回滚并报“令牌验证失败”。
- **日限被当成排队限流**：带 `retryAfterSeconds` 的 110 日限现在优先识别为额度
  错误，不再被宿主重试。
- **错误分类误伤**：`context deadline exceeded` 归为 `TIMEOUT`，`frequency_penalty`
  不再被当成限流；补充 500 内超时识别。
- **目录 200 错误信封被当空目录**：缺少 `chat` 数组时直接报错，不再静默清空模型
  选择器。
- **0 Credits 已领取被报错**：上游确认 `CLAIMED` / `ALREADY_CLAIMED` 时即使金额为
  0 也按已领取记录，自动签到不再每 20 分钟重试。
- **umid 选中旧版本**：`.qoder-versions` 改为数字段排序，1.10.0 不再输给 1.9.0。
- **credits 区间原型键**：`?range=constructor` 等不再命中原型链，回退到 7 天。
- **DST 分桶跳天**：用量统计改按日历日回退，不再用固定 24 小时。
- **图表指引线/区间失败态**：切换区间后旧 hover 不再留下悬空指引线；区间请求失败
  时保留旧数据并明确提示“当前仍显示 X 的数据”。
- **StrictMode/键盘细节**：`mounted` ref 在重挂载时复位；`usePresence` 的 `duration`
  纳入依赖；确认框取消后键盘焦点不再移动。

### Tests

- **206 个用例**：新增 17 个回归，覆盖网关切换、取消/换号、半截工具参数、日限/超时
  分类、目录错误信封、PAT 瞬时失败、凭据落盘失败、0 Credits 签到、umid 版本排序、
  credits 原型键、路由面板头与试跑预算。
- **面板实测**：离线 CDP 验证动效、图表 1:1 跟手、区间切换失败态、对话页胶囊额度；
  console errors 0。

## [1.3.0] - 2026-10-26

这一轮参考了 `qoder2api-hub`、`pi-provider-qoder`、`masknull/dsh-qoder-connect`、
`workbuddy-to-dsh` 等项目的 issue：高频故障不是缺功能，而是错误码被误读、
空白回复被当成功、界面显示与真实状态不一致。

### Added

- **Qoder 错误语义层**：新增 `lib/upstream-error.mjs`，解析 10605 排队（含转义 JSON）、
  110 日限、112 额度、105/12153 会话问题、430 版本门、内容审核与 114 试用受限；
  `providerRetryAfterMs` 从 body/header 透传给 dsh 重试器（上限 60 秒）。
- **完成度校验**：只有 reasoning、没有正文/工具调用时以 `EMPTY_RESPONSE` 结束；
  `length` 且无可见内容同样报错；空工具名、非法工具名、参数不是完整 JSON 时
  阻止写入会话并报 `INVALID_REQUEST`。
- **工具 id 防撞**：上游缺 `tool_call.id` 时使用每个 translator 唯一的前缀，不再固定
  `call_0`；上游真实 id 优先。
- **版本漂移提示**：面板对比已加载 `VERSION` 与磁盘 `package.json`，不一致时顶部
  banner 与诊断项提示“完全退出 dsh 再打开”。
- **体验标签**：用量明细显示试跑/账号尾号；额度/用量页脚标出“部分历史来自每日
  汇总”；账号页显示“插件当前使用 X；本机检测到 N 个账号”，PAT/浏览器授权账号
  会说明不在桌面端列表。

### Changed

- 首包默认超时 45 秒 → **90 秒**（Qoder 首 token 实测可达 40–70 秒）。
- 额度诊断：无额度数据从 pass 改为 warn；`remaining: 0` 现在会如实写入 0，
  不再保留旧 Credits。
- 设置保存提示改为“下一次请求生效”；仅在选择器元数据无法广播时提示需完全退出
  dsh，不再把请求参数误说成必须重启。
- 面板额度为 0/缺失时显示 `0` / `—`，不再把 0/0 当成有效额度。

### Fixed

- **10605 被当普通限流快速重试**：现在识别为模型排队，优先使用 `retryAfterSeconds`
  / `Retry-After`，401/403 时不再刷新令牌。
- **110 日限被当未知错误**：归为不可重试的额度错误，并提示“今日请求次数已用完”。
- **430 / 12153 / 数据审核 / 试用受限**：给出可行动文案，不再落入通用参数错误。
- **签到结论被 summary 覆盖**：通知统一由 `checkinNotice` 生成，部分失败、pending、
  unavailable 原样呈现，不再只显示“签到完成”。

### Tests

- 184 个用例通过；新增 upstream-error、错误分类、reasoning-only、工具参数/名称/
  id、`Retry-After`、额度 0、版本/设置/用量/账号/签到文案回归。
- `release:check`、`verify:release` 全绿。

## [1.2.1] - 2026-10-26

第二轮收口「静默失败与取消传播」：后台目录刷新失败不再只写日志；诊断工具与
面板诊断会响应宿主取消；签到在插件卸载后不会继续为剩余账号发请求。

### Fixed

- **后台目录刷新失败不可见**：`QoderClient` 新增 `onCatalogError`，失败时同步
  `state.catalogError` 与 adapter 缓存；成功刷新会同时清除两处错误。此前面板
  会一直显示旧目录，用户不知道后台刷新已经失败。
- **诊断不能取消**：`qoder_diagnose` 与 `/qoder/diagnostics` 现在把宿主的
  `AbortSignal` 传到目录刷新和额度读取；客户端断开时服务端停止继续等待。
  `client.refreshExtras({ signal })` 也支持调用方取消。
- **签到卸载后继续跑**：插件 dispose 会 abort 签到信号，账号循环在下一个账号前
  停止；已完成的领取仍会记录并落盘，未发出的请求不再继续。
- **签到请求无法取消**：`claimCampaigns` 接受 `signal`，查询、领取与刷新令牌都
  使用合成信号 + 20 秒超时，取消后不再进入 500ms 重试。

### Tests

- 162 个用例通过；新增后台目录失败通知、签到取消、额度读取取消与
  `qoder_diagnose` 宿主取消的回归。

## [1.2.0] - 2026-10-26

这一版按「失败不能伪装成成功、数据不能跨账号」来收口：提前取消不再记成功，
换号/退出会取消在途请求，损坏的凭据不会静默换成另一个账号；用量历史与试跑
统计也分开保存，避免 12 个月热力图被明细上限截断。

### Added

- **每日用量汇总**：新增 `usage.daily.json`，按天保存 Credits / tokens / 请求与失败数，
  独立保留 430 天；明细仍只保留 5000 条。报表按天在明细与汇总之间二选一，不重复计数。
- **试跑单独分桶**：面板试跑与 `/qoder test` 写入 `probe: true`，不计入常规请求、
  失败与热力图统计，但保留在明细里；`creditsReport` 返回独立的 probe 汇总。
- **凭据恢复可见**：本地 `auth.json` 缺失、损坏、无令牌、导入失败分别记录到
  `status.authRestore`，诊断页新增「凭据恢复」检查；损坏时不会自动切换账号。
- **真实加密方式**：诊断与状态页读取凭据信封，DPAPI 失败回退 AES 时状态页显示
  AES-256-GCM、诊断页明确提示「本机密钥回退」，不再固定写成 DPAPI。
- **安装契约测试与 CI**：校验包名 = patch name = client 注册 id、exports 目标、
  locale 键、版本号与 README/CHANGELOG/发布说明一致；新增 Windows + Ubuntu 工作流。
- **README 排障手册**：补齐升级 / 回滚 / 卸载、故障排查、最低 dsh 基线、数据文件说明。

### Changed

- `resolveModel` 始终返回正整数的 `context.contextWindow`；目录缺元数据时统一回退
  到 `DEFAULTS.fallbackContextWindow`（131072），请求体的 `max_input_tokens` 不再用
  临时写死的 180000。
- `npm test` 改为 `node --test` 默认发现模式，避开 Windows cmd 不展开 glob、以及目录参数在部分 Node 版本被当成模块的问题。
- usage 记录新增 `account`（uid / 邮箱尾号）与 `probe` 字段。

### Fixed

- **提前取消被记成成功**：消费方在 `finish` 之前结束生成器时，用量现在记
  `aborted`、`ok:false`，不再污染成功率。
- **429 被误判为额度不足**：`classifyError` 先处理 402、408 与硬额度短语，再处理
  429；429 响应体里只是出现 “credits” 时仍按可重试的限流处理。
- **换号/退出不取消在途流**：`QoderClient` 登记在途请求，身份变化或登出时用
  `ACCOUNT_SWITCHED` 取消；适配器以 ABORTED 结束并保留旧账号用量戳，避免继续用
  旧账号计费却记到新账号。
- **损坏凭据静默换号**：`auth.json` 存在但无法解密时不再自动导入桌面端账号。
- **副作用 GET 无防护**：`?rescan=1`、`?refresh=1`、`?deep=1` 与诊断刷新必须带
  `x-qoder-panel: 1`；面板对应用户操作会自带该头。
- **额度链接协议注入**：`detailUrl` / `upgradeUrl` 只接受绝对 http(s)，渲染前再次过滤。
- **日志无限增长与脱敏缺口**：日志超过 2MB 轮转为 `qoder.log.1`；Bearer 令牌的
  `+/=` 与 `token=` 形式不再残留片段。
- **卸载残留**：插件卸载时取消在途聊天、清理图片缓存与定时器，并同步刷写
  usage 明细与每日汇总。

### Tests

- 新增 `request-guard`、`tools`、`install-contract`、`secret-store` 四组测试；覆盖提前取消、
  换号取消、损坏凭据、每日汇总迁移/修复/清除竞态、probe 排除、副作用 GET、
  `safeHref`、上下文回退与工具输出。
- 全部用例与发版门禁通过（以 `npm test` / `npm run release:check` 输出为准）。

## [1.1.4] - 2026-10-25

这一版集中修「设置看起来生效、实际没生效」的几处，以及账号切换、目录与令牌
之间的竞态；另外补上诊断、额度与试跑在慢网络和目录变化下的表现。

### Fixed

- **温度设置从未到达上游**：`buildChatBody` 只写了 `max_tokens` 与
  `reasoning_effort`，`payload.temperature` 被静默丢弃——面板保存的每模型温度、
  插件默认温度和试跑温度都只改了本地文件。现在数值温度会写进
  `parameters.temperature`（0 也是合法值）；「自动」仍然不传，由上游决定。
- **换号后模型目录仍可能是上一个账号的**：`setAuth` 在身份变化时同步清空目录
  缓存、`rawById` 与在途请求，旧账号的目录结果不会写进新账号。顺带移除了登录
  路径上重复的 `invalidateCatalog()`——它会把 `onAuthChange` 刚发起的预热请求
  判成过期，每次登录/换号白打一次上游目录。
- **官方客户端里的旧令牌可能覆盖插件刚刷新的令牌**：重读桌面端/CLI 存储时按
  「当前令牌是否可用 + 官方令牌是否明确更晚过期」决定是否跟随，并过滤已过期的
  候选；不再出现「采用旧令牌 → 401 → 再刷新」的循环。
- **目录响应中途断开会让 Promise 悬住或抛成未捕获异常**：`httpsJson` 补上响应
  流的 `error` 监听与单次 settle 保护，目录请求会明确失败并按网关重试。
- **流内错误帧丢失 HTTP 状态码**：错误帧里的 401 / 429 / 5xx 现在参与分类，
  认证失败不再被当成未知错误，限流与上游 5xx 仍能进入重试策略。
- **诊断与深度状态被客户端 20 秒超时截断**：诊断会同步刷新目录与额度，最坏
  情况超过 20 秒。`getJson` 支持按次设置超时，诊断与深度状态使用 90 秒。
- **额度到期显示成 1970 年**：上游额度/套餐到期时间是秒级 epoch，客户端现在按
  官方客户端的 `<1e10` 规则换算成毫秒；`dateLabel` 继续支持日期字符串。
- **对话页额度胶囊不跟随额度刷新**：status 与 `/qoder/account` 的 extras 按
  `at` 取更新的一份，`qoder:quota-changed` 推送的新额度不再被旧快照盖住。
- **试跑可能停在已下架的模型上**：目录刷新后模型数量不变但集合变化时，试跑按
  模型 id 集合而不是数组长度重置选择。
- **模型编辑器的「自动输出」显示错误**：插件默认高于模型上限时，面板显示 64K
  而实际请求被收敛到 32K；现在显示与实际请求使用同一条公式。
- **`/qoder` 不带子命令时报「未知子命令」**：空输入现在按 `status` 处理。
- **无效 PAT 回滚后目录被清空**：导入失败会把账号与目录快照一起还原，正在使用
  的账号不会因为一次粘贴错误短暂退化成最小模型配置。
- **DNS 失败被归成未知错误**：`getaddrinfo ENOTFOUND` / `EAI_AGAIN` 现在归入
  可重试的 `TRANSPORT`，离线或代理配错时能看到连接提示。
- **纯字符串消息内容被丢弃**：`toWireMessage` 把字符串内容当成单个 text block，
  user / tool / assistant 消息不会再变成空白。
- **目录没有时间戳时伪造新鲜度**：`adapter.catalog` 不再用 `Date.now()` 填充
  缺失的 `at`。
- **换号瞬间可能卡在「读取中」**：面板在 auth-change 时一并清掉账号 / 用量 /
  Credits 的 busy 标记。
- **切用量窗口会顺带重读整年 Credits**：拆成两个加载 effect，7 / 14 / 30 天与
  Credits 区间互不牵连。

### Changed

- **桌面端 `jt-` 令牌也能识别**：与 CLI 候选保持一致，不再只接受 `dt-`。
- **README 更正试跑取消行为**：1.1.3 起取消会通过 `AbortSignal` 传到上游，不再
  只是停止本地等待。

### Tests

- 新增回归：温度写入 `parameters`（含 0 与未设置）、换号清目录且不误清同账号
  刷新、无效 PAT 回滚目录、桌面端只跟随更新的令牌、目录响应中途断开、流内
  401 / 429 / 5xx 分类、`expires_in` 毫秒语义、字符串消息内容、DNS 错误归类、
  秒级额度到期、自动输出上限收敛、按次请求超时、空 `/qoder`。
- 123 个用例通过；`npm run verify -- --offline` 11/11。

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

import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.3.0';
export const PROVIDER = 'qoder';
export const DISPLAY_NAME = 'Qoder';

const here = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = resolve(here, '..');

export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
export const DATA_DIR = process.env.QODER_TO_DSH_HOME || join(DSH_HOME, 'qoder');

export const PATHS = Object.freeze({
  auth: join(DATA_DIR, 'auth.json'),
  prefs: join(DATA_DIR, 'prefs.json'),
  usage: join(DATA_DIR, 'usage.json'),
  usageDaily: join(DATA_DIR, 'usage.daily.json'),
  catalog: join(DATA_DIR, 'catalog.json'),
  checkin: join(DATA_DIR, 'checkin.json'),
  log: join(DATA_DIR, 'qoder.log'),
  key: join(DATA_DIR, '.key'),
});

/**
 * 双区常量。两种区域的上游路径一致，只有主域名和品牌不同；这里把
 * 「一个区域」抽象成一组候选网关，按顺序做故障切换。
 */
export const REGIONS = Object.freeze({
  global: {
    id: 'global',
    label: 'Qoder 国际版',
    origin: 'https://qoder.com',
    webOrigin: 'https://qoder.com',
    gateway: 'https://api3.qoder.sh',
    gateways: ['https://api3.qoder.sh', 'https://api2.qoder.sh', 'https://api1.qoder.sh'],
    oauthBase: 'https://openapi.qoder.sh',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    redirectUri: 'qoder://aicoding.aicoding-agent/login-success',
    appDir: 'com.qoder.app.stable',
    homeDir: '.qoder',
    ua: 'Qoder/1.1.75',
    nonceDashed: false,
    sendRedirectUri: false,
  },
  cn: {
    id: 'cn',
    label: 'Qoder 国内版',
    origin: 'https://qoder.com.cn',
    webOrigin: 'https://qoder.com.cn',
    gateway: 'https://gateway.qoder.com.cn',
    gateways: ['https://gateway.qoder.com.cn'],
    oauthBase: 'https://openapi.qoder.com.cn',
    clientId: '1c5e33e1-364d-4ce6-b02c-acaa81274a5c',
    redirectUri: 'qoder-work-cn://',
    appDir: 'com.qodercn.app.stable',
    homeDir: '.qoder-cn',
    ua: 'QoderWork/1.1.75',
    nonceDashed: true,
    sendRedirectUri: true,
  },
});

export const DEFAULT_REGION = process.env.QODER_REGION === 'cn' ? 'cn' : 'global';

export const DEFAULTS = Object.freeze({
  region: DEFAULT_REGION,
  /** 面板与模型目录的自动刷新间隔（毫秒）。 */
  catalogTtlMs: 5 * 60 * 1000,
  /** 单次调用允许等待上游首包的最长时间：Qoder 首 token 实测可达 40–70 秒。 */
  firstByteTimeoutMs: 90 * 1000,
  /** 流式调用两块数据之间的最大空闲。 */
  streamIdleTimeoutMs: 120 * 1000,
  /**
   * 目录缺上下文元数据时的保守上限：既用于 resolveModel 的占用率分母，
   * 也用于请求体的 max_input_tokens，避免未知模型被按 180K 超限。
   */
  fallbackContextWindow: 131072,
  /** 诊断日志超过该大小时轮转为 qoder.log.1，避免无限增长。 */
  logMaxBytes: 2 * 1024 * 1024,
  /**
   * Qoder 官方 CLI 在模型未声明输出上限时使用的默认值：
   * @qoder-ai/qodercli 1.1.78 的 DEFAULT_MAX_OUTPUT_TOKENS = 32,000。
   */
  providerMaxOutputTokens: 32 * 1000,
  /** 本地用量日志上限（条）：为近一年 Credits 热力图保留足够明细。 */
  usageLimit: 5000,
  /** 只保留最近 N 天的用量明细。 */
  usageDays: 366,
  /** 每日汇总保留天数：要覆盖 12 个月热力图并留出时区余量。 */
  usageRollupDays: 430,
});

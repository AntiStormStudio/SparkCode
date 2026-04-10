import { getInitialSettings } from '../utils/settings/settings.js'

const FALLBACK_SPINNER_VERBS = ['思考中']

function normalizeVerbs(verbs: unknown): string[] {
  if (!Array.isArray(verbs)) {
    return []
  }
  return verbs
    .filter((verb): verb is string => typeof verb === 'string')
    .map(verb => verb.trim())
    .filter(Boolean)
}

export function getSpinnerVerbs(): string[] {
  const settings = getInitialSettings()
  const config = settings.spinnerVerbs
  const defaultVerbs = normalizeVerbs(SPINNER_VERBS)
  const safeDefaultVerbs =
    defaultVerbs.length > 0 ? defaultVerbs : FALLBACK_SPINNER_VERBS

  if (!config) {
    return safeDefaultVerbs
  }

  const customVerbs = normalizeVerbs(config.verbs)
  if (config.mode === 'replace') {
    return customVerbs.length > 0 ? customVerbs : safeDefaultVerbs
  }
  return customVerbs.length > 0
    ? [...safeDefaultVerbs, ...customVerbs]
    : safeDefaultVerbs
}

// Spinner verbs for loading messages
export const SPINNER_VERBS = [
  '嗑瓜子中',
  '剥香蕉皮中',
  '正在启动原神',
  '我在写代码',
  '你别急',
  '我在想',
  '我没招了',
  '还有招',
  'pdd 砍价中',
  '我看看怎么个事',
  '崩铁启动中',
  '少女折寿中',
  '神秘中',
  '你猜我在干什么',
  '正在偷看你的代码',
  '喝水中',
  '正在打开项目',
  '正在新建文件夹',
  '蜗牛爬行中',
  '正在连接到 CS:GO 服务器',
  '正在与服务器握手',
  '请求发送中',
  '系统处理中',
  '模型睡觉中',
  '冷却液背稿中',
  'xzh 睡觉中',
  'wzh 睡觉中',
  '军方已介入',
  "蒋介石处理中",
  "正在上报联合国",
  "蒋介石反动中",
  "单方块生存中"
]

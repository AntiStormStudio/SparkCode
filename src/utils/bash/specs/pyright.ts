import type { CommandSpec } from '../registry.js'

export default {
  name: 'pyright',
  description: 'Python 类型检查器',
  options: [
    { name: ['--help', '-h'], description: '显示帮助信息' },
    { name: '--version', description: '打印 pyright 版本并退出' },
    {
      name: ['--watch', '-w'],
      description: '持续运行并监听变更',
    },
    {
      name: ['--project', '-p'],
      description: '使用指定位置的配置文件',
      args: { name: 'FILE OR DIRECTORY' },
    },
    { name: '-', description: '从标准输入读取文件或目录列表' },
    {
      name: '--createstub',
      description: '为导入项创建类型桩文件',
      args: { name: 'IMPORT' },
    },
    {
      name: ['--typeshedpath', '-t'],
      description: '使用指定位置的 typeshed 类型桩',
      args: { name: 'DIRECTORY' },
    },
    {
      name: '--verifytypes',
      description: '验证 py.typed 包中的类型完整性',
      args: { name: 'IMPORT' },
    },
    {
      name: '--ignoreexternal',
      description: '执行 --verifytypes 时忽略外部导入',
    },
    {
      name: '--pythonpath',
      description: 'Python 解释器路径',
      args: { name: 'FILE' },
    },
    {
      name: '--pythonplatform',
      description: '按指定平台分析',
      args: { name: 'PLATFORM' },
    },
    {
      name: '--pythonversion',
      description: '按指定 Python 版本分析',
      args: { name: 'VERSION' },
    },
    {
      name: ['--venvpath', '-v'],
      description: '包含虚拟环境的目录',
      args: { name: 'DIRECTORY' },
    },
    { name: '--outputjson', description: '以 JSON 格式输出结果' },
    { name: '--verbose', description: '输出详细诊断信息' },
    { name: '--stats', description: '打印详细性能统计' },
    {
      name: '--dependencies',
      description: '输出导入依赖信息',
    },
    {
      name: '--level',
      description: '最低诊断级别',
      args: { name: 'LEVEL' },
    },
    {
      name: '--skipunannotated',
      description: '跳过未标注函数的类型分析',
    },
    {
      name: '--warnings',
      description: '如果存在警告则使用退出码 1',
    },
    {
      name: '--threads',
      description: '最多使用 N 个线程并行执行类型检查',
      args: { name: 'N', isOptional: true },
    },
  ],
  args: {
    name: 'files',
    description:
      '指定要分析的文件或目录（会覆盖配置文件）',
    isVariadic: true,
    isOptional: true,
  },
} satisfies CommandSpec

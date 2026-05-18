import pkg from '../package.json'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { dirname, extname, join, resolve } from 'path'
import { installExitDiagnostics } from './utils/exitDiagnostics.js'

installExitDiagnostics()

type MacroConfig = {
  VERSION: string
  BUILD_TIME: string
  PACKAGE_URL: string
  NATIVE_PACKAGE_URL: string
  VERSION_CHANGELOG: string
  ISSUES_EXPLAINER: string
  FEEDBACK_CHANNEL: string
}

const defaultMacro: MacroConfig = {
  VERSION: pkg.version,
  BUILD_TIME: '',
  PACKAGE_URL: pkg.name,
  NATIVE_PACKAGE_URL: pkg.name,
  VERSION_CHANGELOG: '',
  ISSUES_EXPLAINER:
    '请在你的 SPARK-Code 仓库里提交 issue',
  FEEDBACK_CHANNEL: 'github',
}

if (!('MACRO' in globalThis)) {
  ;(globalThis as typeof globalThis & { MACRO: MacroConfig }).MACRO =
    defaultMacro
}

type MissingImport = {
  importer: string
  specifier: string
}

function scanFiles(dir: string, out: string[]): void {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      scanFiles(fullPath, out)
      continue
    }
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extname(entry.name))) {
      out.push(fullPath)
    }
  }
}

function hasResolvableTarget(basePath: string): boolean {
  const withoutJs = basePath.replace(/\.js$/u, '')
  const candidates = [
    withoutJs,
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    `${withoutJs}.js`,
    `${withoutJs}.jsx`,
    `${withoutJs}.mjs`,
    `${withoutJs}.cjs`,
    join(withoutJs, 'index.ts'),
    join(withoutJs, 'index.tsx'),
    join(withoutJs, 'index.js'),
  ]
  return candidates.some(candidate => existsSync(candidate))
}

function collectMissingRelativeImports(): MissingImport[] {
  const files: string[] = []
  scanFiles(resolve('src'), files)
  scanFiles(resolve('vendor'), files)
  const missing: MissingImport[] = []
  const seen = new Set<string>()
  const pattern =
    /(?:import|export)\s+[\s\S]*?from\s+['"](\.\.?\/[^'"]+)['"]|require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) continue
      const target = resolve(dirname(file), specifier)
      if (hasResolvableTarget(target)) continue
      const key = `${file} -> ${specifier}`
      if (seen.has(key)) continue
      seen.add(key)
      missing.push({
        importer: file,
        specifier,
      })
    }
  }

  return missing.sort((a, b) =>
    `${a.importer}:${a.specifier}`.localeCompare(`${b.importer}:${b.specifier}`),
  )
}

const args = process.argv.slice(2)
const missingImports = collectMissingRelativeImports()

if (args.includes('--version')) {
  if (missingImports.length > 0) {
    console.log(`${pkg.version}（已还原的开发工作区）`)
    console.log(`missing_relative_imports=${missingImports.length}`)
    process.exit(0)
  }
  console.log(pkg.version)
  process.exit(0)
}

if (args.includes('--help')) {
  if (missingImports.length > 0) {
    console.log('SPARK-Code 已还原开发工作区')
    console.log(`版本：${pkg.version}`)
    console.log(`缺失的相对导入：${missingImports.length}`)
    process.exit(0)
  }
  console.log('用法：sparkc [options] [prompt]')
  console.log('')
  console.log('基础还原命令：')
  console.log('  --help       显示帮助')
  console.log('  --version    显示版本')
  console.log('')
  console.log('不带这些参数运行时，交互式 REPL 会转到 src/main.tsx 启动。')
  process.exit(0)
}

if (missingImports.length > 0) {
  console.log('SPARK-Code 已还原开发工作区')
  console.log(`版本：${pkg.version}`)
  console.log(`缺失的相对导入：${missingImports.length}`)
  console.log('')
  console.log('主要缺失模块：')
  for (const item of missingImports.slice(0, 20)) {
    console.log(`- ${item.importer.replace(`${process.cwd()}/`, '')} -> ${item.specifier}`)
  }
  console.log('')
  console.log('原始应用入口仍被缺失的还原源码阻塞。')
  console.log('请继续在此工作区修复还原内容；缺失导入归零后，启动器会自动转发到 src/main.tsx。')
  process.exit(0)
}

// Route through the original CLI bootstrap so the exported `main()` is
// actually invoked. Importing `main.tsx` directly only evaluates the module.
await import('./entrypoints/cli.tsx')

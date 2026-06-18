import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(scriptDir, '..')
const projectRoot = resolve(appRoot, '..')
const resourceDir = join(appRoot, 'src-tauri', 'resources')
const oldDirectoryResource = join(resourceDir, 'spark-code-backend')
const archivePath = join(resourceDir, 'spark-code-backend.tar.gz')
const stageRoot = join(appRoot, 'src-tauri', 'target', 'spark-code-backend-resource')
const targetRoot = join(stageRoot, 'spark-code-backend')

const dirs = ['src', 'vendor', 'shims', 'bin', 'scripts', 'node_modules']
const files = ['package.json', 'tsconfig.json', 'bun.lock', 'image-processor.node']
const tuiOnlyPaths = [
  join('src', 'dev-entry.ts'),
  join('src', 'main.tsx'),
  join('src', 'replLauncher.tsx'),
  join('src', 'screens'),
]

function runChecked(command, args, cwd = projectRoot) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 执行失败`)
  }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

function toTarPath(path) {
  if (process.platform !== 'win32') return path
  const normalized = path.replaceAll('\\', '/')
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (!match) return normalized
  return `/${match[1].toLowerCase()}/${match[2]}`
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
  })
  return result.status === 0
}

function syncDir(name) {
  const source = join(projectRoot, name)
  const target = join(targetRoot, name)
  if (!existsSync(source)) return
  ensureDir(dirname(target))
  rmSync(target, { force: true, recursive: true })
  if (process.platform === 'win32') {
    cpSync(source, target, { force: true, recursive: true })
    return
  }
  if (run('rsync', ['-a', '--delete', `${source}/`, `${target}/`])) return
  mkdirSync(target, { recursive: true })
  run('cp', ['-R', `${source}/.`, target])
}

function syncFile(name) {
  const source = join(projectRoot, name)
  const target = join(targetRoot, name)
  if (!existsSync(source)) return
  ensureDir(dirname(target))
  copyFileSync(source, target)
}

function pruneTuiOnlyPaths() {
  for (const name of tuiOnlyPaths) {
    rmSync(join(targetRoot, name), { force: true, recursive: true })
  }
}

function findBunBinary() {
  if (process.execPath && existsSync(process.execPath)) {
    return realpathSync(process.execPath)
  }
  const bunPath = commandOutput('which', ['bun'])
  if (!bunPath) {
    throw new Error('未找到 bun，无法内置后端运行时')
  }
  return realpathSync(bunPath)
}

rmSync(targetRoot, { force: true, recursive: true })
rmSync(oldDirectoryResource, { force: true, recursive: true })
ensureDir(resourceDir)
ensureDir(targetRoot)
for (const dir of dirs) syncDir(dir)
for (const file of files) syncFile(file)
pruneTuiOnlyPaths()

const bunBinary = findBunBinary()
const runtimeDir = join(targetRoot, 'runtime')
const bundledBunName = process.platform === 'win32' ? 'bun.exe' : 'bun'
const bundledBunPath = join(runtimeDir, bundledBunName)
ensureDir(runtimeDir)
copyFileSync(bunBinary, bundledBunPath)
chmodSync(bundledBunPath, 0o755)

writeFileSync(
  join(targetRoot, 'backend-resource.json'),
  `${JSON.stringify({
    version: JSON.parse(await Bun.file(join(projectRoot, 'package.json')).text()).version,
    generated_at: new Date().toISOString(),
    bun: {
      source: bunBinary,
      bundled: bundledBunName,
      size: statSync(bunBinary).size,
    },
  }, null, 2)}\n`,
)

rmSync(archivePath, { force: true })
runChecked('tar', ['-czf', toTarPath(archivePath), '-C', toTarPath(stageRoot), 'spark-code-backend'], appRoot)

console.log(`Spark Code backend resource prepared: ${archivePath}`)

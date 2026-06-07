import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const appRoot = resolve(scriptDir, '..')
const projectRoot = resolve(appRoot, '..')
const targetRoot = join(appRoot, 'src-tauri', 'resources', 'spark-code-backend')

const dirs = ['src', 'vendor', 'shims', 'bin', 'scripts', 'node_modules']
const files = ['package.json', 'tsconfig.json', 'bun.lock', 'image-processor.node']
const tuiOnlyPaths = [
  join('src', 'dev-entry.ts'),
  join('src', 'main.tsx'),
  join('src', 'replLauncher.tsx'),
  join('src', 'screens'),
]

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
  })
  return result.status === 0
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function syncDir(name) {
  const source = join(projectRoot, name)
  const target = join(targetRoot, name)
  if (!existsSync(source)) return
  ensureDir(dirname(target))

  if (run('rsync', ['-a', '--delete', `${source}/`, `${target}/`])) return

  rmSync(target, { force: true, recursive: true })
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
  const bunPath = commandOutput('which', ['bun'])
  if (!bunPath) {
    throw new Error('未找到 bun，无法内置后端运行时')
  }
  return realpathSync(bunPath)
}

ensureDir(targetRoot)
for (const dir of dirs) syncDir(dir)
for (const file of files) syncFile(file)
pruneTuiOnlyPaths()

const bunBinary = findBunBinary()
const runtimeDir = join(targetRoot, 'runtime')
ensureDir(runtimeDir)
copyFileSync(bunBinary, join(runtimeDir, 'bun'))
chmodSync(join(runtimeDir, 'bun'), 0o755)

writeFileSync(
  join(targetRoot, 'backend-resource.json'),
  `${JSON.stringify({
    version: JSON.parse(await Bun.file(join(projectRoot, 'package.json')).text()).version,
    generated_at: new Date().toISOString(),
    bun: {
      source: bunBinary,
      size: statSync(bunBinary).size,
    },
  }, null, 2)}\n`,
)

console.log(`Spark Code backend resource prepared: ${targetRoot}`)

import { appendFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const logPath = join(
  process.env.SPARK_CONFIG_DIR ?? join(homedir(), '.sparkc'),
  'last-exit.log',
)

let installed = false

function writeExitDiagnostic(message: string): void {
  try {
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // 退出诊断不能影响主流程。
  }
}

function stack(): string {
  return new Error().stack?.split('\n').slice(2, 8).join(' | ') ?? ''
}

export function recordExitDiagnostic(message: string): void {
  writeExitDiagnostic(`${message} ${stack()}`)
}

export function installExitDiagnostics(): void {
  if (installed) return
  installed = true

  writeExitDiagnostic(
    `start argv=${JSON.stringify(process.argv.slice(2))} shell=${process.env.SHELL ?? ''} tty=${Boolean(process.stdin.isTTY)}/${Boolean(process.stdout.isTTY)}`,
  )

  process.on('beforeExit', code => {
    writeExitDiagnostic(`beforeExit code=${code}`)
  })

  process.on('exit', code => {
    writeExitDiagnostic(`exit code=${code}`)
  })

  process.on('uncaughtException', error => {
    writeExitDiagnostic(
      `uncaughtException ${error.name}: ${error.message}\n${error.stack ?? ''}`,
    )
  })

  process.on('unhandledRejection', reason => {
    writeExitDiagnostic(
      `unhandledRejection ${reason instanceof Error ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}` : String(reason)}`,
    )
  })
}

export function isLiveTty(): boolean {
  return Boolean(
    process.stdin.isTTY &&
      process.stdout.isTTY &&
      process.stdin.readable &&
      process.stdout.writable,
  )
}

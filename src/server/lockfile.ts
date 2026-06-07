import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export type ServerLock = {
  pid: number
  port: number
  host: string
  httpUrl: string
  startedAt: number
}

function lockPath(): string {
  if (process.env.SPARK_CODE_SERVER_LOCK_PATH?.trim()) {
    return process.env.SPARK_CODE_SERVER_LOCK_PATH.trim()
  }
  return join(homedir(), '.sparkc', 'server.lock')
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function writeServerLock(lock: ServerLock): Promise<void> {
  const path = lockPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8')
}

export async function removeServerLock(): Promise<void> {
  const path = lockPath()
  if (existsSync(path)) {
    rmSync(path, { force: true })
  }
}

export async function probeRunningServer(): Promise<ServerLock | null> {
  const path = lockPath()
  if (!existsSync(path)) return null

  try {
    const lock = JSON.parse(readFileSync(path, 'utf8')) as ServerLock
    if (lock.pid && isProcessAlive(lock.pid)) {
      return lock
    }
  } catch {
    // Bad lock files are treated as stale.
  }

  await removeServerLock()
  return null
}

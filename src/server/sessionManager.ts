import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { resolve } from 'path'
import type { SessionInfo } from './types.js'

export type ImageAttachment = {
  id?: string
  name?: string
  media_type?: string
  data: string
}

type Backend = {
  runPrompt: (input: {
    prompt: string
    cwd: string
    sessionId: string
    resume: boolean
    model?: string
    permissionMode?: string
    images?: ImageAttachment[]
    onEvent?: (event: unknown) => void
  }) => Promise<string>
  listTasks?: (sessionId: string) => unknown[]
}

type SessionManagerOptions = {
  idleTimeoutMs?: number
  maxSessions?: number
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionInfo>()

  constructor(
    private readonly backend: Backend,
    private readonly options: SessionManagerOptions = {},
  ) {}

  createSession(input: { cwd?: string; sessionKey?: string } = {}): SessionInfo {
    const maxSessions = this.options.maxSessions ?? 32
    if (maxSessions > 0 && this.sessions.size >= maxSessions) {
      throw new Error('已达到本地后端最大会话数')
    }

    const workDir = resolve(input.cwd || process.cwd())
    if (!existsSync(workDir)) {
      throw new Error(`工作目录不存在：${workDir}`)
    }

    const session: SessionInfo = {
      id: randomUUID(),
      status: 'detached',
      createdAt: Date.now(),
      workDir,
      process: null,
      sessionKey: input.sessionKey,
      hasStarted: false,
    }
    this.sessions.set(session.id, session)
    return session
  }

  restoreSession(input: {
    sessionId: string
    cwd?: string
    sessionKey?: string
    hasStarted?: boolean
  }): SessionInfo {
    const existing = this.sessions.get(input.sessionId)
    if (existing) {
      const nextWorkDir = resolve(input.cwd || existing.workDir)
      if (!existsSync(nextWorkDir)) {
        throw new Error(`工作目录不存在：${nextWorkDir}`)
      }
      if (existing.status !== 'running' && existing.workDir !== nextWorkDir) {
        existing.workDir = nextWorkDir
        existing.sessionKey = input.sessionKey ?? existing.sessionKey
        existing.hasStarted = input.hasStarted === true
      }
      return existing
    }

    const maxSessions = this.options.maxSessions ?? 32
    if (maxSessions > 0 && this.sessions.size >= maxSessions) {
      throw new Error('已达到本地后端最大会话数')
    }

    const workDir = resolve(input.cwd || process.cwd())
    if (!existsSync(workDir)) {
      throw new Error(`工作目录不存在：${workDir}`)
    }

    const session: SessionInfo = {
      id: input.sessionId,
      status: 'detached',
      createdAt: Date.now(),
      workDir,
      process: null,
      sessionKey: input.sessionKey,
      hasStarted: input.hasStarted === true,
    }
    this.sessions.set(session.id, session)
    return session
  }

  getSession(id: string): SessionInfo | undefined {
    return this.sessions.get(id)
  }

  listTasks(sessionId: string): unknown[] {
    if (!this.sessions.has(sessionId)) {
      throw new Error('会话不存在')
    }
    return this.backend.listTasks?.(sessionId) ?? []
  }

  async runPrompt(
    sessionId: string,
    prompt: string,
    model?: string,
    permissionMode?: string,
    images: ImageAttachment[] = [],
    onEvent?: (event: unknown) => void,
  ): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error('会话不存在')
    }

    session.status = 'running'
    try {
      const result = await this.backend.runPrompt({
        prompt,
        cwd: session.workDir,
        sessionId: session.id,
        resume: session.hasStarted === true,
        model,
        permissionMode,
        images,
        onEvent,
      })
      if (prompt.trim() !== '/__sparkcode_healthcheck') {
        session.hasStarted = true
      }
      return result
    } finally {
      session.status = 'detached'
    }
  }

  async destroyAll(): Promise<void> {
    this.sessions.clear()
  }
}

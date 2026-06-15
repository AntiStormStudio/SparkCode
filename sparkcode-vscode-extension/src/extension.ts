import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vscode from 'vscode'

type SparkLock = {
  httpUrl?: string
  pid?: number
}

const AUTH_TOKEN_FALLBACK = 'sparkcode-app-local'

function config() {
  return vscode.workspace.getConfiguration('sparkCode')
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readBackendUrl(): Promise<string> {
  const override = config().get<string>('backendUrl')?.trim()
  if (override) return override.replace(/\/+$/, '')

  const sparkDir = path.join(os.homedir(), '.sparkc')
  const entries = await fs.promises.readdir(sparkDir).catch(() => [])
  const locks = entries
    .filter(name => /^sparkcode-app-\d+\.lock$/.test(name))
    .map(name => path.join(sparkDir, name))

  let newest: { file: string; mtime: number } | null = null
  for (const file of locks) {
    const stat = await fs.promises.stat(file).catch(() => null)
    if (!stat) continue
    if (!newest || stat.mtimeMs > newest.mtime) newest = { file, mtime: stat.mtimeMs }
  }
  if (!newest) throw new Error('没有找到 Spark Code 本地后端 lock 文件')

  const lock = JSON.parse(await fs.promises.readFile(newest.file, 'utf8')) as SparkLock
  if (!lock.httpUrl) throw new Error('Spark Code lock 文件缺少 httpUrl')
  return lock.httpUrl.replace(/\/+$/, '')
}

async function postPrompt(prompt: string, cwd: string) {
  const backendUrl = await readBackendUrl()
  const authToken = config().get<string>('authToken')?.trim() || AUTH_TOKEN_FALLBACK
  const response = await fetch(`${backendUrl}/prompt`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${authToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      cwd,
      session_id: `vscode:${cwd}`,
      session_key: `sparkcode-vscode:${cwd}`,
      resume: true,
    }),
  })
  if (!response.ok) {
    throw new Error(`Spark Code 返回 ${response.status}: ${await response.text()}`)
  }
  return response.json() as Promise<{ content?: string }>
}

function currentWorkspacePath(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir()
}

function activeEditor(): vscode.TextEditor {
  const editor = vscode.window.activeTextEditor
  if (!editor) throw new Error('没有打开的编辑器')
  return editor
}

async function sendText(label: string, text: string, cwd: string) {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Spark Code: ${label}`,
      cancellable: false,
    },
    async () => {
      const result = await postPrompt(text, cwd)
      const preview = result.content?.trim()
      vscode.window.showInformationMessage(preview ? `Spark Code 已回复：${preview.slice(0, 120)}` : '已发送到 Spark Code')
    },
  )
}

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('sparkCode.connect', async () => {
      const backendUrl = await readBackendUrl()
      const response = await fetch(`${backendUrl}/health`, {
        headers: {
          authorization: `Bearer ${config().get<string>('authToken')?.trim() || AUTH_TOKEN_FALLBACK}`,
        },
      })
      if (!response.ok) throw new Error(`Spark Code 健康检查失败：${response.status}`)
      vscode.window.showInformationMessage(`已连接 Spark Code: ${backendUrl}`)
    }),
    vscode.commands.registerCommand('sparkCode.sendSelection', async () => {
      const editor = activeEditor()
      const selection = editor.selection.isEmpty
        ? editor.document.getText()
        : editor.document.getText(editor.selection)
      await sendText(
        '发送选区',
        `请基于 VSCode 当前内容处理：\n\n${selection}`,
        vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath ?? currentWorkspacePath(),
      )
    }),
    vscode.commands.registerCommand('sparkCode.sendFile', async () => {
      const editor = activeEditor()
      await sendText(
        '发送当前文件',
        `请查看并处理这个文件：${editor.document.uri.fsPath}\n\n${editor.document.getText()}`,
        vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath ?? currentWorkspacePath(),
      )
    }),
    vscode.commands.registerCommand('sparkCode.openApp', async () => {
      const appPath = '/Applications/Spark Code.app'
      const tmpPath = '/tmp/Spark Code Final.app'
      const target = await fileExists(appPath) ? appPath : tmpPath
      await vscode.env.openExternal(vscode.Uri.file(target))
    }),
  )
}

export function deactivate() {}

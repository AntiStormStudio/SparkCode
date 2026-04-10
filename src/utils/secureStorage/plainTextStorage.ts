import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'crypto'
import { chmodSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../slowOperations.js'
import type { SecureStorage, SecureStorageData } from './types.js'

const STORAGE_FILE_NAME = '.credentials.json'
const STORAGE_KEY_FILE_NAME = '.credentials.key'
const STORAGE_ENCRYPTION_ALGO = 'aes-256-gcm'
const STORAGE_KEY_BYTES = 32
const STORAGE_IV_BYTES = 12

type EncryptedStoragePayload = {
  __sparkEncrypted: true
  version: 1
  algorithm: typeof STORAGE_ENCRYPTION_ALGO
  iv: string
  authTag: string
  data: string
}

function getStoragePath(): { storageDir: string; storagePath: string } {
  const storageDir = getClaudeConfigHomeDir()
  const storageFileName = STORAGE_FILE_NAME
  return { storageDir, storagePath: join(storageDir, storageFileName) }
}

function getStorageKeyPath(storageDir: string): string {
  return join(storageDir, STORAGE_KEY_FILE_NAME)
}

function ensureStorageDir(storageDir: string): void {
  try {
    getFsImplementation().mkdirSync(storageDir)
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'EEXIST') {
      throw e
    }
  }
}

function isEncryptedStoragePayload(
  value: unknown,
): value is EncryptedStoragePayload {
  if (!value || typeof value !== 'object') {
    return false
  }
  const payload = value as Partial<EncryptedStoragePayload>
  return (
    payload.__sparkEncrypted === true &&
    payload.version === 1 &&
    payload.algorithm === STORAGE_ENCRYPTION_ALGO &&
    typeof payload.iv === 'string' &&
    typeof payload.authTag === 'string' &&
    typeof payload.data === 'string'
  )
}

function getExistingStorageKey(storageDir: string): Buffer | null {
  const keyPath = getStorageKeyPath(storageDir)
  try {
    const raw = getFsImplementation()
      .readFileSync(keyPath, { encoding: 'utf8' })
      .trim()
    const key = Buffer.from(raw, 'base64')
    if (key.length === STORAGE_KEY_BYTES) {
      return key
    }
  } catch {
    return null
  }
  return null
}

function getOrCreateStorageKey(storageDir: string): Buffer {
  const existing = getExistingStorageKey(storageDir)
  if (existing) {
    return existing
  }

  const keyPath = getStorageKeyPath(storageDir)
  const key = randomBytes(STORAGE_KEY_BYTES)
  writeFileSync_DEPRECATED(keyPath, key.toString('base64'), {
    encoding: 'utf8',
    flush: false,
  })
  chmodSync(keyPath, 0o600)
  return key
}

function encryptStorageData(data: SecureStorageData, key: Buffer): string {
  const iv = randomBytes(STORAGE_IV_BYTES)
  const cipher = createCipheriv(STORAGE_ENCRYPTION_ALGO, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(jsonStringify(data), 'utf8'),
    cipher.final(),
  ])
  const payload: EncryptedStoragePayload = {
    __sparkEncrypted: true,
    version: 1,
    algorithm: STORAGE_ENCRYPTION_ALGO,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  }
  return jsonStringify(payload)
}

function decryptStorageData(
  payload: EncryptedStoragePayload,
  key: Buffer,
): SecureStorageData | null {
  try {
    const decipher = createDecipheriv(
      payload.algorithm,
      key,
      Buffer.from(payload.iv, 'base64'),
    )
    decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.data, 'base64')),
      decipher.final(),
    ]).toString('utf8')
    return jsonParse(plaintext)
  } catch {
    return null
  }
}

export const plainTextStorage = {
  name: 'plaintext',
  read(): SecureStorageData | null {
    // sync IO: called from sync context (SecureStorage interface)
    const { storageDir, storagePath } = getStoragePath()
    try {
      const data = getFsImplementation().readFileSync(storagePath, {
        encoding: 'utf8',
      })
      const parsed = jsonParse(data)
      if (!isEncryptedStoragePayload(parsed)) {
        return parsed
      }
      const key = getExistingStorageKey(storageDir)
      if (!key) {
        return null
      }
      return decryptStorageData(parsed, key)
    } catch {
      return null
    }
  },
  async readAsync(): Promise<SecureStorageData | null> {
    const { storageDir, storagePath } = getStoragePath()
    try {
      const data = await getFsImplementation().readFile(storagePath, {
        encoding: 'utf8',
      })
      const parsed = jsonParse(data)
      if (!isEncryptedStoragePayload(parsed)) {
        return parsed
      }
      const key = getExistingStorageKey(storageDir)
      if (!key) {
        return null
      }
      return decryptStorageData(parsed, key)
    } catch {
      return null
    }
  },
  update(data: SecureStorageData): { success: boolean; warning?: string } {
    // sync IO: called from sync context (SecureStorage interface)
    try {
      const { storageDir, storagePath } = getStoragePath()
      ensureStorageDir(storageDir)
      const key = getOrCreateStorageKey(storageDir)
      writeFileSync_DEPRECATED(storagePath, encryptStorageData(data, key), {
        encoding: 'utf8',
        flush: false,
      })
      chmodSync(storagePath, 0o600)
      return {
        success: true,
        warning: 'Warning: Using local encrypted credentials fallback storage.',
      }
    } catch {
      return { success: false }
    }
  },
  delete(): boolean {
    // sync IO: called from sync context (SecureStorage interface)
    const { storageDir, storagePath } = getStoragePath()
    const keyPath = getStorageKeyPath(storageDir)
    let storageDeleted = false
    let keyDeleted = false
    try {
      getFsImplementation().unlinkSync(storagePath)
      storageDeleted = true
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code !== 'ENOENT') {
        storageDeleted = false
      }
      if (code === 'ENOENT') {
        storageDeleted = true
      }
    }
    try {
      getFsImplementation().unlinkSync(keyPath)
      keyDeleted = true
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT') {
        keyDeleted = true
      }
    }
    return storageDeleted || keyDeleted
  },
} satisfies SecureStorage

export type SecureStorageData = Record<string, unknown>

export type SecureStorageUpdateResult = {
  success: boolean
  warning?: string
}

export interface SecureStorage {
  name: string
  read(): SecureStorageData | null
  readAsync(): Promise<SecureStorageData | null>
  update(data: SecureStorageData): SecureStorageUpdateResult
  delete(): boolean
}

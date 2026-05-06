import { execa } from 'execa'
import {
  getMacOsKeychainStorageServiceName,
  getUsername,
} from 'src/utils/secureStorage/macOsKeychainHelpers.js'

export async function maybeRemoveApiKeyFromMacOSKeychainThrows(): Promise<void> {
  if (process.platform === 'darwin') {
    const storageServiceName = getMacOsKeychainStorageServiceName()
    const username = getUsername()
    const result = await execa(
      'security',
      ['delete-generic-password', '-a', username, '-s', storageServiceName],
      { reject: false },
    )
    if (result.exitCode !== 0) {
      throw new Error('Failed to delete keychain entry')
    }
  }
}

export function normalizeApiKeyForConfig(apiKey: string): string {
  return apiKey.slice(-20)
}

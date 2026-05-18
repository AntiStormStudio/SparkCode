// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .sparkc/ folder
export const CLAUDE_FOLDER_PERMISSION_PATTERN = '/.sparkc/**'

// Permission pattern for granting session-level access to the global ~/.sparkc/ folder
export const GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN = '~/.sparkc/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'

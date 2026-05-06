import { useEffect } from 'react'
import { isEnvTruthy } from '../utils/envUtils.js'

export function useAfterFirstRender(): void {
  useEffect(() => {
    const hasStartupExitFlag = isEnvTruthy(
      process.env.CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER,
    )
    // Guard against accidental exits in normal interactive sessions:
    // require either explicit debug mode or an explicit force flag.
    const allowStartupExit =
      process.argv.includes('--debug-to-stderr') ||
      process.argv.includes('--debug') ||
      isEnvTruthy(process.env.CLAUDE_CODE_FORCE_EXIT_AFTER_FIRST_RENDER)

    if (
      process.env.USER_TYPE === 'ant' &&
      hasStartupExitFlag &&
      allowStartupExit
    ) {
      process.stderr.write(
        `\nStartup time: ${Math.round(process.uptime() * 1000)}ms\n`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(0)
    }
  }, [])
}

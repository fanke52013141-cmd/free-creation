import { runCli } from './index'
import { app } from 'electron'

void app.whenReady().then(async () => {
  try {
    await runCli()
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`致命错误: ${message}`)
    process.exitCode = 1
  } finally {
    app.quit()
  }
})

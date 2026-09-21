import { ModelRuntime } from '@free-creation/model-runtime'
import { HttpValidationAdapter } from './http-validation-adapter'
import { SqliteModelHost } from './sqlite-model-host'

/** One application-owned runtime shared by validation and future feature executors. */
export function createDesktopModelRuntime(host: SqliteModelHost): ModelRuntime {
  const runtime = new ModelRuntime({ ports: { configuration: host, secrets: host, validations: host, tasks: host, artifacts: host, voices: host } })
  runtime.register(new HttpValidationAdapter())
  return runtime
}

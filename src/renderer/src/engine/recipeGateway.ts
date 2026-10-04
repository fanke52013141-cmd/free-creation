import type { GatewayClient } from '@shared/engine/gateway-client'
import { recipeParams } from '@shared/artifact-recipe'
const MEDIA_REQUESTS = new Set([
  'imageGenerate',
  'imageEdit',
  'videoGenerate',
  'audioGenerate',
  'speechGenerate',
  'voiceDesign',
  'ttsGenerate',
  'cropImage',
  'splitImageGrid',
  'extractVideoFrame',
  'clipVideo',
  'extractVideoAudio',
  'soundAdjust',
  'separateVocals',
  'convertVideoDepth',
  'convertVideoClay'
])
/** Captures actual merged requests as private project data, never diagnostic content. */
export function recipeGateway(
  gateway: GatewayClient,
  capture: (request: { prompt: string; paramsJson: string }) => void
): GatewayClient {
  return new Proxy(gateway, {
    get(target, key, receiver) {
      const method = Reflect.get(target, key, receiver)
      if (typeof method !== 'function' || !MEDIA_REQUESTS.has(String(key))) return method
      return (...args: unknown[]) => {
        const input = args[0]
        if (input && typeof input === 'object') {
          const request = input as Record<string, unknown>
          capture({
            prompt:
              typeof request.prompt === 'string'
                ? request.prompt
                : typeof request.text === 'string'
                  ? request.text
                  : '',
            paramsJson: recipeParams(JSON.stringify(request))
          })
        }
        return Reflect.apply(method, target, args)
      }
    }
  })
}

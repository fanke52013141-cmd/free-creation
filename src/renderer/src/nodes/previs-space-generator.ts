// 预演空间生成的适配边界。当前默认实现是本地白模，未来接入外部图片→空间服务时
// 只替换此处的 Provider，不得让 DirectorStudioPanel 直接依赖某一家模型或 API。
import {
  createImageDepthSpace,
  createLocalWhiteboxSpace,
  type DirectorSpace,
  type DirectorSpaceMode
} from './director-data'

export interface PrevisSpaceGenerationInput {
  referenceMediaIds: string[]
  referenceMediaPaths: string[]
  mode?: DirectorSpaceMode
  parallaxStrength?: number
}

export interface PrevisSpaceGenerator {
  id: string
  mode: DirectorSpaceMode
  generate(input: PrevisSpaceGenerationInput): Promise<DirectorSpace>
}

export const localWhiteboxSpaceGenerator: PrevisSpaceGenerator = {
  id: 'local-whitebox@1',
  mode: 'local-whitebox',
  async generate(input): Promise<DirectorSpace> {
    return createLocalWhiteboxSpace(input.referenceMediaIds, input.referenceMediaPaths)
  }
}

/**
 * Local, zero-cost 2.5D adapter. It deliberately records a source reference instead of a
 * generated binary depth asset; the viewport derives a luminance depth field at render time.
 * A real Depth Anything adapter can implement the same interface later without changing nodes.
 */
export const imageDepthSpaceGenerator: PrevisSpaceGenerator = {
  id: 'image-depth@1',
  mode: 'image-depth',
  async generate(input): Promise<DirectorSpace> {
    const sourceMediaId = input.referenceMediaIds[0] ?? ''
    const sourceMediaPath = input.referenceMediaPaths[0] ?? ''
    return createImageDepthSpace(sourceMediaId, sourceMediaPath, input.parallaxStrength)
  }
}

/**
 * Keep the action asynchronous even for the local fallback so a remote task adapter has the same
 * failure and cancellation boundary when it is introduced later.
 */
export async function generatePrevisSpace(
  input: PrevisSpaceGenerationInput,
  generator?: PrevisSpaceGenerator
): Promise<DirectorSpace> {
  const selected =
    generator ??
    (input.mode === 'image-depth' ? imageDepthSpaceGenerator : localWhiteboxSpaceGenerator)
  return await selected.generate({
    referenceMediaIds: input.referenceMediaIds.slice(0, 3),
    referenceMediaPaths: input.referenceMediaPaths.slice(0, 3),
    mode: input.mode,
    parallaxStrength: input.parallaxStrength
  })
}

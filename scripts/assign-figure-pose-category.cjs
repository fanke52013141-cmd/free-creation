/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
// Organize the ingested pose/costume image resources through public desktop IPC:
//   1. Ensure the「人物站位」and「服装」categories exist (one required image slot each);
//      uncategorized image resources are re-published via publishLibraryRevision +
//      reuseComponentId (publishRevision ignores folderId, so filing is separate).
//   2. Repair the folder hierarchy: the library returns tags sorted alphabetically,
//      so 体系/分类 are matched by known value sets (never by position). Folders that
//      do not match the expected structure under the two roots are deleted
//      (deleteFolder bubbles resources up), then every resource is filed:
//        人物站位/<体系>/<分类>   pose tags: 体系 + 分类 + 角度 + 姿势模板
//        服装/<分类>              costume tags: 分类 + 服装模板 + ...
// Run after scripts/ingest-pose-gallery.cjs batches; safe to re-run (idempotent).
// NOTE: the desktop app must be closed while this script runs (single-instance).
const { _electron } = require('playwright')
const { join, resolve } = require('node:path')
const installedRoot = process.env.CANVAS_LOCAL_AGENT_INSTALL_ROOT
const electron = installedRoot ? join(installedRoot, 'canvas-studio.exe') : require('electron')
const appRoot = installedRoot ? resolve(installedRoot, 'resources', 'app') : resolve('.')

const POSE_SYSTEMS = ['全身单人・性感系', '全身单人・标准系', '上半身单人', '双人缠绵']
const POSE_ANGLES = ['正面', '侧面', '俯视', '仰视', '斜侧']
const COSTUME_CATEGORIES = ['春季穿搭', '夏季穿搭', '秋季穿搭', '冬季穿搭', '内衣・睡衣', '派对・礼服', '泳装・度假', '性感穿搭', '中国历代']
const CATEGORIES = [
  { id: 'figure-pose', name: '人物站位', slotId: 'pose-image', marker: '姿势模板', rootFolder: '人物站位' },
  { id: 'costume', name: '服装', slotId: 'costume-image', marker: '服装模板', rootFolder: '服装' }
]
;(async () => {
  const app = await _electron.launch({ executablePath: electron, args: installedRoot ? [] : [appRoot] })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState()
    const result = await page.evaluate(async ({ categories, poseSystems, poseAngles, costumeCategories }) => {
      const listed = await window.api.listLibraryCategories()
      if (!listed.ok) return { error: 'LIST_CATEGORIES:' + JSON.stringify(listed.error) }
      const ensured = {}
      for (const definition of categories) {
        let category = listed.data?.find((item) => item.id === definition.id)
        if (!category) {
          const saved = await window.api.saveLibraryCategory({
            baseVersion: 0,
            category: {
              id: definition.id,
              version: 1,
              name: definition.name,
              description: 'AI 姿势/服装模板参考库（来源：ai-pose-gallery-zh）',
              presentation: 'gallery',
              coverSlotId: definition.slotId,
              blueprint: {
                protocolVersion: 1,
                layout: 'grid',
                slots: [
                  {
                    id: definition.slotId,
                    label: definition.name,
                    nodeType: 'image',
                    contractVersion: 3,
                    required: true,
                    multiple: false,
                    titleTemplate: '{resource}'
                  }
                ]
              }
            }
          })
          if (!saved.ok) return { error: 'SAVE_CATEGORY:' + JSON.stringify(saved.error) }
          category = saved.data
        }
        ensured[definition.id] = { definition, category }
      }

      const folders = await window.api.listLibraryFolders()
      if (!folders.ok) return { error: 'LIST_FOLDERS:' + JSON.stringify(folders.error) }
      let byId = new Map(folders.data.map((folder) => [folder.id, folder]))
      let byParentName = new Map(folders.data.map((folder) => [`${folder.parentId ?? ''}:${folder.name}`, folder]))
      async function refreshFolders() {
        const relisted = await window.api.listLibraryFolders()
        if (!relisted.ok) throw new Error('LIST_FOLDERS:' + JSON.stringify(relisted.error))
        byId = new Map(relisted.data.map((folder) => [folder.id, folder]))
        byParentName = new Map(relisted.data.map((folder) => [`${folder.parentId ?? ''}:${folder.name}`, folder]))
      }
      function rootFolderId(name) {
        return byParentName.get(`:${name}`)?.id ?? null
      }
      // Legit folder ids: exact expected name chains under the two roots.
      const keepIds = new Set()
      for (const definition of categories) {
        const rootId = rootFolderId(definition.rootFolder)
        if (!rootId) continue
        keepIds.add(rootId)
        const children = definition.id === 'figure-pose' ? poseSystems : costumeCategories
        for (const child of children) {
          const childFolder = byParentName.get(`${rootId}:${child}`)
          if (!childFolder) continue
          keepIds.add(childFolder.id)
        }
      }
      // Wrong folders: inside the two root subtrees but not part of the expected
      // structure; delete deepest-first so resources bubble up to the roots.
      function underRoot(folderId) {
        let current = byId.get(folderId)
        let depth = 0
        while (current) {
          if (current.name === '人物站位' || current.name === '服装') return depth
          current = current.parentId ? byId.get(current.parentId) : undefined
          depth += 1
        }
        return -1
      }
      const doomed = folders.data
        .filter((folder) => !keepIds.has(folder.id) && underRoot(folder.id) >= 0)
        .sort((left, right) => underRoot(right.id) - underRoot(left.id))
      for (const folder of doomed) {
        const removed = await window.api.deleteLibraryFolder(folder.id)
        if (!removed.ok) return { error: 'DELETE_FOLDER:' + folder.name + ':' + JSON.stringify(removed.error) }
      }
      if (doomed.length) await refreshFolders()
      async function ensureFolder(parts) {
        let parentId = null
        for (const name of parts) {
          const key = `${parentId ?? ''}:${name}`
          let folder = byParentName.get(key)
          if (!folder) {
            const created = await window.api.createLibraryFolder({ name, ...(parentId ? { parentId } : {}) })
            if (!created.ok) throw new Error('CREATE_FOLDER:' + JSON.stringify(created.error))
            folder = created.data
            byParentName.set(key, folder)
          }
          parentId = folder.id
        }
        return parentId
      }

      const items = []
      let cursor
      for (let page_ = 0; page_ < 100; page_ += 1) {
        const search = await window.api.searchLibrary({
          formPreset: 'image',
          includeArchived: false,
          limit: 100,
          ...(cursor ? { cursor } : {})
        })
        if (!search.ok) return { error: 'SEARCH:' + JSON.stringify(search.error) }
        items.push(...search.data.items)
        cursor = search.data.nextCursor
        if (!cursor) break
      }

      let recategorized = 0
      let filed = 0
      let skipped = 0
      const failures = []
      for (const item of items) {
        const tags = item.tags ?? []
        const definition = tags.includes('姿势模板')
          ? categories[0]
          : tags.includes('服装模板')
            ? categories[1]
            : null
        if (!definition) {
          skipped += 1
          continue
        }
        // Tags are returned alphabetically sorted: match the dataset's own
        // classification by known value sets, never by position.
        let folderParts
        if (definition.id === 'figure-pose') {
          const system = tags.find((tag) => poseSystems.includes(tag))
          const category = tags.find((tag) => !poseSystems.includes(tag) && !poseAngles.includes(tag) && tag !== '姿势模板')
          folderParts = [definition.rootFolder, ...(system ? [system] : []), ...(category ? [category] : [])]
        } else {
          const category = tags.find((tag) => costumeCategories.includes(tag))
          folderParts = [definition.rootFolder, ...(category ? [category] : [])]
        }
        const folderId = await ensureFolder(folderParts)
        if (!item.category) {
          const detail = await window.api.getLibraryResource({ resourceId: item.id })
          if (!detail.ok || !detail.data) {
            failures.push(`${item.title}:DETAIL`)
            continue
          }
          const component = detail.data.components.find(
            (candidate) => candidate.valueType === 'image' && candidate.blobPath
          )
          if (!component) {
            failures.push(`${item.title}:NO_IMAGE_COMPONENT`)
            continue
          }
          // Reuse the existing blob and remap only the slot metadata; publishRevision
          // rewrites title/description/tags/collections, so carry the current values.
          const revision = await window.api.publishLibraryRevision({
            resourceId: item.id,
            baseRevisionId: detail.data.latestRevisionId,
            title: detail.data.title,
            formPreset: detail.data.formPreset,
            ...(detail.data.description ? { description: detail.data.description } : {}),
            ...(detail.data.tags?.length ? { tags: detail.data.tags } : {}),
            ...(detail.data.collectionIds?.length
              ? { collectionIds: detail.data.collectionIds }
              : {}),
            category: { id: definition.id, version: ensured[definition.id].category.version },
            changeNote: `归入「${definition.name}」分类`,
            components: [
              {
                role: component.role || 'reference-image',
                valueType: 'image',
                reuseComponentId: component.id,
                metadata: { librarySlotId: definition.slotId }
              }
            ]
          })
          if (!revision.ok) {
            failures.push(`${item.title}:${JSON.stringify(revision.error)}`)
            continue
          }
          recategorized += 1
        }
        const filed_ = await window.api.setLibraryResourceFolder({ resourceId: item.id, folderId })
        if (!filed_.ok) failures.push(`${item.title}:FOLDER:${JSON.stringify(filed_.error)}`)
        else filed += 1
      }
      return { total: items.length, recategorized, filed, deletedFolders: doomed.length, skipped, failures }
    }, { categories: CATEGORIES, poseSystems: POSE_SYSTEMS, poseAngles: POSE_ANGLES, costumeCategories: COSTUME_CATEGORIES })
    if (result.error) throw new Error(result.error)
    process.stdout.write(
      `total=${result.total} recategorized=${result.recategorized} filed=${result.filed} deletedWrongFolders=${result.deletedFolders} untagged(skipped)=${result.skipped} failures=${result.failures.length}\n` +
        result.failures.map((item) => `  - ${item}`).join('\n') + '\n'
    )
  } finally {
    await app.close()
  }
})().catch((error) => {
  process.stderr.write(String(error.message || error) + '\n')
  process.exitCode = 1
})

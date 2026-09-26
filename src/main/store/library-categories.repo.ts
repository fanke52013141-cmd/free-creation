import { nanoid } from 'nanoid'
import {
  LIBRARY_NODE_ADAPTERS,
  parseCategory,
  validateCategoryContent,
  type LibraryCategory,
  type LibraryNodeType,
  type SaveLibraryCategoryInput
} from '../../shared/library/blueprint'
import type { LibraryComponentInput } from '../../shared/library/types'
import { getDb } from './db'

const seeds: Array<[string, string, Array<[string, LibraryNodeType]>]> = [
  [
    'image',
    '图片 / 海报',
    [
      ['参考图', 'image'],
      ['提示词', 'text']
    ]
  ],
  ['prompt', '提示词', [['提示词', 'text']]],
  [
    'character',
    '人物设定',
    [
      ['形象', 'image'],
      ['描述', 'text'],
      ['声音', 'audio']
    ]
  ],
  [
    'scene',
    '场景设定',
    [
      ['场景图', 'image'],
      ['描述', 'text']
    ]
  ],
  [
    'style',
    '风格参考',
    [
      ['参考图', 'image'],
      ['风格提示词', 'text']
    ]
  ],
  [
    'files',
    '素材文件',
    [
      ['文件', 'file'],
      ['音频', 'audio'],
      ['视频', 'video-asset']
    ]
  ]
]
export function listCategories(): LibraryCategory[] {
  const db = getDb()
  const insert = db.prepare(
    'INSERT OR IGNORE INTO library_category_versions (category_id, version, body_json) VALUES (?, 1, ?)'
  )
  db.transaction(() => {
    for (const [id, name, slots] of seeds) {
      const category: LibraryCategory = {
        id: `builtin-${id}`,
        version: 1,
        name,
        description: '',
        presentation: id === 'character' ? 'profile' : id === 'prompt' ? 'list' : 'gallery',
        blueprint: {
          protocolVersion: 1,
          layout: 'grid',
          slots: slots.map(([label, nodeType], index) => ({
            id: `slot-${index}`,
            label,
            nodeType,
            contractVersion: LIBRARY_NODE_ADAPTERS[nodeType].contractVersion,
            required: index === 0 && id !== 'files',
            multiple: nodeType !== 'text',
            titleTemplate: '{resource} · {slot} {index}'
          }))
        }
      }
      insert.run(category.id, JSON.stringify(category))
    }
  })()
  return (
    db
      .prepare(
        `SELECT body_json FROM library_category_versions c WHERE version =
    (SELECT MAX(version) FROM library_category_versions v WHERE v.category_id = c.category_id) ORDER BY category_id`
      )
      .all() as Array<{ body_json: string }>
  ).map((row) => parseCategory(JSON.parse(row.body_json)))
}
export function getCategory(id: string, version: number): LibraryCategory {
  const row = getDb()
    .prepare(
      'SELECT body_json FROM library_category_versions WHERE category_id = ? AND version = ?'
    )
    .get(id, version) as { body_json: string } | undefined
  if (!row) throw new Error('资源分类版本不存在，请重新选择分类')
  return parseCategory(JSON.parse(row.body_json))
}
export function saveCategory(input: SaveLibraryCategoryInput): LibraryCategory {
  const category = parseCategory(input?.category)
  if (
    !Number.isInteger(input.baseVersion) ||
    input.baseVersion < 0 ||
    category.version !== input.baseVersion + 1
  )
    throw new Error('分类版本无效')
  const db = getDb()
  db.transaction(() => {
    const row = db
      .prepare(
        'SELECT MAX(version) AS version FROM library_category_versions WHERE category_id = ?'
      )
      .get(category.id) as { version: number | null }
    if ((row.version ?? 0) !== input.baseVersion) throw new Error('分类已有新版本，请刷新后重试')
    db.prepare(
      'INSERT INTO library_category_versions (category_id, version, body_json) VALUES (?, ?, ?)'
    ).run(category.id, category.version, JSON.stringify(category))
  })()
  return category
}
export function revisionCategory(revisionId: string): LibraryCategory | undefined {
  const row = getDb()
    .prepare('SELECT category_json FROM library_revision_blueprints WHERE revision_id = ?')
    .get(revisionId) as { category_json: string } | undefined
  return row ? parseCategory(JSON.parse(row.category_json)) : undefined
}
export function pinCategory(
  revisionId: string,
  reference: { id: string; version: number } | undefined,
  components: LibraryComponentInput[]
): void {
  if (!reference) return
  const category = getCategory(reference.id, reference.version)
  validateCategoryContent(
    category,
    components.map((component) => ({ ...component, metadata: component.metadata ?? {} }))
  )
  getDb()
    .prepare(
      'INSERT INTO library_revision_blueprints (revision_id, category_id, category_json) VALUES (?, ?, ?)'
    )
    .run(revisionId, category.id, JSON.stringify(category))
}
export function importCategoryDefinition(
  value: unknown,
  idMap: Map<string, string>
): LibraryCategory {
  const source = parseCategory(value)
  const id = idMap.get(source.id) ?? `import-${nanoid(12)}`
  idMap.set(source.id, id)
  const category = { ...source, id }
  const body = JSON.stringify(category)
  const existing = getDb()
    .prepare(
      'SELECT body_json FROM library_category_versions WHERE category_id = ? AND version = ?'
    )
    .get(id, category.version) as { body_json: string } | undefined
  if (existing && existing.body_json !== body) throw new Error('资源包中同一分类版本的定义不一致')
  getDb()
    .prepare(
      'INSERT OR IGNORE INTO library_category_versions (category_id, version, body_json) VALUES (?, ?, ?)'
    )
    .run(id, category.version, body)
  return category
}

export function importRevisionCategory(
  revisionId: string,
  value: unknown,
  idMap: Map<string, string>
): void {
  if (value === undefined) return
  const category = importCategoryDefinition(value, idMap)
  getDb()
    .prepare(
      'INSERT INTO library_revision_blueprints (revision_id, category_id, category_json) VALUES (?, ?, ?)'
    )
    .run(revisionId, category.id, JSON.stringify(category))
}

export function exportCategoryVersions(): LibraryCategory[] {
  return (
    getDb()
      .prepare('SELECT body_json FROM library_category_versions ORDER BY category_id, version')
      .all() as Array<{ body_json: string }>
  ).map((row) => parseCategory(JSON.parse(row.body_json)))
}

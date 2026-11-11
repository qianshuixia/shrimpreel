// 生成器草稿：访客先选照片、风格和时长，登录或买积分的整页跳转之后还能接着用。
// 只存在本浏览器的 IndexedDB 里（单一 key），开始生成后清除，超过 24 小时也视为不存在。
// IndexedDB 不可用（隐私模式等）时只 console.warn，当作没有草稿，不影响生成器本身。
export type PhotoDraft = {
  file: Blob
  name: string
  type: string
  // 双人风格的第二张照片；旧草稿没有这三项
  file2?: Blob
  name2?: string
  type2?: string
  styleId: string
  durationId: string
  consent: boolean
  savedAt: number
}

const DB_NAME = 'photo-draft'
const STORE = 'draft'
const KEY = 'current'
export const DRAFT_TTL_MS = 24 * 3600_000

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('indexedDB unavailable'))
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('indexedDB blocked'))
  })
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      const request = action(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(request.result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export async function saveDraft(draft: Omit<PhotoDraft, 'savedAt'>): Promise<void> {
  try {
    await run('readwrite', (store) => store.put({ ...draft, savedAt: Date.now() }, KEY))
  } catch (error) {
    console.warn('photo draft save failed', error)
  }
}

export async function loadDraft(): Promise<PhotoDraft | null> {
  try {
    const draft = await run<PhotoDraft | undefined>('readonly', (store) => store.get(KEY))
    if (!draft || !(draft.file instanceof Blob)) return null
    if (draft.file2 !== undefined && !(draft.file2 instanceof Blob)) return null
    if (Date.now() - draft.savedAt > DRAFT_TTL_MS) {
      await clearDraft()
      return null
    }
    return draft
  } catch (error) {
    console.warn('photo draft load failed', error)
    return null
  }
}

export async function clearDraft(): Promise<void> {
  try {
    await run('readwrite', (store) => store.delete(KEY))
  } catch (error) {
    console.warn('photo draft clear failed', error)
  }
}

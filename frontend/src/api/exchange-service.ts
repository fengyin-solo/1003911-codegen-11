import { listRows, saveAll } from '@/data/local-store'
import { MODULE_BY_KEY } from '@/data/modules'
import type { ActionResult, EntryRow } from '@/data/types'

// 监理交换箱：本端勾选治理工程项目形成待补影像和进度包，监理端填写现场索引后回传，
// 平台核对无误再核销待补项，并同步生成工程验收预清单。
// 流程跨「治理工程 / 监理交换箱 / 工程验收」三处数据流，全部收敛在这个文件里，
// 页面只调这里的方法；所有写操作先整包核对，再一次性落库（saveAll），核对失败整包不落库。
const EXCHANGE_KEY = 'exchange'
const ENGINEERING_KEY = 'engineering'
const ACCEPTANCE_KEY = 'acceptance'

const ENGINEERING_STATUSES = MODULE_BY_KEY.get(ENGINEERING_KEY)?.statuses ?? []
const LAST_ENGINEERING_STATUS = ENGINEERING_STATUSES[ENGINEERING_STATUSES.length - 1] ?? ''

// 缺合同金额的存量项目打包时按未审价带入。
export const UNPRICED = '未审价'

export type PackableProject = {
  row: EntryRow
  /** 非空表示该项目已在未核销批次里，值是占用它的批次号。 */
  packedBatch: string
}

export type BatchSummary = {
  批次号: string
  status: string
  项目数: number
  创建时间: string
  回传时间: string
  核销时间: string
  items: EntryRow[]
}

export type ReturnEntry = {
  项目编号: string
  现场索引: string
  回传状态: string
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function currentStamp(): string {
  const d = new Date()
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/** 回传时间允许手工填写，统一成 YYYY-MM-DD HH:mm:ss，字符串比较即时间先后。 */
function normalizeStamp(raw: string): string {
  return raw.trim().replace('T', ' ')
}

function maxId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
}

/** 项目编号 -> 占用它的未核销批次号。 */
function openBatchByProject(): Map<string, string> {
  const packed = new Map<string, string>()
  for (const row of listRows(EXCHANGE_KEY)) {
    if (String(row.status) !== '已核销') {
      packed.set(String(row['项目编号']), String(row['批次号']))
    }
  }
  return packed
}

export function listPackableProjects(): PackableProject[] {
  const packed = openBatchByProject()
  return listRows(ENGINEERING_KEY).map((row) => ({
    row,
    packedBatch: packed.get(String(row['项目编号'])) ?? '',
  }))
}

function nextBatchNo(rows: EntryRow[], stamp: string): string {
  const day = stamp.slice(0, 10).replace(/-/g, '')
  const prefix = `EXCH-${day}-`
  let seq = 0
  for (const row of rows) {
    const no = String(row['批次号'] ?? '')
    if (no.startsWith(prefix)) {
      const n = Number(no.slice(prefix.length))
      if (Number.isFinite(n) && n > seq) {
        seq = n
      }
    }
  }
  return `${prefix}${String(seq + 1).padStart(2, '0')}`
}

/** 本端打包：勾选项目生成待补影像和进度包，一个项目同一时间只能待在一个未核销批次里。 */
export function createBatch(projectIds: number[]): ActionResult {
  const ids = [...new Set(projectIds)]
  if (ids.length === 0) {
    return { ok: false, message: '请先勾选要打包的治理工程项目' }
  }
  const projects = listRows(ENGINEERING_KEY)
  const packed = openBatchByProject()
  const chosen: EntryRow[] = []
  for (const id of ids) {
    const project = projects.find((row) => Number(row.id) === id)
    if (!project) {
      return { ok: false, message: `没有找到编号为 ${id} 的治理工程项目，整包未落库` }
    }
    const code = String(project['项目编号'])
    const used = packed.get(code)
    if (used) {
      return { ok: false, message: `项目 ${code} 已在批次 ${used} 中，核销前不能重复打包，整包未落库` }
    }
    chosen.push(project)
  }
  const stamp = currentStamp()
  const existing = listRows(EXCHANGE_KEY)
  const batchNo = nextBatchNo(existing, stamp)
  let id = maxId(existing) + 1
  const rows: EntryRow[] = chosen.map((project) => {
    const amount = project['合同金额']
    return {
      id: id++,
      status: '待回传',
      pending: true,
      abnormal: false,
      批次号: batchNo,
      项目编号: String(project['项目编号']),
      隐患点编号: String(project['隐患点编号'] ?? ''),
      承建方: String(project['承建方'] ?? ''),
      待补影像: '待补：现场影像资料',
      进度要求: '待补：施工进度月报',
      合同金额: amount === undefined || amount === '' ? UNPRICED : amount,
      状态快照: String(project.status),
      快照时间: stamp,
      现场索引: '',
      回传状态: '',
      回传时间: '',
      冲突处理: '',
      创建时间: stamp,
      核销时间: '',
    }
  })
  saveAll({ [EXCHANGE_KEY]: [...existing, ...rows] })
  return { ok: true, message: `已生成批次 ${batchNo}，共 ${rows.length} 项待补影像和进度包` }
}

export function listBatches(): BatchSummary[] {
  const groups = new Map<string, EntryRow[]>()
  for (const row of listRows(EXCHANGE_KEY)) {
    const no = String(row['批次号'])
    const list = groups.get(no) ?? []
    list.push(row)
    groups.set(no, list)
  }
  return [...groups.entries()]
    .map(([批次号, items]) => ({
      批次号,
      status: String(items[0].status),
      项目数: items.length,
      创建时间: String(items[0]['创建时间'] ?? ''),
      回传时间: String(items[0]['回传时间'] ?? ''),
      核销时间: String(items[0]['核销时间'] ?? ''),
      items,
    }))
    .sort((a, b) => b.创建时间.localeCompare(a.创建时间) || b.批次号.localeCompare(a.批次号))
}

/** 监理端回传：整包核对（批次待回传、每项现场索引必填、回传状态合法）通过才落库。 */
export function submitReturn(批次号: string, 回传时间: string, entries: ReturnEntry[]): ActionResult {
  const rows = listRows(EXCHANGE_KEY)
  const items = rows.filter((row) => String(row['批次号']) === 批次号)
  if (items.length === 0) {
    return { ok: false, message: `没有找到批次 ${批次号}，整包未落库` }
  }
  if (String(items[0].status) !== '待回传') {
    return { ok: false, message: `批次 ${批次号} 已回传，同一包重复上传仅保留一个批次，本次未落库` }
  }
  const stamp = normalizeStamp(回传时间)
  if (!stamp) {
    return { ok: false, message: '回传时间不能为空，整包未落库' }
  }
  const byProject = new Map(entries.map((entry) => [entry.项目编号, entry]))
  for (const item of items) {
    const code = String(item['项目编号'])
    const entry = byProject.get(code)
    if (!entry || entry.现场索引.trim() === '') {
      return { ok: false, message: `项目 ${code} 的现场索引未填写，整包未落库` }
    }
    if (entry.回传状态 && !ENGINEERING_STATUSES.includes(entry.回传状态)) {
      return { ok: false, message: `项目 ${code} 的回传状态「${entry.回传状态}」未登记，整包未落库` }
    }
  }
  const next = rows.map((row) => {
    if (String(row['批次号']) !== 批次号) {
      return row
    }
    const entry = byProject.get(String(row['项目编号']))
    return {
      ...row,
      status: '已回传',
      pending: true,
      现场索引: entry ? entry.现场索引.trim() : '',
      回传状态: entry ? entry.回传状态 : '',
      回传时间: stamp,
    }
  })
  saveAll({ [EXCHANGE_KEY]: next })
  return { ok: true, message: `批次 ${批次号} 回传成功，共 ${items.length} 项，待平台核销` }
}

function maxAcceptanceSeq(rows: EntryRow[]): number {
  let seq = 0
  for (const row of rows) {
    const no = String(row['验收编号'] ?? '')
    const match = /^ACCE-(\d+)$/.exec(no)
    if (match) {
      seq = Math.max(seq, Number(match[1]))
    }
  }
  return seq
}

/**
 * 平台核销：核对批次已回传、项目仍在台账后，一次落库三处变更——
 * 1. 待补项核销；2. 项目状态按冲突规则回写；3. 工程验收预清单同步生成。
 * 冲突规则：回传状态与项目当前状态不一致时，以时间较晚的一方为准——
 * 回传时间不早于打包时的状态快照时间则采用回传值，否则保留本地状态。
 */
export function verifyBatch(批次号: string): ActionResult {
  const exchangeRows = listRows(EXCHANGE_KEY)
  const items = exchangeRows.filter((row) => String(row['批次号']) === 批次号)
  if (items.length === 0) {
    return { ok: false, message: `没有找到批次 ${批次号}，整包未落库` }
  }
  if (String(items[0].status) === '已核销') {
    return { ok: false, message: `批次 ${批次号} 已核销，不能重复核销` }
  }
  if (String(items[0].status) !== '已回传') {
    return { ok: false, message: `批次 ${批次号} 尚未回传，不能核销` }
  }
  const projects = listRows(ENGINEERING_KEY)
  const projectByCode = new Map(projects.map((row) => [String(row['项目编号']), row]))
  for (const item of items) {
    if (!projectByCode.has(String(item['项目编号']))) {
      return { ok: false, message: `项目 ${String(item['项目编号'])} 已不在治理工程台账，整包未落库` }
    }
  }

  const stamp = currentStamp()
  let adopted = 0
  let kept = 0
  const statusByCode = new Map<string, string>()
  const nextExchange = exchangeRows.map((row) => {
    if (String(row['批次号']) !== 批次号) {
      return row
    }
    const code = String(row['项目编号'])
    const project = projectByCode.get(code) as EntryRow
    const returned = String(row['回传状态'] ?? '')
    let 冲突处理 = '无冲突'
    let nextStatus = String(project.status)
    if (returned && returned !== String(project.status)) {
      if (String(row['回传时间']) >= String(row['快照时间'])) {
        nextStatus = returned
        冲突处理 = '采用回传'
        adopted += 1
      } else {
        冲突处理 = '保留本地'
        kept += 1
      }
    }
    statusByCode.set(code, nextStatus)
    return { ...row, status: '已核销', pending: false, 冲突处理, 核销时间: stamp }
  })
  const nextProjects = projects.map((row) => {
    const target = statusByCode.get(String(row['项目编号']))
    if (!target || target === String(row.status)) {
      return row
    }
    return { ...row, status: target, pending: target !== LAST_ENGINEERING_STATUS, abnormal: false }
  })

  const acceptanceRows = listRows(ACCEPTANCE_KEY)
  const prelisted = new Set(
    acceptanceRows
      .filter((row) => String(row.status) === '待验收')
      .map((row) => String(row['项目编号'])),
  )
  let accId = maxId(acceptanceRows) + 1
  let accSeq = maxAcceptanceSeq(acceptanceRows)
  const prelist: EntryRow[] = []
  for (const item of items) {
    const code = String(item['项目编号'])
    if (prelisted.has(code)) {
      continue
    }
    prelisted.add(code)
    accSeq += 1
    prelist.push({
      id: accId++,
      status: '待验收',
      pending: true,
      abnormal: false,
      验收编号: `ACCE-${String(accSeq).padStart(4, '0')}`,
      项目编号: code,
      验收类型: '竣工验收',
      验收日期: stamp.slice(0, 10),
      验收组成员: '待组建',
      验收结论: '待验收',
      整改意见: '',
      验收状态: '待验收',
    })
  }

  saveAll({
    [EXCHANGE_KEY]: nextExchange,
    [ENGINEERING_KEY]: nextProjects,
    [ACCEPTANCE_KEY]: [...acceptanceRows, ...prelist],
  })
  return {
    ok: true,
    message: `批次 ${批次号} 已核销 ${items.length} 项：采用回传 ${adopted} 项、保留本地 ${kept} 项，同步生成验收预清单 ${prelist.length} 条`,
  }
}

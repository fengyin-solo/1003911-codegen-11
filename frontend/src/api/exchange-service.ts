import { MODULE_BY_KEY } from '@/data/modules'
import { listRows, saveMany, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 监理交换箱的编排逻辑：建包、回传、核销都走这里，页面组件不直接改数据。
// 覆盖三处数据流：治理工程（项目）→ 监理交换箱（资料包）→ 工程验收（验收预清单）。

const EXCHANGE_KEY = 'exchange'
const ENGINEERING_KEY = 'engineering'
const ACCEPTANCE_KEY = 'acceptance'

const PACKAGE_TYPE = '待补影像+进度包'
const OPEN_STATUSES = ['待回传', '已回传']
const FINAL_STATUS = '已核销'
const UNAUDITED_PRICE = '未审价'
const PRELIST_TYPE = '验收预清单'

const ENGINEERING_STATUSES = MODULE_BY_KEY.get(ENGINEERING_KEY)?.statuses ?? []
const ENGINEERING_FINAL_STATUS = ENGINEERING_STATUSES[ENGINEERING_STATUSES.length - 1] ?? ''

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function today(): string {
  return now().slice(0, 10)
}

// 解析 'YYYY-MM-DD HH:mm' / 'YYYY-MM-DDTHH:mm' / 'YYYY-MM-DD'，非法返回 null。
function parseTime(value: string): number | null {
  const match = value
    .trim()
    .match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/)
  if (!match) {
    return null
  }
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = match
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime()
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCode(prefix: string, used: string[]): string {
  let max = 0
  for (const value of used) {
    const match = String(value).match(/(\d+)$/)
    if (match) {
      max = Math.max(max, Number(match[1]))
    }
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function missingAmount(value: unknown): boolean {
  return value === undefined || value === null || String(value).trim() === ''
}

// 本端勾选项目建包：一个批次一张「待补影像+进度包」清单，每个项目一条交换记录。
// 已有未核销批次（待回传/已回传）的项目跳过，同一项目不会重复进包。
export function createExchangeBatch(projectIds: number[]): ActionResult {
  const projects = listRows(ENGINEERING_KEY)
  const exchangeRows = listRows(EXCHANGE_KEY)
  const selected = projects.filter((row) => projectIds.includes(Number(row.id)))
  if (selected.length === 0) {
    return { ok: false, message: '请先勾选要建包的治理工程项目' }
  }
  const openProjects = new Set(
    exchangeRows
      .filter((row) => OPEN_STATUSES.includes(String(row.status)))
      .map((row) => String(row['项目编号'])),
  )
  const fresh = selected.filter((row) => !openProjects.has(String(row['项目编号'])))
  const skipped = selected.filter((row) => openProjects.has(String(row['项目编号'])))
  if (fresh.length === 0) {
    const names = skipped.map((row) => String(row['项目编号'])).join('、')
    return { ok: false, message: `所选项目都已在未核销批次里，不重复建包（${names}）` }
  }
  const batchNo = nextCode('EXCH', exchangeRows.map((row) => String(row['批次编号'])))
  const snapshotTime = now()
  let id = nextId(exchangeRows)
  const created: EntryRow[] = fresh.map((project) => ({
    id: id++,
    status: '待回传',
    pending: true,
    abnormal: false,
    批次编号: batchNo,
    项目编号: String(project['项目编号']),
    包类型: PACKAGE_TYPE,
    现场索引: '',
    监理单位: '',
    回传时间: '',
    核对结果: '',
    批次状态: '待回传',
    项目状态快照: String(project.status),
    快照时间: snapshotTime,
    // 存量项目缺合同金额的，按未审价带入
    合同金额快照: missingAmount(project['合同金额']) ? UNAUDITED_PRICE : project['合同金额'],
    回传项目状态: '',
  }))
  saveRows(EXCHANGE_KEY, [...exchangeRows, ...created])
  const skipNote = skipped.length
    ? `；${skipped.length} 个项目已在未核销批次中跳过：${skipped.map((row) => String(row['项目编号'])).join('、')}`
    : ''
  return {
    ok: true,
    message: `已生成监理交换包 ${batchNo}（${created.length} 个项目，缺合同金额按${UNAUDITED_PRICE}带入）${skipNote}`,
  }
}

export type ReturnEntry = {
  现场索引: string
  监理单位: string
  回传项目状态: string
  回传时间: string
}

function validateReturn(entry: ReturnEntry): string {
  if (!entry.现场索引.trim()) {
    return '现场索引不能为空'
  }
  if (entry.回传项目状态 && !ENGINEERING_STATUSES.includes(entry.回传项目状态)) {
    return `回传项目状态「${entry.回传项目状态}」不是治理工程的合法状态`
  }
  if (entry.回传时间.trim() && parseTime(entry.回传时间) === null) {
    return '回传时间格式应为 YYYY-MM-DD HH:mm'
  }
  return ''
}

// 监理端回传：在交换记录上补现场索引与回传状态，记录回传时间供冲突裁决用。
export function registerReturn(rowId: number, entry: ReturnEntry): ActionResult {
  const rows = listRows(EXCHANGE_KEY)
  const index = rows.findIndex((row) => Number(row.id) === rowId)
  if (index < 0) {
    return { ok: false, message: '没有找到这条交换记录' }
  }
  const row = rows[index]
  if (row.status !== '待回传') {
    return { ok: false, message: `批次 ${row['批次编号']} 当前是「${row.status}」，不能重复登记回传` }
  }
  const problem = validateReturn(entry)
  if (problem) {
    return { ok: false, message: problem }
  }
  const next = [...rows]
  next[index] = {
    ...row,
    status: '已回传',
    批次状态: '已回传',
    现场索引: entry.现场索引.trim(),
    监理单位: entry.监理单位.trim(),
    回传项目状态: entry.回传项目状态,
    回传时间: entry.回传时间.trim() || now(),
  }
  saveRows(EXCHANGE_KEY, next)
  return { ok: true, message: `批次 ${row['批次编号']} 已登记回传，等待核销` }
}

// 导出交换包 JSON：监理端拿去线下填写现场索引后再上传回来。
export function exportBatchPackage(batchNo: string): { filename: string; content: string } | null {
  const rows = listRows(EXCHANGE_KEY).filter((row) => String(row['批次编号']) === batchNo)
  if (!rows.length) {
    return null
  }
  const payload = {
    批次编号: batchNo,
    包类型: PACKAGE_TYPE,
    导出时间: now(),
    items: rows.map((row) => ({
      批次编号: row['批次编号'],
      项目编号: row['项目编号'],
      现场索引: row['现场索引'] || '',
      监理单位: row['监理单位'] || '',
      回传时间: row['回传时间'] || '',
      回传项目状态: row['回传项目状态'] || '',
    })),
  }
  return { filename: `监理交换包-${batchNo}.json`, content: JSON.stringify(payload, null, 2) }
}

type ReturnItem = {
  批次编号?: unknown
  项目编号?: unknown
  现场索引?: unknown
  监理单位?: unknown
  回传时间?: unknown
  回传项目状态?: unknown
}

// 上传回传包：先整包核对再统一落库；同一包重复上传时仅保留原批次，重复条目忽略。
export function importReturnPackage(text: string): ActionResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, message: '回传包不是合法的 JSON' }
  }
  const rawItems: unknown = Array.isArray(parsed)
    ? parsed
    : ((parsed as { items?: unknown[] } | null)?.items ?? [parsed])
  const items = (Array.isArray(rawItems) ? rawItems : [rawItems]) as ReturnItem[]
  if (!items.length) {
    return { ok: false, message: '回传包里没有条目' }
  }
  const rows = listRows(EXCHANGE_KEY)
  const problems: string[] = []
  const updates: { index: number; row: EntryRow }[] = []
  let duplicated = 0
  items.forEach((item, i) => {
    const batchNo = String(item?.批次编号 ?? '').trim()
    const projectCode = String(item?.项目编号 ?? '').trim()
    const label = `第 ${i + 1} 条（${batchNo || '无批次号'}/${projectCode || '无项目号'}）`
    if (!batchNo || !projectCode) {
      problems.push(`${label}缺批次编号或项目编号`)
      return
    }
    const index = rows.findIndex(
      (row) => String(row['批次编号']) === batchNo && String(row['项目编号']) === projectCode,
    )
    if (index < 0) {
      problems.push(`${label}在交换箱里找不到对应批次`)
      return
    }
    const row = rows[index]
    if (row.status !== '待回传') {
      // 已回传/已核销的记录说明这个包上传过，重复上传仅保留原批次
      duplicated += 1
      return
    }
    const entry: ReturnEntry = {
      现场索引: String(item?.现场索引 ?? '').trim(),
      监理单位: String(item?.监理单位 ?? '').trim(),
      回传项目状态: String(item?.回传项目状态 ?? '').trim(),
      回传时间: String(item?.回传时间 ?? '').trim(),
    }
    const problem = validateReturn(entry)
    if (problem) {
      problems.push(`${label}${problem}`)
      return
    }
    updates.push({
      index,
      row: {
        ...row,
        status: '已回传',
        批次状态: '已回传',
        现场索引: entry.现场索引,
        监理单位: entry.监理单位,
        回传项目状态: entry.回传项目状态,
        回传时间: entry.回传时间 || now(),
      },
    })
  })
  if (problems.length) {
    return { ok: false, message: `回传包核对失败，整包未落库：${problems.join('；')}` }
  }
  if (updates.length === 0) {
    return duplicated
      ? { ok: false, message: `回传包与已有批次完全重复，仅保留原批次（忽略 ${duplicated} 条）` }
      : { ok: false, message: '回传包没有可落库的条目' }
  }
  const next = [...rows]
  for (const { index, row } of updates) {
    next[index] = row
  }
  saveRows(EXCHANGE_KEY, next)
  const dupNote = duplicated ? `，忽略重复 ${duplicated} 条（仅保留原批次）` : ''
  return { ok: true, message: `回传包落库 ${updates.length} 条${dupNote}` }
}

// 平台核销：整包核对 → 全过才落库，任一不通过则整包不写。
// 落库内容：交换记录转已核销、项目状态/合同金额按规则更新、工程验收同步生成预清单。
export function writeOffBatch(batchNo: string): ActionResult {
  const exchangeRows = listRows(EXCHANGE_KEY)
  const batchRows = exchangeRows.filter((row) => String(row['批次编号']) === batchNo)
  if (!batchRows.length) {
    return { ok: false, message: `没有找到批次 ${batchNo}` }
  }
  if (batchRows.every((row) => row.status === FINAL_STATUS)) {
    return { ok: false, message: `批次 ${batchNo} 已核销，不重复处理` }
  }

  // ---- 第一步：整包核对，任何一条不通过直接返回，什么都不写 ----
  const projects = listRows(ENGINEERING_KEY)
  const projectCodes = new Set(projects.map((row) => String(row['项目编号'])))
  const problems: string[] = []
  for (const row of batchRows) {
    if (row.status === FINAL_STATUS) {
      continue
    }
    const label = `项目 ${row['项目编号']}`
    if (row.status !== '已回传') {
      problems.push(`${label} 尚未回传`)
      continue
    }
    if (!String(row['现场索引'] ?? '').trim()) {
      problems.push(`${label} 缺现场索引`)
    }
    if (parseTime(String(row['回传时间'] ?? '')) === null) {
      problems.push(`${label} 回传时间无效`)
    }
    const returned = String(row['回传项目状态'] ?? '').trim()
    if (returned && !ENGINEERING_STATUSES.includes(returned)) {
      problems.push(`${label} 回传状态「${returned}」非法`)
    }
    if (!projectCodes.has(String(row['项目编号']))) {
      problems.push(`${label} 已不在治理工程台账`)
    }
  }
  if (problems.length) {
    return { ok: false, message: `批次 ${batchNo} 核对失败，整包不落库：${problems.join('；')}` }
  }

  // ---- 第二步：在内存里算好三处改动 ----
  const writeOffTime = now()
  const engineeringNext = projects.map((row) => ({ ...row }))
  const engIndexByCode = new Map(engineeringNext.map((row, i) => [String(row['项目编号']), i]))
  const exchangeNext = exchangeRows.map((row) => ({ ...row }))
  const writtenOff: string[] = []
  const notes: string[] = []

  for (const row of batchRows) {
    if (row.status === FINAL_STATUS) {
      continue
    }
    const projectCode = String(row['项目编号'])
    const engIndex = engIndexByCode.get(projectCode)
    if (engIndex === undefined) {
      continue
    }
    const project = engineeringNext[engIndex]
    const rowNotes: string[] = []
    const returned = String(row['回传项目状态'] ?? '').trim()
    if (returned && returned !== String(project.status)) {
      // 冲突裁决：回传时间与平台快照时间比较，较晚者为准
      const returnedAt = parseTime(String(row['回传时间'])) ?? 0
      const snapshotAt = parseTime(String(row['快照时间'] ?? '')) ?? 0
      if (returnedAt > snapshotAt) {
        rowNotes.push(`回传状态「${returned}」与平台「${project.status}」相冲，回传时间较晚，采用回传值`)
        project.status = returned
        project.pending = returned !== ENGINEERING_FINAL_STATUS
      } else {
        rowNotes.push(`回传状态「${returned}」与平台「${project.status}」相冲，平台快照时间较晚，保留平台值`)
      }
    }
    if (missingAmount(project['合同金额'])) {
      project['合同金额'] = UNAUDITED_PRICE
      rowNotes.push(`合同金额缺省，按${UNAUDITED_PRICE}带入`)
    }
    project['本地更新时间'] = writeOffTime
    const exIndex = exchangeNext.findIndex((item) => Number(item.id) === Number(row.id))
    exchangeNext[exIndex] = {
      ...exchangeNext[exIndex],
      status: FINAL_STATUS,
      批次状态: FINAL_STATUS,
      pending: false,
      核对结果: rowNotes.length ? rowNotes.join('；') : '核对通过',
      核销时间: writeOffTime,
    }
    writtenOff.push(projectCode)
    notes.push(`${projectCode}：${rowNotes.length ? rowNotes.join('；') : '核对通过'}`)
  }

  // 核销成功 → 同步生成另一业务面（工程验收）的验收预清单，已存在的项目不重复生成
  const acceptanceRows = listRows(ACCEPTANCE_KEY)
  const acceptanceNext = acceptanceRows.map((row) => ({ ...row }))
  const existingPrelist = new Set(
    acceptanceRows
      .filter((row) => String(row['验收类型']) === PRELIST_TYPE)
      .map((row) => String(row['项目编号'])),
  )
  const usedCodes = acceptanceRows.map((row) => String(row['验收编号']))
  let accId = nextId(acceptanceRows)
  let prelistCount = 0
  for (const projectCode of writtenOff) {
    if (existingPrelist.has(projectCode)) {
      continue
    }
    const code = nextCode('ACCE', usedCodes)
    usedCodes.push(code)
    acceptanceNext.push({
      id: accId++,
      status: '待验收',
      pending: true,
      abnormal: false,
      验收编号: code,
      项目编号: projectCode,
      验收类型: PRELIST_TYPE,
      验收日期: today(),
      验收组成员: '待组建',
      验收结论: '待定',
      整改意见: '—',
      验收状态: '待验收',
    })
    existingPrelist.add(projectCode)
    prelistCount += 1
  }

  // ---- 第三步：三个模块一次写入，要么全落库要么全不落 ----
  saveMany({
    [EXCHANGE_KEY]: exchangeNext,
    [ENGINEERING_KEY]: engineeringNext,
    [ACCEPTANCE_KEY]: acceptanceNext,
  })
  return {
    ok: true,
    message: `批次 ${batchNo} 核销完成：${writtenOff.length} 个项目落库，同步生成 ${prelistCount} 条验收预清单。${notes.join('；')}`,
  }
}

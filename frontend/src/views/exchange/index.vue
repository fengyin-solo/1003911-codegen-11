<template>
  <section class="page" data-module="exchange">
    <header class="page-head">
      <div>
        <h2>监理交换箱</h2>
        <p class="page-desc">
          本端在治理工程勾选项目生成待补影像和进度包，监理端填写现场索引后回传，平台核对无误后整包核销，并同步生成工程验收预清单。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="triggerUpload">上传回传包</button>
        <button class="btn" type="button" @click="exportRows">导出交换清单</button>
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          class="visually-hidden"
          @change="onUpload"
        />
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <div v-if="returnForm" class="return-panel">
      <h3>登记回传：批次 {{ returnForm.批次编号 }} / 项目 {{ returnForm.项目编号 }}</h3>
      <div class="return-fields">
        <label class="filter-item">
          <span>现场索引 *</span>
          <input v-model="returnForm.现场索引" placeholder="监理现场索引编号" />
        </label>
        <label class="filter-item">
          <span>监理单位</span>
          <input v-model="returnForm.监理单位" placeholder="填写监理单位" />
        </label>
        <label class="filter-item">
          <span>回传项目状态</span>
          <select v-model="returnForm.回传项目状态">
            <option value="">不回传状态</option>
            <option v-for="status in engineeringStatuses" :key="status" :value="status">
              {{ status }}
            </option>
          </select>
        </label>
        <label class="filter-item">
          <span>回传时间</span>
          <input v-model="returnForm.回传时间" placeholder="YYYY-MM-DD HH:mm，留空取当前时间" />
        </label>
      </div>
      <p class="panel-tip">回传状态与平台项目状态相冲时，按回传时间与平台快照时间较晚者为准。</p>
      <div class="panel-actions">
        <button class="btn primary" type="button" @click="submitReturn">确认回传</button>
        <button class="btn ghost" type="button" @click="returnForm = null">取消</button>
      </div>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-if="row.status === '待回传'"
              class="link"
              type="button"
              @click="openReturn(row)"
            >
              登记回传
            </button>
            <button
              v-if="row.status === '待回传'"
              class="link"
              type="button"
              @click="downloadBatch(row)"
            >
              导出交换包
            </button>
            <button
              v-if="row.status === '已回传'"
              class="link"
              type="button"
              @click="writeOff(row)"
            >
              核销整包
            </button>
            <span v-if="row.status === '已核销'">—</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">
            暂无交换批次，可先到治理工程勾选项目生成监理交换包
          </td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条交换记录</span>
      <span v-if="notice" class="ok-text">{{ notice }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  exportBatchPackage,
  importReturnPackage,
  registerReturn,
  writeOffBatch,
} from '@/api/exchange-service'
import type { ActionResult, EntryRow } from '@/data/types'

const meta = moduleMeta('exchange')
const columns = ["批次编号", "项目编号", "包类型", "现场索引", "监理单位", "回传时间", "核对结果", "批次状态"]
const statuses = ["待回传", "已回传", "已核销"]
const engineeringStatuses = moduleMeta('engineering').statuses

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const notice = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const stats = ref([
  { label: '交换批次数', value: 0 },
  { label: '待回传项目', value: 0 },
  { label: '已核销项目', value: 0 },
])
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

type ReturnForm = {
  id: number
  批次编号: string
  项目编号: string
  现场索引: string
  监理单位: string
  回传项目状态: string
  回传时间: string
}
const returnForm = ref<ReturnForm | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

function showResult(result: ActionResult) {
  if (result.ok) {
    notice.value = result.message
    errorMessage.value = ''
  } else {
    errorMessage.value = result.message
    notice.value = ''
  }
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openReturn(row: EntryRow) {
  returnForm.value = {
    id: Number(row.id),
    批次编号: String(row['批次编号']),
    项目编号: String(row['项目编号']),
    现场索引: '',
    监理单位: '',
    回传项目状态: '',
    回传时间: '',
  }
}

function submitReturn() {
  if (!returnForm.value) {
    return
  }
  const result = registerReturn(returnForm.value.id, returnForm.value)
  if (result.ok) {
    returnForm.value = null
  }
  reload()
  showResult(result)
}

function downloadBatch(row: EntryRow) {
  const payload = exportBatchPackage(String(row['批次编号']))
  if (!payload) {
    showResult({ ok: false, message: '批次数据读取失败' })
    return
  }
  const blob = new Blob([payload.content], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = payload.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  showResult({ ok: true, message: `已导出 ${payload.filename}，监理填写现场索引后可上传回传` })
}

function writeOff(row: EntryRow) {
  const result = writeOffBatch(String(row['批次编号']))
  reload()
  showResult(result)
}

function triggerUpload() {
  fileInput.value?.click()
}

function onUpload(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) {
    return
  }
  const reader = new FileReader()
  reader.onload = () => {
    const result = importReturnPackage(String(reader.result ?? ''))
    reload()
    showResult(result)
    input.value = ''
  }
  reader.readAsText(file)
}

function reload() {
  errorMessage.value = ''
  notice.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    stats.value = [
      { label: '交换批次数', value: new Set(rows.value.map((row) => String(row['批次编号']))).size },
      { label: '待回传项目', value: rows.value.filter((row) => row.status === '待回传').length },
      { label: '已核销项目', value: rows.value.filter((row) => row.status === '已核销').length },
    ]
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '监理交换箱列表读取失败'
  }
}

onMounted(reload)
</script>

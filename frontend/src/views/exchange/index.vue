<template>
  <section class="page" data-module="exchange">
    <header class="page-head">
      <div>
        <h2>监理交换箱</h2>
        <p class="page-desc">本端勾选治理工程项目生成待补影像和进度包，监理端填写现场索引后回传，平台核对无误再核销待补项，并同步生成工程验收预清单。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="createPackage">生成待补影像和进度包</button>
        <button class="btn" type="button" @click="exportRows">导出交换待补项清单</button>
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

    <h3 class="panel-title">一、本端打包：勾选治理工程项目</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>勾选</th>
          <th>项目编号</th>
          <th>隐患点编号</th>
          <th>承建方</th>
          <th>合同金额</th>
          <th>当前状态</th>
          <th>所在批次</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in projects" :key="Number(item.row.id)">
          <td>
            <input
              v-model="selectedIds"
              type="checkbox"
              :value="Number(item.row.id)"
              :disabled="item.packedBatch !== ''"
            />
          </td>
          <td>{{ item.row['项目编号'] }}</td>
          <td>{{ item.row['隐患点编号'] }}</td>
          <td>{{ item.row['承建方'] }}</td>
          <td>{{ amountText(item.row) }}</td>
          <td>{{ item.row.status }}</td>
          <td>{{ item.packedBatch || '—' }}</td>
        </tr>
        <tr v-if="!projects.length">
          <td colspan="7" class="empty-state">暂无治理工程项目，可先在治理工程模块登记</td>
        </tr>
      </tbody>
    </table>

    <h3 class="panel-title">二、交换批次</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>批次号</th>
          <th>项目数</th>
          <th>批次状态</th>
          <th>创建时间</th>
          <th>回传时间</th>
          <th>核销时间</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="batch in batches" :key="batch.批次号">
          <td>{{ batch.批次号 }}</td>
          <td>{{ batch.项目数 }}</td>
          <td>{{ batch.status }}</td>
          <td>{{ batch.创建时间 }}</td>
          <td>{{ batch.回传时间 || '—' }}</td>
          <td>{{ batch.核销时间 || '—' }}</td>
          <td class="row-actions">
            <button v-if="batch.status === '待回传'" class="link" type="button" @click="openReturn(batch)">监理回传</button>
            <button v-if="batch.status === '已回传'" class="link" type="button" @click="verify(batch)">核销待补项</button>
            <span v-if="batch.status === '已核销'">已完成</span>
          </td>
        </tr>
        <tr v-if="!batches.length">
          <td colspan="7" class="empty-state">暂无交换批次，勾选项目后点击「生成待补影像和进度包」</td>
        </tr>
      </tbody>
    </table>

    <template v-if="returnForm">
      <h3 class="panel-title">三、监理回传：{{ returnForm.批次号 }}</h3>
      <form class="filter-bar" @submit.prevent="submitReturn">
        <label class="filter-item">
          <span>回传时间</span>
          <input v-model="returnForm.回传时间" placeholder="YYYY-MM-DD HH:mm:ss" />
        </label>
      </form>
      <table class="data-table">
        <thead>
          <tr>
            <th>项目编号</th>
            <th>待补影像</th>
            <th>进度要求</th>
            <th>现场索引（必填）</th>
            <th>回传状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in returnForm.entries" :key="entry.项目编号">
            <td>{{ entry.项目编号 }}</td>
            <td>{{ entry.待补影像 }}</td>
            <td>{{ entry.进度要求 }}</td>
            <td><input v-model="entry.现场索引" placeholder="填写现场索引" /></td>
            <td>
              <select v-model="entry.回传状态">
                <option value="">不变更</option>
                <option v-for="status in projectStatuses" :key="status" :value="status">{{ status }}</option>
              </select>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="page-actions form-actions">
        <button class="btn primary" type="button" @click="submitReturn">提交回传（核对通过才落库）</button>
        <button class="btn ghost" type="button" @click="returnForm = null">取消</button>
      </div>
    </template>

    <h3 class="panel-title">四、交换待补项明细</h3>
    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>冲突处理</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td>{{ row['冲突处理'] || '—' }}</td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无交换待补项，先在本端打包生成批次</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条交换待补项记录</span>
      <span v-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  createBatch,
  currentStamp,
  listBatches,
  listPackableProjects,
  submitReturn as applyReturn,
  UNPRICED,
  verifyBatch,
  type BatchSummary,
  type PackableProject,
} from '@/api/exchange-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('exchange')
const columns = ["批次号", "项目编号", "待补影像", "进度要求", "合同金额", "现场索引", "回传状态", "回传时间"]
const statuses = ["待回传", "已回传", "已核销"]
const stats = [{"label": "待补项总数", "value": 0}, {"label": "待回传数", "value": 0}, {"label": "已核销数", "value": 0}]
const projectStatuses = moduleMeta('engineering').statuses

type ReturnForm = {
  批次号: string
  回传时间: string
  entries: { 项目编号: string; 待补影像: string; 进度要求: string; 现场索引: string; 回传状态: string }[]
}

const projects = ref<PackableProject[]>([])
const batches = ref<BatchSummary[]>([])
const selectedIds = ref<number[]>([])
const returnForm = ref<ReturnForm | null>(null)
const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function amountText(row: EntryRow) {
  const amount = row['合同金额']
  return amount === undefined || amount === '' ? UNPRICED : amount
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function createPackage() {
  const result = createBatch(selectedIds.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  selectedIds.value = []
  reload()
  noticeMessage.value = result.message
}

function openReturn(batch: BatchSummary) {
  returnForm.value = {
    批次号: batch.批次号,
    回传时间: currentStamp(),
    entries: batch.items.map((item) => ({
      项目编号: String(item['项目编号']),
      待补影像: String(item['待补影像']),
      进度要求: String(item['进度要求']),
      现场索引: '',
      回传状态: '',
    })),
  }
}

function submitReturn() {
  const form = returnForm.value
  if (!form) {
    return
  }
  const result = applyReturn(form.批次号, form.回传时间, form.entries)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  returnForm.value = null
  reload()
  noticeMessage.value = result.message
}

function verify(batch: BatchSummary) {
  const result = verifyBatch(batch.批次号)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
  noticeMessage.value = result.message
}

function reload() {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    projects.value = listPackableProjects()
    batches.value = listBatches()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '监理交换箱数据读取失败'
  }
}

onMounted(reload)
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { beginTraqLogin, fetchTraqUsers, finishTraqLogin, getAccessToken, hasTraqConfig, logoutTraq, type TraqUser } from './traq'

type Participant = { id: string; name: string; displayName: string }
type TaxRate = 8 | 10
type Breakdown = { id: string; title: string; amount: number; netAmount?: number; participantIds: string[]; taxRate?: TaxRate }
type Expense = { id: string; title: string; amount: number; payerId: string; participantIds: string[]; discounts?: Record<string, number>; breakdowns?: Breakdown[] }
type Rounding = 'none' | 'ceil10' | 'floor10'
type Settlement = { from: string; to: string; amount: number }

const participants = ref<Participant[]>([])
const expenses = ref<Expense[]>([])
const rounding = ref<Rounding>('none')
const newName = ref('')
const newDisplayName = ref('')
const title = ref('')
const amount = ref<number | null>(null)
const payerId = ref('')
const beneficiaries = ref<string[]>([])
const draftDiscounts = ref<Record<string, number>>({})
const showDiscounts = ref(false)
const copied = ref(false)
const confirmingExpenseClear = ref(false)
const editingBreakdownId = ref<string | null>(null)
const breakdownTitle = ref('')
const breakdownAmount = ref<number | null>(null)
const breakdownParticipants = ref<string[]>([])
const breakdownTaxRate = ref<TaxRate | null>(null)
const breakdownError = ref('')
const loggedIn = ref(Boolean(getAccessToken()))
const authBusy = ref(false)
const authError = ref('')
const traqUsers = ref<TraqUser[]>([])
const userQuery = ref('')
const errors = ref({ participant: '', expense: '' })

const money = (n: number) => `${Math.abs(n).toLocaleString('ja-JP')}円`
const person = (id: string) => participants.value.find(p => p.id === id)
const roundedShare = (value: number) => rounding.value === 'ceil10' ? Math.ceil(value / 10) * 10 : rounding.value === 'floor10' ? Math.floor(value / 10) * 10 : value
const taxIncluded = (net: number, rate: TaxRate | null) => net + (rate ? Math.floor(net * rate / 100) : 0)
const draftTaxIncluded = computed(() => taxIncluded(Number.isInteger(breakdownAmount.value) ? breakdownAmount.value! : 0, breakdownTaxRate.value))

function splitShares(amount: number, ids: string[], payerId: string, discounts: Record<string, number> = {}) {
  if (!ids.length || amount <= 0) return {} as Record<string, number>
  const share = Math.round(roundedShare(amount / ids.length))
  const shares: Record<string, number> = Object.fromEntries(ids.map(id => [id, share]))
  shares[payerId] = (shares[payerId] ?? 0) + amount - share * ids.length
  if (ids.length > 1) for (const [targetId, rawDiscount] of Object.entries(discounts)) {
    if (!ids.includes(targetId)) continue
    const discount = Math.max(0, Math.min(Math.floor(rawDiscount), shares[targetId]))
    if (!discount) continue
    shares[targetId] -= discount
    const others = ids.filter(id => id !== targetId).sort((a, b) => Number(b === payerId) - Number(a === payerId))
    const each = Math.floor(discount / others.length)
    let remainder = discount % others.length
    for (const id of others) shares[id] += each + (remainder-- > 0 ? 1 : 0)
  }
  return shares
}

const breakdownTotal = (e: Expense) => (e.breakdowns ?? []).reduce((sum, item) => sum + item.amount, 0)
const breakdownRemaining = (e: Expense) => e.amount - breakdownTotal(e)
const taxExcluded = (item: Breakdown) => item.netAmount ?? (item.taxRate ? Math.ceil(item.amount * 100 / (100 + item.taxRate)) : item.amount)

function expenseShares(e: Expense) {
  const shares = splitShares(breakdownRemaining(e), e.participantIds, e.payerId, e.discounts)
  for (const item of e.breakdowns ?? []) {
    const itemShares = splitShares(item.amount, item.participantIds, e.payerId)
    for (const [id, value] of Object.entries(itemShares)) shares[id] = (shares[id] ?? 0) + value
  }
  return shares
}

const results = computed(() => participants.value.map(p => {
  let burden = 0
  let paid = 0
  for (const e of expenses.value) {
    if (e.payerId === p.id) paid += e.amount
    burden += expenseShares(e)[p.id] ?? 0
  }
  return { ...p, burden: Math.round(burden), paid, balance: Math.round(paid - burden) }
}))

const settlements = computed<Settlement[]>(() => {
  const creditors = results.value.filter(r => r.balance > 0).map(r => ({ id: r.id, amount: r.balance })).sort((a, b) => b.amount - a.amount)
  const debtors = results.value.filter(r => r.balance < 0).map(r => ({ id: r.id, amount: -r.balance })).sort((a, b) => b.amount - a.amount)
  const output: Settlement[] = []
  let i = 0, j = 0
  while (i < debtors.length && j < creditors.length) {
    const value = Math.min(debtors[i].amount, creditors[j].amount)
    if (value > 0) output.push({ from: debtors[i].id, to: creditors[j].id, amount: value })
    debtors[i].amount -= value; creditors[j].amount -= value
    if (debtors[i].amount === 0) i++
    if (creditors[j].amount === 0) j++
  }
  return output
})

const total = computed(() => expenses.value.reduce((sum, e) => sum + e.amount, 0))
const message = computed(() => settlements.value.map((s, i) => `${[':one:', ':two:', ':three:', ':four:', ':five:'][i] ?? `:${i + 1}:`} @${person(s.from)?.name} → @${person(s.to)?.name} ${money(s.amount)}`).join('\n'))
const userCandidates = computed(() => {
  const q = userQuery.value.trim().replace(/^@/, '').toLowerCase()
  if (!q) return []
  return traqUsers.value.filter(u => {
    const name = u.name.toLowerCase()
    const isSystemUser = name.startsWith('bot_') || name.startsWith('webhook#')
    return !isSystemUser && !participants.value.some(p => p.id === u.id) && (name.includes(q) || u.displayName.toLowerCase().includes(q))
  }).slice(0, 8)
})

async function loadTraqUsers() {
  if (!loggedIn.value) return
  authBusy.value = true
  try { traqUsers.value = await fetchTraqUsers() }
  catch (e) { authError.value = e instanceof Error ? e.message : 'traQとの接続に失敗しました'; loggedIn.value = Boolean(getAccessToken()) }
  finally { authBusy.value = false }
}

function addTraqUser(user: TraqUser) {
  if (participants.value.some(p => p.id === user.id)) return
  participants.value.push({ id: user.id, name: user.name, displayName: user.displayName })
  beneficiaries.value.push(user.id)
  if (!payerId.value) payerId.value = user.id
  userQuery.value = ''
}

function signOut() { logoutTraq(); loggedIn.value = false; traqUsers.value = [] }

function addParticipant() {
  const name = newName.value.trim().replace(/^@/, '')
  if (!name) return errors.value.participant = 'traP IDを入力してください'
  if (participants.value.some(p => p.name.toLowerCase() === name.toLowerCase())) return errors.value.participant = '同じtraP IDは追加できません'
  const p = { id: crypto.randomUUID(), name, displayName: newDisplayName.value.trim() || name }
  participants.value.push(p); beneficiaries.value.push(p.id)
  if (!payerId.value) payerId.value = p.id
  newName.value = ''; newDisplayName.value = ''; errors.value.participant = ''
}

function removeParticipant(id: string) {
  if (participants.value.length === 1) return
  participants.value = participants.value.filter(p => p.id !== id)
  beneficiaries.value = beneficiaries.value.filter(x => x !== id)
  expenses.value = expenses.value.filter(e => e.payerId !== id).map(e => ({ ...e, participantIds: e.participantIds.filter(x => x !== id), breakdowns: (e.breakdowns ?? []).map(item => ({ ...item, participantIds: item.participantIds.filter(x => x !== id) })).filter(item => item.participantIds.length) })).filter(e => e.participantIds.length)
  if (payerId.value === id) payerId.value = participants.value[0]?.id ?? ''
}

function openBreakdown(e: Expense) {
  if (editingBreakdownId.value === e.id) return closeBreakdown()
  editingBreakdownId.value = e.id
  breakdownTitle.value = ''
  breakdownAmount.value = null
  breakdownParticipants.value = [...e.participantIds]
  breakdownTaxRate.value = null
  breakdownError.value = ''
}

function closeBreakdown() {
  editingBreakdownId.value = null
  breakdownError.value = ''
}

function toggleBreakdownParticipant(id: string) {
  breakdownParticipants.value = breakdownParticipants.value.includes(id)
    ? breakdownParticipants.value.filter(x => x !== id)
    : [...breakdownParticipants.value, id]
}

function addBreakdown(e: Expense) {
  const remaining = breakdownRemaining(e)
  if (!breakdownTitle.value.trim()) return breakdownError.value = '内訳名を入力してください'
  if (!Number.isInteger(breakdownAmount.value) || (breakdownAmount.value ?? -1) < 0) return breakdownError.value = '税抜金額は0円以上の整数で入力してください'
  const grossAmount = taxIncluded(breakdownAmount.value!, breakdownTaxRate.value)
  if (grossAmount > remaining) return breakdownError.value = `税込金額${money(grossAmount)}が残額${money(remaining)}を超えています`
  if (!breakdownParticipants.value.length) return breakdownError.value = '負担者を1人以上選んでください'
  e.breakdowns = [...(e.breakdowns ?? []), { id: crypto.randomUUID(), title: breakdownTitle.value.trim(), amount: grossAmount, netAmount: breakdownAmount.value!, participantIds: [...breakdownParticipants.value], ...(breakdownTaxRate.value ? { taxRate: breakdownTaxRate.value } : {}) }]
  breakdownTitle.value = ''
  breakdownAmount.value = null
  breakdownError.value = ''
}

function removeBreakdown(e: Expense, id: string) {
  e.breakdowns = (e.breakdowns ?? []).filter(item => item.id !== id)
}

function toggleBeneficiary(id: string) {
  if (beneficiaries.value.includes(id)) {
    beneficiaries.value = beneficiaries.value.filter(x => x !== id)
    delete draftDiscounts.value[id]
  } else beneficiaries.value = [...beneficiaries.value, id]
}

function addExpense() {
  if (!title.value.trim()) return errors.value.expense = '支払名を入力してください'
  if (!Number.isInteger(amount.value) || (amount.value ?? 0) < 1) return errors.value.expense = '1円以上の整数を入力してください'
  if (!payerId.value || beneficiaries.value.length === 0) return errors.value.expense = '立替者と負担者を選んでください'
  const discounts = Object.fromEntries(Object.entries(draftDiscounts.value).filter(([id, value]) => beneficiaries.value.includes(id) && value > 0).map(([id, value]) => [id, Math.floor(value)]))
  expenses.value.push({ id: crypto.randomUUID(), title: title.value.trim(), amount: amount.value!, payerId: payerId.value, participantIds: [...beneficiaries.value], discounts })
  title.value = ''; amount.value = null; draftDiscounts.value = {}; showDiscounts.value = false; errors.value.expense = ''
}

async function copyMessage() {
  if (!message.value) return
  await navigator.clipboard.writeText(message.value)
  copied.value = true; setTimeout(() => copied.value = false, 1800)
}

function requestClearExpenses() {
  if (!confirmingExpenseClear.value) {
    confirmingExpenseClear.value = true
    window.setTimeout(() => { confirmingExpenseClear.value = false }, 4000)
    return
  }
  expenses.value = []
  confirmingExpenseClear.value = false
}

onMounted(async () => {
  const stored = localStorage.getItem('wari-data')
  if (stored) try {
    const data = JSON.parse(stored)
    if (data.participants?.length) participants.value = data.participants
    if (Array.isArray(data.expenses)) expenses.value = data.expenses
    if (data.rounding) rounding.value = data.rounding
    payerId.value = participants.value[0]?.id ?? ''
    beneficiaries.value = participants.value.map(p => p.id)
  } catch { /* ignore invalid saved data */ }
  try {
    if (await finishTraqLogin()) loggedIn.value = true
    await loadTraqUsers()
  } catch (e) { authError.value = e instanceof Error ? e.message : 'OAuthログインに失敗しました' }
})
watch([participants, expenses, rounding], () => localStorage.setItem('wari-data', JSON.stringify({ participants: participants.value, expenses: expenses.value, rounding: rounding.value })), { deep: true })
</script>

<template>
  <div class="app-shell">
    <header>
      <a class="brand" href="#"><span class="brand-mark">W</span><span>Wari</span></a>
      <div class="header-actions">
        <div class="saved"><span></span> この端末に自動保存</div>
        <button v-if="!loggedIn" class="login-btn" :disabled="authBusy || !hasTraqConfig()"
          @click="beginTraqLogin">traQでログイン</button>
        <button v-else class="login-btn logged" @click="signOut">traQ 接続済み · ログアウト</button>
      </div>
    </header>

    <main>
      <section class="hero">
        <p class="eyebrow">SPLIT IT. SETTLE IT.</p>
        <h1>きれいに割って、<br><em>すっきり帰ろう。</em></h1>
        <p>立替をまとめて、誰が誰にいくら払うかを最短で。<br>データはこの端末から外へ出ません。</p>
      </section>

      <div class="workspace">
        <div class="inputs">
          <section class="card">
            <div class="section-head"><span class="step">01</span>
              <div>
                <h2>参加者</h2>
                <p>一緒に割るメンバーを追加</p>
              </div><span class="count">{{ participants.length }}人</span>
            </div>
            <div v-if="participants.length" class="people">
              <div v-for="p in participants" :key="p.id" class="person-row">
                <span class="avatar">{{ p.displayName.slice(0, 1).toUpperCase() }}</span>
                <div><strong>{{ p.displayName }}</strong><small>@{{ p.name }}</small></div>
                <button class="icon-btn" :disabled="participants.length === 1" :aria-label="`${p.name}を削除`"
                  @click="removeParticipant(p.id)">×</button>
              </div>
            </div>
            <div v-else class="empty-people">まだ参加者はいません。traQから検索するか、traP IDを入力して追加してください。</div>
            <div v-if="loggedIn" class="traq-search">
              <label><span>traQユーザーから検索</span><input v-model="userQuery" placeholder="traP ID または表示名"
                  autocomplete="off"></label>
              <div v-if="userCandidates.length" class="candidate-list">
                <button v-for="u in userCandidates" :key="u.id" type="button" @click="addTraqUser(u)"><span
                    class="avatar">{{ u.displayName.slice(0, 1).toUpperCase() }}</span><span><strong>{{ u.displayName
                      }}</strong><small>@{{ u.name }}</small></span><b>＋</b></button>
              </div>
            </div>
            <p v-if="authError" class="error">{{ authError }}</p>
            <form class="add-person" @submit.prevent="addParticipant">
              <label><span>traP ID</span><input v-model="newName" placeholder="例: sahara" autocomplete="off"></label>
              <label><span>表示名</span><input v-model="newDisplayName" placeholder="省略可" autocomplete="off"></label>
              <button class="secondary" type="submit">＋ 追加</button>
            </form>
            <p v-if="errors.participant" class="error">{{ errors.participant }}</p>
          </section>

          <section class="card">
            <div class="section-head"><span class="step">02</span>
              <div>
                <h2>立替を追加</h2>
                <p>支払いごとに入力</p>
              </div>
            </div>
            <form class="expense-form" @submit.prevent="addExpense">
              <label class="wide"><span>支払名</span><input v-model="title" placeholder="例: 東急ストア"></label>
              <label><span>金額</span>
                <div class="yen-input"><input v-model.number="amount" type="number" min="1" step="1"
                    placeholder="0"><b>円</b></div>
              </label>
              <label><span>立替者</span><select v-model="payerId" :disabled="!participants.length">
                  <option v-if="!participants.length" value="">参加者を先に追加</option>
                  <option v-for="p in participants" :key="p.id" :value="p.id">@{{ p.name }}</option>
                </select></label>
              <fieldset class="wide">
                <legend>負担する人</legend>
                <div class="chips"><button v-for="p in participants" :key="p.id" type="button"
                    :class="{ active: beneficiaries.includes(p.id) }" @click="toggleBeneficiary(p.id)"><span>✓</span>
                    @{{ p.name }}</button></div>
              </fieldset>
              <div v-if="beneficiaries.length > 1" class="wide optional-actions"><button class="breakdown-btn" type="button" @click="showDiscounts = !showDiscounts">{{ showDiscounts ? '割引を閉じる' : '割引' }}</button></div>
              <fieldset v-if="beneficiaries.length > 1 && showDiscounts" class="wide discount-field">
                <legend>人ごとの割引 <small>割引分はほかの負担者に配分</small></legend>
                <div class="discount-grid"><label v-for="id in beneficiaries" :key="id"><span>@{{ person(id)?.name
                      }}</span>
                    <div class="yen-input"><input v-model.number="draftDiscounts[id]" type="number" min="0"
                        :max="amount ?? undefined" step="1" placeholder="0"><b>円</b></div>
                  </label></div>
              </fieldset>
              <button class="primary wide" type="submit">立替を追加する <span>→</span></button>
            </form>
            <p v-if="errors.expense" class="error">{{ errors.expense }}</p>
          </section>

          <section v-if="expenses.length" class="card compact">
            <div class="section-head"><span class="step">03</span>
              <div>
                <h2>立替一覧</h2>
                <p>{{ expenses.length }}件の支払い</p>
              </div><button class="clear-expenses" :class="{ confirming: confirmingExpenseClear }"
                @click="requestClearExpenses">{{ confirmingExpenseClear ? 'もう一度押して全削除' : '立替を全削除' }}</button>
            </div>
            <div class="expense-list">
              <div v-for="e in expenses" :key="e.id" class="expense-entry">
                <div class="expense-summary"><div><strong>{{ e.title }}</strong><small>@{{ person(e.payerId)?.name }} が立替 · {{
                  e.participantIds.length }}人で負担<span v-if="Object.values(e.discounts ?? {}).some(Boolean)"> ·
                      割引あり</span></small></div><b>{{ money(e.amount) }}</b>
                  <button class="breakdown-btn" type="button" @click="openBreakdown(e)">{{ editingBreakdownId === e.id ? '閉じる' : '内訳' }}</button>
                  <button class="icon-btn" aria-label="立替を削除" @click="expenses = expenses.filter(x => x.id !== e.id)">×</button></div>
                <div v-if="(e.breakdowns ?? []).length" class="breakdown-list">
                  <div v-for="item in e.breakdowns" :key="item.id">
                    <span><strong>{{ item.title }} <i v-if="item.taxRate" class="tax-label">税率{{ item.taxRate }}%</i></strong><small>{{ item.participantIds.map(id => `@${person(id)?.name}`).join('、') }}</small></span>
                    <span class="breakdown-price"><small v-if="item.taxRate">税抜 {{ money(taxExcluded(item)) }}</small><b>{{ money(item.amount) }}</b></span>
                    <button class="icon-btn" type="button" aria-label="内訳を削除" @click="removeBreakdown(e, item.id)">×</button>
                  </div>
                  <p>元の配分に残る金額 <b>{{ money(breakdownRemaining(e)) }}</b></p>
                </div>
                <form v-if="editingBreakdownId === e.id" class="breakdown-form" @submit.prevent="addBreakdown(e)">
                  <div class="breakdown-fields">
                    <label><span>内訳名</span><input v-model="breakdownTitle" placeholder="例: お酒代"></label>
                    <label><span>税抜金額（税込 {{ money(draftTaxIncluded) }}／残り {{ money(breakdownRemaining(e)) }}）</span><div class="yen-input"><input v-model.number="breakdownAmount" type="number" min="0" step="1" placeholder="0"><b>円</b></div></label>
                  </div>
                  <div class="tax-rate-field"><span>税率</span><div><button type="button" :class="{ active: breakdownTaxRate === null }" @click="breakdownTaxRate = null">なし</button><button type="button" :class="{ active: breakdownTaxRate === 8 }" @click="breakdownTaxRate = 8">8%</button><button type="button" :class="{ active: breakdownTaxRate === 10 }" @click="breakdownTaxRate = 10">10%</button></div></div>
                  <fieldset><legend>負担する人</legend><div class="chips"><button v-for="p in participants" :key="p.id" type="button" :class="{ active: breakdownParticipants.includes(p.id) }" @click="toggleBreakdownParticipant(p.id)"><span>✓</span> @{{ p.name }}</button></div></fieldset>
                  <p v-if="breakdownError" class="error">{{ breakdownError }}</p>
                  <button class="secondary" type="submit">＋ 内訳を追加</button>
                </form>
              </div>
            </div>
          </section>
        </div>

        <aside>
          <section class="result-card">
            <div class="result-top">
              <div><span>支払総額</span><strong>{{ total.toLocaleString('ja-JP') }}<small>円</small></strong></div>
              <div><span>精算</span><b>{{ settlements.length }}件</b></div>
            </div>
            <div class="rounding"><span>丸め設定</span>
              <div><button :class="{ active: rounding === 'none' }" @click="rounding = 'none'">なし</button><button
                  :class="{ active: rounding === 'ceil10' }" @click="rounding = 'ceil10'">10円↑</button><button
                  :class="{ active: rounding === 'floor10' }" @click="rounding = 'floor10'">10円↓</button></div>
            </div>
            <div class="settle-title">
              <h2>精算方法</h2><span>最小の送金回数</span>
            </div>
            <div v-if="settlements.length" class="settlements">
              <div v-for="(s, i) in settlements" :key="`${s.from}-${s.to}`" class="settlement">
                <span class="number">{{ String(i + 1).padStart(2, '0') }}</span>
                <div class="flow"><strong>@{{ person(s.from)?.name }}</strong><span><i></i>送る →</span><strong>@{{
                    person(s.to)?.name }}</strong></div>
                <b>{{ money(s.amount) }}</b>
              </div>
            </div>
            <div v-else class="empty">精算はありません</div>
            <button class="copy" :disabled="!settlements.length" @click="copyMessage">{{ copied ? 'コピーしました ✓' :
              'traQ用メッセージをコピー' }}</button>
            <p class="privacy">● データはブラウザ内だけに保存されます</p>
          </section>

          <section class="balances">
            <div class="settle-title">
              <h2>メンバー別</h2><span>負担 / 立替 / 収支</span>
            </div>
            <div v-for="r in results" :key="r.id" class="balance-row">
              <span class="avatar small">{{ r.displayName.slice(0, 1).toUpperCase() }}</span>
              <div><strong>@{{ r.name }}</strong><small>{{ money(r.burden) }} / {{ money(r.paid) }}</small></div>
              <b :class="r.balance > 0 ? 'positive' : r.balance < 0 ? 'negative' : ''">{{ r.balance > 0 ? '+' :
                r.balance < 0 ? '−' : '' }}{{ money(r.balance) }}</b>
            </div>
          </section>
        </aside>
      </div>
    </main>
    <footer><span>Wari</span>
      <p>割り勘を、もっと気持ちよく。</p><small>LOCAL FIRST · NO DATA SENT</small>
    </footer>
  </div>
</template>

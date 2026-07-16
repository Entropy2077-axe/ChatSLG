import { v4 as uuid } from 'uuid'
import { db } from '../db/db'
import { useSettingsStore } from '../store/useSettingsStore'
import type { WalletOwnerId, WalletTransactionKind } from '../types'

export const USER_WALLET_ID = 'user'

export function salaryForWorldDays(monthlySalary: number, elapsedWorldDays: number): number {
  return Math.max(0, Math.round(Math.max(0, monthlySalary) / 30 * Math.max(0, Math.floor(elapsedWorldDays))))
}

/** Pays the difference between two cumulative world-day salary totals so
 * rounding is stable whether days are settled one-by-one or in a catch-up. */
export function salaryForWorldRange(monthlySalary: number, jobStartedWorldDay: number, fromWorldDay: number, toWorldDay: number): number {
  const salary = Math.max(0, monthlySalary)
  const start = Math.max(1, Math.floor(jobStartedWorldDay))
  const from = Math.max(start, Math.floor(fromWorldDay))
  const to = Math.max(from, Math.floor(toWorldDay))
  return Math.max(0, Math.round(salary * (to - start) / 30) - Math.round(salary * (from - start) / 30))
}

export async function ensureWallets(): Promise<void> {
  const settings = useSettingsStore.getState()
  await db.transaction('rw', db.walletAccounts, db.walletTransactions, db.contacts, async () => {
    if (!(await db.walletAccounts.get(USER_WALLET_ID))) {
      const amount = Math.max(0, Math.round(settings.walletBalance || 0))
      await db.walletAccounts.add({ ownerId: USER_WALLET_ID, balance: amount, updatedAt: Date.now() })
      if (amount) await db.walletTransactions.add({ id: uuid(), idempotencyKey: 'legacy-wallet-migration', kind: 'migration', toOwnerId: USER_WALLET_ID, amount, status: 'completed', createdAt: Date.now(), completedAt: Date.now() })
    }
    for (const contact of await db.contacts.toArray()) {
      if (!(await db.walletAccounts.get(contact.id))) await db.walletAccounts.add({ ownerId: contact.id, balance: 0, updatedAt: Date.now() })
    }
  })
  if (!settings.walletMigrated) settings.setSettings({ walletMigrated: true })
}

export async function balanceOf(ownerId: WalletOwnerId): Promise<number> { return (await db.walletAccounts.get(ownerId))?.balance ?? 0 }

export async function transferFunds(opts: { from?: WalletOwnerId; to?: WalletOwnerId; amount: number; kind: WalletTransactionKind; note?: string; idempotencyKey?: string }) {
  const amount = Math.round(opts.amount)
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('金额必须是正整数')
  if (!opts.from && !opts.to) throw new Error('资金交易缺少账户')
  return db.transaction('rw', db.walletAccounts, db.walletTransactions, async () => {
    if (opts.idempotencyKey) {
      const existing = await db.walletTransactions.where('idempotencyKey').equals(opts.idempotencyKey).first()
      if (existing) return existing
    }
    const now = Date.now()
    if (opts.from) {
      const account = await db.walletAccounts.get(opts.from)
      if (!account || account.balance < amount) throw new Error('余额不足')
      await db.walletAccounts.update(opts.from, { balance: account.balance - amount, updatedAt: now })
    }
    if (opts.to) {
      const account = await db.walletAccounts.get(opts.to) ?? { ownerId: opts.to, balance: 0, updatedAt: now }
      await db.walletAccounts.put({ ...account, balance: account.balance + amount, updatedAt: now })
    }
    const row = { id: uuid(), idempotencyKey: opts.idempotencyKey, kind: opts.kind, fromOwnerId: opts.from, toOwnerId: opts.to, amount, note: opts.note, status: 'completed' as const, createdAt: now, completedAt: now }
    await db.walletTransactions.add(row)
    return row
  })
}

export async function setUserBalance(target: number) {
  return setWalletBalance(USER_WALLET_ID, target)
}
export async function setWalletBalance(ownerId: WalletOwnerId, target: number) {
  const rounded = Math.max(0, Math.round(target))
  await ensureWallets()
  const current = await balanceOf(ownerId)
  if (current === rounded) return
  await transferFunds({ from: current > rounded ? ownerId : undefined, to: rounded > current ? ownerId : undefined, amount: Math.abs(rounded - current), kind: 'admin_adjustment', note: `管理员设定余额为 ${rounded}` })
}
export async function reserveRedPacket(from: WalletOwnerId, amount: number, note?: string) {
  const tx = await transferFunds({ from, amount, kind: 'red_packet', note })
  await db.walletTransactions.update(tx.id, { status: 'reserved', completedAt: undefined })
  return { ...tx, status: 'reserved' as const }
}
export async function claimRedPacket(transactionId: string, to: WalletOwnerId) {
  return db.transaction('rw', db.walletAccounts, db.walletTransactions, async () => {
    const tx = await db.walletTransactions.get(transactionId)
    if (!tx || tx.kind !== 'red_packet' || tx.status !== 'reserved') throw new Error('红包已领取或不存在')
    const account = await db.walletAccounts.get(to) ?? { ownerId: to, balance: 0, updatedAt: Date.now() }
    await db.walletAccounts.put({ ...account, balance: account.balance + tx.amount, updatedAt: Date.now() })
    await db.walletTransactions.update(tx.id, { toOwnerId: to, status: 'completed', completedAt: Date.now() })
  })
}

export async function settleSalaries(worldDay: number): Promise<void> {
  const settings = useSettingsStore.getState()
  await ensureWallets()
  const currentDay = Math.max(1, Math.floor(worldDay))
  if (settings.userOccupation && settings.userMonthlySalary > 0) {
    if (settings.userLastSalaryWorldDay === undefined) {
      settings.setSettings({ userJobStartedWorldDay: settings.userJobStartedWorldDay ?? currentDay, userLastSalaryWorldDay: currentDay })
    } else {
      const days = Math.max(0, currentDay - settings.userLastSalaryWorldDay)
      const amount = salaryForWorldRange(settings.userMonthlySalary, settings.userJobStartedWorldDay ?? settings.userLastSalaryWorldDay, settings.userLastSalaryWorldDay, currentDay)
      if (amount > 0) await transferFunds({ to: USER_WALLET_ID, amount, kind: 'salary', note: `${settings.userOccupation}·世界第${currentDay}日工资`, idempotencyKey: `salary:user:world-day:${currentDay}` })
      if (days > 0) settings.setSettings({ userLastSalaryWorldDay: currentDay })
    }
  }
  for (const c of await db.contacts.toArray()) {
    if (!c.occupation || !c.monthlySalary) continue
    if (c.lastSalaryWorldDay === undefined) {
      await db.contacts.update(c.id, { jobStartedWorldDay: c.jobStartedWorldDay ?? currentDay, lastSalaryWorldDay: currentDay })
      continue
    }
    const days = Math.max(0, currentDay - c.lastSalaryWorldDay)
    const amount = salaryForWorldRange(c.monthlySalary, c.jobStartedWorldDay ?? c.lastSalaryWorldDay, c.lastSalaryWorldDay, currentDay)
    if (amount > 0) await transferFunds({ to: c.id, amount, kind: 'salary', note: `${c.occupation}·世界第${currentDay}日工资`, idempotencyKey: `salary:${c.id}:world-day:${currentDay}` })
    if (days > 0) await db.contacts.update(c.id, { lastSalaryWorldDay: currentDay })
  }
}

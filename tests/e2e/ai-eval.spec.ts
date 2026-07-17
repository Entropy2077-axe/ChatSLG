import { expect, test } from 'playwright/test'

test('AI测试台使用隔离数据库、可运行mock并保持移动端内部滚动', async ({ page }) => {
  await page.goto('/#/phone')
  await page.waitForSelector('.app-shell')
  await page.waitForTimeout(250)
  await page.evaluate(async () => {
    const { db } = await import('/src/db/db.ts')
    const { useSettingsStore } = await import('/src/store/useSettingsStore.ts')
    for (const table of db.tables) await table.clear()
    useSettingsStore.getState().setSettings({ adminModeEnabled: true, apiKey: 'sk-e2e-must-never-render' })
    await db.contacts.add({
      id: 'user-owned-contact',
      name: '用户正式联系人',
      avatar: '🙂',
      avatarColor: '#fff',
      systemPrompt: '正式数据',
      createdAt: 1,
      memoryFacts: '',
      memoryStyle: '',
      memoryUpdatedAt: 0,
      memoryMessageCursor: 0,
      relationshipBase: '朋友',
      relationshipDynamic: '',
    })
  })

  await page.goto('/?__aiEvalDb=chatslg-ai-eval-e2e#/ai-eval')
  await expect(page.getByText('AI测试台 · 隔离')).toBeVisible()
  const isolation = await page.evaluate(async () => {
    const { db, isAiEvalDatabase } = await import('/src/db/db.ts')
    return {
      name: db.name,
      isolated: isAiEvalDatabase,
      hasUserContact: !!(await db.contacts.get('user-owned-contact')),
      shellHeight: document.querySelector('.app-shell')?.getBoundingClientRect().height,
      viewportHeight: window.innerHeight,
    }
  })
  expect(isolation).toMatchObject({
    name: 'chatslg-ai-eval-e2e',
    isolated: true,
    hasUserContact: false,
  })
  expect(isolation.shellHeight).toBe(isolation.viewportHeight)
  await expect(page.locator('body')).not.toContainText('sk-e2e-must-never-render')

  await page.locator('select').nth(0).selectOption('development')
  await page.locator('select').nth(1).selectOption('fault_recovery')
  await page.getByRole('button', { name: '运行测试集内分类' }).click()
  await expect(page.getByText('14/14').first()).toBeVisible()
  await expect(page.getByText('0.0%').first()).toBeVisible()
  await expect(page.getByText('真实 / Mock').locator('..')).toContainText('0/14')

  await page.goto('/#/phone')
  const normalDatabase = await page.evaluate(async () => {
    const { db, isAiEvalDatabase } = await import('/src/db/db.ts')
    return {
      name: db.name,
      isolated: isAiEvalDatabase,
      hasUserContact: !!(await db.contacts.get('user-owned-contact')),
    }
  })
  expect(normalDatabase).toEqual({
    name: 'chatslg-db',
    isolated: false,
    hasUserContact: true,
  })
})

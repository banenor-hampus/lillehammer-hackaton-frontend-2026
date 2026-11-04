import { expect, test } from '@playwright/test'

test('loads the available stations from the API', async ({ page }) => {
  await page.goto('/')

  const stationSelect = page.getByLabel('Stasjon')
  await expect(stationSelect).toBeEnabled()
  await expect(stationSelect).toHaveValue('MOCK:Quay:1002')
  await expect(stationSelect.getByRole('option')).toHaveCount(14)
})

test('searches departures and shows replacement journey details', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Reisedato').fill('2026-11-03')
  await page.getByLabel('Avganger per side').fill('20')
  await page.getByRole('button', { name: 'Finn avganger' }).click()

  const cards = page.locator('.departure-card')
  await expect(cards).toHaveCount(8)

  const replacementCard = cards.filter({
    has: page.getByRole('heading', { name: 'R501', exact: true }),
  })
  await expect(replacementCard.locator('.replacement-badge')).toHaveText(/Buss for tog/)
  await replacementCard.locator('summary').click()
  await expect(replacementCard.getByText('Erstatter tog 501')).toBeVisible()
  await expect(replacementCard.getByRole('heading', { name: 'Stopp på ruta' })).toBeVisible()
})

test('shows each departure ID only once when the API returns duplicate observations', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Reisedato').fill('2026-11-03')
  const departuresResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname === '/api/avganger',
  )
  await page.getByRole('button', { name: 'Finn avganger' }).click()
  const body = await (await departuresResponse).json() as {
    data: { quays: Array<{ estimatedCalls: Array<{ datedServiceJourney: { id: string } }> }> }
  }
  const observedIds = body.data.quays.flatMap((quay) =>
    quay.estimatedCalls.map((call) => call.datedServiceJourney.id),
  )

  expect(observedIds).toHaveLength(9)
  expect(new Set(observedIds).size).toBe(8)

  const cards = page.locator('.departure-card')
  await expect(cards).toHaveCount(8)
  const displayedIds = await page.locator('.departure-id').allTextContents()
  expect(displayedIds).toHaveLength(8)
  expect(new Set(displayedIds).size).toBe(displayedIds.length)
})

test('explains an invalid time window before making a search', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel(/Tidsvindu/).fill('49:00')
  await page.getByRole('button', { name: 'Finn avganger' }).click()

  await expect(page.getByText('Skriv tidsvindu som HH:MM, fra 00:00 til 48:00.')).toBeVisible()
  await expect(page.locator('.departure-card')).toHaveCount(0)
})

test('shows a recoverable error when the API is unreachable during startup', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/api/stasjoner', (route) => route.abort('failed'))

  await page.goto('/')

  await expect(page.getByRole('alert')).toContainText('Kunne ikke hente data')
  await expect(page.getByRole('heading', { name: 'Hvor skal du reise?' })).toBeVisible()
  expect(pageErrors).toEqual([])
})

test('keeps other departures usable when one journey detail request returns 503', async ({ page }) => {
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.route('**/api/rutedetaljer*', async (route) => {
    const id = new URL(route.request().url()).searchParams.get('id')
    if (id?.endsWith('-06')) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': 'http://localhost:5173' },
        body: JSON.stringify({ errors: [{ message: 'Simulert detaljfeil' }] }),
      })
      return
    }
    await route.continue()
  })

  await page.goto('/')
  await page.getByLabel('Reisedato').fill('2026-11-03')
  await page.getByRole('button', { name: 'Finn avganger' }).click()

  const cards = page.locator('.departure-card')
  const failedCard = cards.filter({ hasText: '-06' })
  await expect(cards).toHaveCount(8)
  await expect(failedCard.locator('.detail-error-message')).toContainText('Datakilden er midlertidig utilgjengelig')
  await expect(page.getByRole('status').filter({ hasText: 'Henter rutedetaljer' })).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
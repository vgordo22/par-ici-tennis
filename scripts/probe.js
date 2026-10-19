// Diagnostic: search several tennis at once and describe the results page structure
import { chromium } from 'playwright'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { config } from '../staticFiles.js'
dayjs.extend(customParseFormat)
const log = (m) => console.log(`${dayjs().format()} - ${m}`)
process.on('uncaughtException', (e) => { log(`crash: ${String(e.message).split('\n')[0]}`); process.exit(0) })
process.on('unhandledRejection', (e) => { log(`crash: ${String(e?.message || e).split('\n')[0]}`); process.exit(0) })
log('probe start')

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captcha-invisible/invisible-captcha-infos', (r) => r.abort())
await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captchas**', (r) => r.abort())
page.setDefaultTimeout(30000)
try {
  const t0 = Date.now()
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')
  await page.click('#button_suivi_inscription')
  await page.fill('#username', process.env.ACCOUNT_EMAIL)
  await page.fill('#password', process.env.ACCOUNT_PASSWORD)
  await page.click('#form-login >> button')
  await page.waitForSelector('.main-informations')
  log(`login ${Date.now() - t0} ms`)
  const locations = Array.isArray(config.locations) ? config.locations : Object.keys(config.locations)
  log(`config locations: ${JSON.stringify(locations)} hours ${JSON.stringify(config.hours)} courtType ${JSON.stringify(config.courtType)}`)

  const t1 = Date.now()
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!')
  const tokenInput = page.locator('.tokens-input-text')
  const tokens = page.locator('#whereToken li:not(.tokens-list-input-holder)')
  for (let k = 0; k < 12 && await tokens.count(); k++) { await tokenInput.click(); await tokenInput.press('Backspace'); await page.waitForTimeout(150) }
  for (const loc of locations) {
    await tokenInput.pressSequentially(`${loc} `)
    const sugg = page.locator(`.tokens-suggestions-list-element >> text="${loc}"`)
    const ok = await sugg.waitFor({ timeout: 8000 }).then(() => true).catch(() => false)
    if (!ok) {
      const all = await page.locator('.tokens-suggestions-list-element').allInnerTexts().catch(() => [])
      log(`suggestion introuvable pour "${loc}", proposées: ${JSON.stringify(all.slice(0, 6))}`)
      await tokenInput.fill('')
      continue
    }
    await sugg.click()
  }
  log(`tokens selectionnes: ${JSON.stringify(await tokens.allInnerTexts())}`)
  const formInfo = await page.evaluate(() => {
    const b = document.querySelector('#rechercher'); const f = b && b.form
    return f ? { action: f.getAttribute('action'), method: f.method, fields: [...new FormData(f).entries()].map(([k, v]) => `${k}=${String(v).slice(0, 40)}`) } : { noform: true, btn: b && b.outerHTML.slice(0, 200) }
  })
  log(`form avant date: ${JSON.stringify(formInfo)}`)
  await page.click('#when')
  const date = config.date ? dayjs(config.date, 'D/MM/YYYY') : dayjs().add(6, 'days')
  await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
  await page.waitForSelector('.date-picker', { state: 'hidden' })
  await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), page.click('#rechercher')])
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {})
  log(`url apres recherche: ${page.url()}`)
  const req = await page.evaluate(() => performance.getEntriesByType('navigation').map((n) => `${n.name} ${Math.round(n.duration)}ms ttfb ${Math.round(n.responseStart - n.requestStart)}ms`))
  log(`navigation: ${JSON.stringify(req)}`)
  log(`recherche multi-tennis ${Date.now() - t1} ms, titre "${await page.title()}"`)

  const info = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('[id^="head"]')].map((h) => h.id)
    const btns = [...document.querySelectorAll('[datedeb]')]
    const sample = btns.slice(0, 3).map((b) => {
      const chain = []
      let el = b
      for (let d = 0; d < 9 && el; d++) { chain.push(`${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${[...el.classList].join('.')}`); el = el.parentElement }
      const attrs = [...b.attributes].map((a) => `${a.name}=${a.value}`).join(' ')
      return { attrs, chain: chain.join(' < ') }
    })
    const tennisBlocks = [...document.querySelectorAll('[id^="head"]')].slice(0, 2).map((h) => h.outerHTML.replace(/\s+/g, ' ').slice(0, 300))
    return { heads, nBtns: btns.length, sample, tennisBlocks }
  })
  log(`nb boutons creneaux: ${info.nBtns}`)
  log(`heads (${info.heads.length}): ${info.heads.slice(0, 40).join(', ')}`)
} catch (e) {
  log(`probe erreur: ${String(e.message).split('\n')[0]}`)
}
await browser.close()

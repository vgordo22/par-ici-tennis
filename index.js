import { chromium } from 'playwright'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { writeFileSync } from 'fs'
import { createEvent } from 'ics'
import { config } from './staticFiles.js'
import { notify } from './lib/ntfy.js'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.extend(customParseFormat)

const SEARCH_URL = 'https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!'
const log = (m) => console.log(`${dayjs().format('YYYY-MM-DDTHH:mm:ss.SSSZ')} - ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const noSpace = (s) => s.replaceAll(' ', '')

const ntfyEnabled = () => config.ntfy?.enable === true || !!process.env.NTFY_TOPIC
const ntfyText = async (text) => {
  if (!ntfyEnabled()) return
  try {
    await fetch(`https://${config?.ntfy?.domain || process.env.NTFY_DOMAIN || 'ntfy.sh'}/${config?.ntfy?.topic || process.env.NTFY_TOPIC}`, {
      method: 'POST',
      headers: { Title: 'Paris Tennis', Tags: 'tennis' },
      body: text,
    })
    console.log('Notification sent via ntfy')
  } catch (err) {
    console.log('Error while sending notification using ntfy:', err)
  }
}

// Wait until 08:00:00 Paris time plus a small margin (only for the scheduled run)
const waitUntil8 = async () => {
  const offsetMs = Number(process.env.START_OFFSET_MS ?? 100)
  const now = dayjs().tz('Europe/Paris')
  const target = now.hour(8).minute(0).second(0).millisecond(0).add(offsetMs, 'ms')
  const ms = target.diff(now)
  if (ms <= 0) return
  log(`Prêt, attente jusqu'à 08:00:00 (+${offsetMs} ms), ${Math.round(ms / 1000)} s`)
  if (ms > 1500) await sleep(ms - 1500)
  while (dayjs().tz('Europe/Paris').isBefore(target)) await sleep(5)
}

// Select every configured tennis in the search form (one search covers all of them)
const prepareSearchForm = async (page, locations) => {
  await page.goto(SEARCH_URL)
  const tokenInput = page.locator('.tokens-input-text')
  const tokens = page.locator('#whereToken li:not(.tokens-list-input-holder)')
  // the site remembers the last search: if it already holds exactly our tennis, keep them
  const current = (await tokens.allInnerTexts()).map((t) => t.split('\n')[0].trim())
  if (current.length === locations.length && locations.every((l) => current.includes(l))) return
  for (let k = 0; k < 15 && await tokens.count(); k++) {
    await tokenInput.click({ timeout: 10000 })
    await tokenInput.press('Backspace')
    await page.waitForTimeout(150)
  }
  for (const loc of locations) {
    await tokenInput.pressSequentially(`${loc} `)
    const sugg = page.locator(`.tokens-suggestions-list-element >> text="${loc}"`)
    const ok = await sugg.first().waitFor({ timeout: 10000 }).then(() => true).catch(() => false)
    if (!ok) {
      log(`Tennis "${loc}" introuvable dans la liste du site, vérifie l'orthographe dans ta config`)
      await tokenInput.fill('').catch(() => {})
      continue
    }
    await sugg.first().click()
  }
  log(`Tennis sélectionnés : ${(await tokens.allInnerTexts()).map((t) => t.split('\n')[0].trim()).join(', ')}`)
}

// Pick the date and launch the search
const runSearch = async (page, date) => {
  await page.click('#when')
  await page.waitForSelector(`[dateiso="${date.format('DD/MM/YYYY')}"]`, { timeout: 10000 })
  await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
  await page.waitForSelector('.date-picker', { state: 'hidden' })
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
    page.click('#rechercher'),
  ])
  // results are in the HTML itself, no need to wait for every network request to settle
  await page.waitForSelector('.search-result-block, #courtList, .tennis-court, .no-result, .alert', { timeout: 3000 }).catch(() => {})
}

// From the results page, list matching slots ordered by tennis priority then hour priority
const findCandidates = async (page, locations, date, exclude) => {
  const out = []
  for (const [i, location] of locations.entries()) {
    const list = page.locator(`#courtList${noSpace(location)}`)
    if (!await list.count()) continue
    const courtNumbers = !Array.isArray(config.locations) ? (config.locations[location] || []) : []
    for (const hour of config.hours) {
      const h = String(hour).padStart(2, '0')
      const dateDeb = `[datedeb="${date.format('YYYY/MM/DD')} ${h}:00:00"]`
      const slots = await list.locator(dateDeb).all()
      for (const slot of slots) {
        const courtid = await slot.getAttribute('courtid')
        if (exclude.has(courtid + dateDeb)) continue
        const row = list.locator(`.row.tennis-court:has([courtid="${courtid}"]${dateDeb})`)
        if (courtNumbers.length > 0) {
          const courtName = (await row.locator('.court').first().innerText().catch(() => '')).trim()
          const m = courtName.match(/Court N°(\d+)/)
          if (!m || !courtNumbers.includes(parseInt(m[1]))) continue
        }
        const [priceType, courtType] = (await row.locator('.price-description').first().innerHTML()).split('<br>').map((s) => s.trim())
        if (!config.priceType.includes(priceType) || !config.courtType.includes(courtType)) continue
        out.push({ index: i, location, hour: h, courtid, dateDeb, courtType })
      }
    }
  }
  return out
}

const expandPanel = async (page, location, hour, button) => {
  if (!await button.isHidden()) return
  await page.click(`#head${noSpace(location)}${hour}h .panel-title`, { timeout: 3000 }).catch(async () => {
    await button.evaluate((el) => el.closest('.panel')?.querySelector('.panel-title')?.click())
  })
  await button.waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
}

const bookTennis = async () => {
  const DRY_RUN_MODE = process.argv.includes('--dry-run')
  const WAIT_8AM = !!process.env.WAIT_8AM && !DRY_RUN_MODE
  if (DRY_RUN_MODE) {
    console.log('----- DRY RUN START -----')
    console.log('Script lancé en mode DRY RUN. Afin de tester votre configuration, une recherche va être lancé mais AUCUNE réservation ne sera réalisée')
  }

  const locations = !Array.isArray(config.locations) ? Object.keys(config.locations) : config.locations
  log('Starting searching tennis')
  const browser = await chromium.launch({ headless: true, slowMo: 0, timeout: 90000 })
  log('Browser started')
  const page = await browser.newPage()
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captcha-invisible/invisible-captcha-infos', (route) => route.abort())
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captchas**', (route) => route.abort())
  page.setDefaultTimeout(30000)

  try {
    // ---- preparation, done before 8:00 on the scheduled run ----
    await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')
    await page.click('#button_suivi_inscription')
    await page.fill('#username', config?.account?.email || process.env.ACCOUNT_EMAIL)
    await page.fill('#password', config?.account?.password || process.env.ACCOUNT_PASSWORD)
    await page.click('#form-login >> button')
    await page.waitForSelector('.main-informations')
    log('User connected')

    await prepareSearchForm(page, locations)
    if (WAIT_8AM) await waitUntil8()

    // ---- race starts here ----
    const date = config.date ? dayjs(config.date, 'D/MM/YYYY') : dayjs().tz('Europe/Paris').add(6, 'days')
    const exclude = new Set()
    const MAX_ROUNDS = 6
    let done = false

    for (let round = 1; round <= MAX_ROUNDS && !done; round++) {
      if (round > 1) await prepareSearchForm(page, locations).catch(() => {})
      const tRun = Date.now()
      try {
        await runSearch(page, date)
        log(`Recherche ${round} lancée et chargée en ${Date.now() - tRun} ms`)
      } catch (e) {
        // date not yet open (site clock slightly behind) or slow page: retry quickly
        log(`Recherche ${round} impossible (${String(e.message).split('\n')[0]}), nouvelle tentative`)
        await sleep(400)
        continue
      }
      const tSearch = Date.now()
      const candidates = await findCandidates(page, locations, date, exclude)
      log(`Analyse des résultats en ${Date.now() - tSearch} ms`)
      log(`Recherche ${round} : ${candidates.length} créneau(x) compatible(s)${candidates.length ? `, meilleur ${candidates[0].hour}h sur location ${candidates[0].index + 1}` : ''}`)
      if (!candidates.length) {
        // right at 8:00 the slots can appear a fraction of a second late: retry the first rounds
        if (WAIT_8AM && round <= 2 && dayjs().tz('Europe/Paris').minute() === 0 && dayjs().tz('Europe/Paris').second() < 15) continue
        break
      }

      for (const c of candidates) {
        const logLocation = process.env.GITHUB_ACTIONS ? `location ${c.index + 1}` : c.location
        const button = page.locator(`#courtList${noSpace(c.location)} [courtid="${c.courtid}"]${c.dateDeb}`).first()
        try {
          // results of several tennis are shown collapsed: trigger the button directly, visible or not
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}),
            button.evaluate((el) => el.click()),
          ])
        } catch (e) {
          log(`Clic impossible sur ${c.hour}h ${logLocation} : ${String(e.message).split('\n')[0]}`)
          exclude.add(c.courtid + c.dateDeb)
          continue
        }
        log(`Créneau cliqué à ${c.hour}h sur ${logLocation}`)

        // Paris Tennis allows only one booking at a time: never replace an existing one
        if (await page.getByText('déjà une réservation en cours').first().isVisible().catch(() => false)) {
          log("Tu as déjà une réservation en cours sur ton compte. Le bot ne la remplace pas et s'arrête. Annule-la sur tennis.paris.fr si tu veux qu'il réserve à la place.")
          done = true
          break
        }
        if (await page.title() !== 'Paris | TENNIS - Reservation') {
          const msg = await page.locator('.alert, .error, .message, .modal.in, .modal.show, .swal2-popup, [role=alertdialog]').allInnerTexts().catch(() => [])
          log(`Créneau ${c.hour}h ${logLocation} pris entre-temps (${msg.join(' | ').replace(/\s+/g, ' ').slice(0, 150) || 'pas de message'}), relance de la recherche`)
          exclude.add(c.courtid + c.dateDeb)
          break // results page is stale now: search again
        }

        let submitted = false
        try {
          await page.waitForSelector('.order-steps-infos h2 >> text="1 / 3 - Validation du court"', { timeout: 20000 })

          for (const [i, player] of config.players.entries()) {
            if (i > 0) await page.click('.addPlayer')
            await page.waitForSelector(`[name="player${i + 1}"]`)
            await page.fill(`[name="player${i + 1}"] >> nth=0`, player.lastName)
            await page.fill(`[name="player${i + 1}"] >> nth=1`, player.firstName)
          }
          await page.keyboard.press('Enter')

          await page.waitForSelector('#order_select_payment_form #paymentMode', { state: 'attached' })
          const paymentMode = page.locator('#order_select_payment_form #paymentMode')
          await paymentMode.evaluate((el) => {
            el.removeAttribute('readonly')
            el.style.display = 'block'
          })
          await paymentMode.fill('existingTicket')

          if (DRY_RUN_MODE) {
            log(`Fausse réservation faite : ${logLocation} à ${c.hour}h`)
            console.log('----- DRY RUN END -----')
            console.log('Pour réellement réserver un crénau, relancez le script sans le paramètre --dry-run')
            await page.click('#previous')
            await page.click('#btnCancelBooking')
            done = true
            break
          }

          const submit = page.locator('#order_select_payment_form #envoyer')
          await submit.evaluate((el) => el.classList.remove('hide'))
          await submit.click()
          submitted = true

          // for free accounts (gratuité) the confirmation page differs, so do not fail if the usual element is missing
          const confirmed = await page.waitForSelector('.confirmReservation', { timeout: 30000 }).then(() => true).catch(() => false)
          if (!confirmed) {
            log(`Réservation validée pour ${logLocation} le ${date.format('DD/MM/YYYY')} à ${c.hour}h (page de confirmation non reconnue, vérifiez votre compte tennis.paris.fr)`)
            await ntfyText(`Réservation faite pour le ${date.format('DD/MM/YYYY')} à ${c.hour}h (${c.location})`)
            done = true
            break
          }

          const address = (await page.locator('.address').textContent()).trim().replace(/( ){2,}/g, ' ')
          const dateStr = (await page.locator('.date').textContent()).trim().replace(/( ){2,}/g, ' ')
          const court = (await page.locator('.court').textContent()).trim().replace(/( ){2,}/g, ' ')
          if (!process.env.GITHUB_ACTIONS) {
            log(`Réservation faite : ${address}`)
            console.log(`pour le ${dateStr}`)
            console.log(`sur le ${court}`)
          } else {
            log(`Réservation faite pour ${logLocation} le ${date.format('DD/MM/YYYY')} à ${c.hour}h`)
          }

          const hourMatch = dateStr.match(/(\d{2})h/)
          const hour = hourMatch ? Number(hourMatch[1]) : Number(c.hour)
          const createdEvent = createEvent({
            start: [date.year(), date.month() + 1, date.date(), hour, 0],
            duration: { hours: 1, minutes: 0 },
            title: 'Réservation Tennis',
            description: `Court: ${court}\nAdresse: ${address}`,
            location: address,
            status: 'CONFIRMED',
          })
          if (!createdEvent.error) {
            if (!process.env.GITHUB_ACTIONS) writeFileSync('event.ics', createdEvent.value)
            if (ntfyEnabled()) {
              await notify(Buffer.from(createdEvent.value, 'utf8'), 'event.ics',
                `Confirmation pour le ${date.format('DD/MM/YYYY')} - ${hour}h`, {
                  domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
                  topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
                })
            }
          }
          done = true
          break
        } catch (e) {
          log(`Erreur pendant la réservation ${c.hour}h ${logLocation} : ${String(e?.message || e).split('\n')[0]}`)
          await page.screenshot({ path: `img/failure-round${round}.png`, fullPage: true }).catch(() => {})
          if (submitted) {
            // the booking was already sent to the site, never retry to avoid a double booking
            log("La réservation a été envoyée avant l'erreur, vérifiez votre compte tennis.paris.fr")
            done = true
            break
          }
          const cancel = page.locator('#btnCancelBooking')
          if (await cancel.count().catch(() => 0)) await cancel.first().click({ timeout: 5000 }).catch(() => {})
          exclude.add(c.courtid + c.dateDeb)
          break // search again with fresh results
        }
      }
    }

    if (!done) log('Aucune réservation faite')
  } catch (e) {
    log(`Erreur : ${String(e?.message || e).split('\n')[0]}`)
    const screenshot = await page.screenshot({ path: 'img/failure.png' }).catch(() => null)
    if (screenshot && ntfyEnabled()) {
      await notify(screenshot, 'failure.png', 'Erreur lors de l\'execution du programme.', {
        domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
        topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
      })
    }
  }

  await browser.close()
}

bookTennis()

import { chromium } from 'playwright'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { writeFileSync } from 'fs'
import { createEvent } from 'ics'
import { config } from './staticFiles.js'
import { notify } from './lib/ntfy.js'

dayjs.extend(customParseFormat)

const bookTennis = async () => {
  const DRY_RUN_MODE = process.argv.includes('--dry-run')
  if (DRY_RUN_MODE) {
    console.log('----- DRY RUN START -----')
    console.log('Script lancé en mode DRY RUN. Afin de tester votre configuration, une recherche va être lancé mais AUCUNE réservation ne sera réalisée')
  }

  console.log(`${dayjs().format()} - Starting searching tennis`)
  const browser = await chromium.launch({ headless: true, slowMo: 0, timeout: 90000 })

  console.log(`${dayjs().format()} - Browser started`)
  const page = await browser.newPage()
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captcha-invisible/invisible-captcha-infos', (route) => route.abort())
  await page.route('https://captcha.liveidentity.com/captcha/public/frontend/api/v3/captchas**', (route) => route.abort())
  page.setDefaultTimeout(90000)
  await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=tennis&view=start&full=1')

  await page.click('#button_suivi_inscription')
  await page.fill('#username', config?.account?.email || process.env.ACCOUNT_EMAIL)
  await page.fill('#password', config?.account?.password || process.env.ACCOUNT_PASSWORD)
  await page.click('#form-login >> button')

  console.log(`${dayjs().format()} - User connected`)

  // wait for login redirection before continue
  await page.waitForSelector('.main-informations')

  try {
    const locations = !Array.isArray(config.locations) ? Object.keys(config.locations) : config.locations
    const MAX_ATTEMPTS_PER_LOCATION = 2
    locationsLoop:
    for (const [i, location] of locations.entries()) {
      const logLocation = process.env.GITHUB_ACTIONS ? `location ${i + 1}` : location
      let submitted = false
      for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_LOCATION; attempt++) {
      try {
        console.log(`${dayjs().format()} - Search at ${logLocation}${attempt > 1 ? ` (tentative ${attempt})` : ''}`)
        await page.goto('https://tennis.paris.fr/tennis/jsp/site/Portal.jsp?page=recherche&view=recherche_creneau#!')

        // the site remembers tennis selected in previous searches: remove them all first
        const tokenInput = page.locator('.tokens-input-text')
        const selectedTokens = page.locator('#whereToken li:not(.tokens-list-input-holder)')
        for (let k = 0; k < 12 && await selectedTokens.count(); k++) {
          await tokenInput.click({ timeout: 10000 })
          await tokenInput.press('Backspace')
          await page.waitForTimeout(150)
        }
        const remaining = await selectedTokens.count()
        if (remaining) {
          // fallback: click the close cross of each remaining token
          for (const token of await selectedTokens.all()) {
            await token.locator('span, a, button, i').last().click({ timeout: 3000 }).catch(() => {})
          }
        }
        if (await selectedTokens.count()) {
          console.log(`${dayjs().format()} - Attention : ${await selectedTokens.count()} tennis encore sélectionné(s) avant la recherche`)
        }

        // select tennis location
        await tokenInput.pressSequentially(`${location} `)
        await page.waitForSelector(`.tokens-suggestions-list-element >> text="${location}"`)
        await page.click(`.tokens-suggestions-list-element >> text="${location}"`)

        // select date
        await page.click('#when')
        const date = config.date ? dayjs(config.date, 'D/MM/YYYY') : dayjs().add(6, 'days')
        await page.waitForSelector(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
        await page.click(`[dateiso="${date.format('DD/MM/YYYY')}"]`)
        await page.waitForSelector('.date-picker', { state: 'hidden' })

        await page.click('#rechercher')

        // wait until the results page is fully loaded before continue
        await page.waitForLoadState('domcontentloaded')

        let selectedHour
        hoursLoop:
        for (const hour of config.hours) {
          const dateDeb = `[datedeb="${date.format('YYYY/MM/DD')} ${hour}:00:00"]`
          if (await page.locator(dateDeb).count()) {
            if (await page.isHidden(dateDeb)) {
              try {
                await page.click(`#head${location.replaceAll(' ', '')}${hour}h .panel-title`, { timeout: 10000 })
              } catch {
                // fallback: expand the panel that contains this slot by clicking its own heading
                await page.locator(dateDeb).first().evaluate((el) => {
                  const panel = el.closest('.panel')
                  const title = panel && panel.querySelector('.panel-title')
                  if (title) title.click()
                })
              }
              await page.waitForTimeout(500)
            }

            const courtNumbers = !Array.isArray(config.locations) ? config.locations[location] : []
            const slots = await page.locator(dateDeb).all()
            for (const slot of slots) {
              const bookSlotButton = `[courtid="${await slot.getAttribute('courtid')}"]${dateDeb}`
              if (courtNumbers.length > 0) {
                const courtName = (await page.locator(`.court:left-of(${bookSlotButton})`).innerText()).trim()
                if (!courtNumbers.includes(parseInt(courtName.match(/Court N°(\d+)/)[1]))) {
                  continue
                }
              }

              const [priceType, courtType] = (await page.locator(`.row.tennis-court:has(${bookSlotButton})`).locator('.price-description').innerHTML()).split('<br>')
              if (!config.priceType.includes(priceType) || !config.courtType.includes(courtType)) {
                continue
              }
              selectedHour = hour
              await page.click(bookSlotButton, { timeout: 10000 })

              break hoursLoop
            }
          }
        }

        if (await page.title() !== 'Paris | TENNIS - Reservation') {
          console.log(`${dayjs().format()} - Failed to find reservation for ${logLocation}`)
          continue locationsLoop
        }

        // if the slot was taken between the search and the click, the site shows an error page instead of step 1/3
        await page.waitForSelector('.order-steps-infos h2 >> text="1 / 3 - Validation du court"', { timeout: 30000 })

        for (const [i, player] of config.players.entries()) {
          if (i > 0) {
            await page.click('.addPlayer')
          }
          await page.waitForSelector(`[name="player${i + 1}"]`)
          await page.fill(`[name="player${i + 1}"] >> nth=0`, player.lastName)
          await page.fill(`[name="player${i + 1}"] >> nth=1`, player.firstName)
        }

        await page.keyboard.press('Enter')

        await page.waitForSelector('#order_select_payment_form #paymentMode', { state: 'attached' })
        const paymentMode = page.locator('#order_select_payment_form #paymentMode')
        await paymentMode.evaluate(el => {
          el.removeAttribute('readonly')
          el.style.display = 'block'
        })
        await paymentMode.fill('existingTicket')

        if (DRY_RUN_MODE) {
          console.log(`${dayjs().format()} - Fausse réservation faite : ${logLocation}`)
          if (!process.env.GITHUB_ACTIONS) console.log(`pour le ${date.format('YYYY/MM/DD')} à ${selectedHour}h`)
          console.log('----- DRY RUN END -----')
          console.log('Pour réellement réserver un crénau, relancez le script sans le paramètre --dry-run')

          await page.click('#previous')
          await page.click('#btnCancelBooking')

          break locationsLoop
        }

        const submit = page.locator('#order_select_payment_form #envoyer')
        await submit.evaluate(el => el.classList.remove('hide'))
        await submit.click()
        submitted = true

        // for free accounts (gratuité) the confirmation page differs, so do not fail if the usual element is missing
        const confirmed = await page.waitForSelector('.confirmReservation', { timeout: 30000 }).then(() => true).catch(() => false)
        if (!confirmed) {
          console.log(`${dayjs().format()} - Réservation validée pour ${logLocation} le ${date.format('DD/MM/YYYY')} à ${selectedHour}h (page de confirmation non reconnue, vérifiez votre compte tennis.paris.fr)`)
          if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
            try {
              await fetch(`https://${config?.ntfy?.domain || process.env.NTFY_DOMAIN || 'ntfy.sh'}/${config?.ntfy?.topic || process.env.NTFY_TOPIC}`, {
                method: 'POST',
                headers: { Title: 'Paris Tennis', Tags: 'tennis' },
                body: `Réservation faite pour le ${date.format('DD/MM/YYYY')} à ${selectedHour}h (${location})`,
              })
              console.log('Notification sent via ntfy')
            } catch (err) {
              console.log('Error while sending notification using ntfy:', err)
            }
          }
          break locationsLoop
        }

        // Extract reservation details
        const address = (await page.locator('.address').textContent()).trim().replace(/( ){2,}/g, ' ')
        const dateStr = (await page.locator('.date').textContent()).trim().replace(/( ){2,}/g, ' ')
        const court = (await page.locator('.court').textContent()).trim().replace(/( ){2,}/g, ' ')

        if (!process.env.GITHUB_ACTIONS) {
          console.log(`${dayjs().format()} - Réservation faite : ${address}`)
          console.log(`pour le ${dateStr}`)
          console.log(`sur le ${court}`)
        } else {
          console.log('Réservation faite, regardez vos emails ou rendez-vous sur votre compte tennis.paris.fr pour plus de détails sur votre réservation.')
        }

        const [day, month, year] = [date.date(), date.month() + 1, date.year()]
        const hourMatch = dateStr.match(/(\d{2})h/)
        const hour = hourMatch ? Number(hourMatch[1]) : 12
        const start = [year, month, day, hour, 0]
        const duration = { hours: 1, minutes: 0 }
        const event = {
          start,
          duration,
          title: 'Réservation Tennis',
          description: `Court: ${court}\nAdresse: ${address}`,
          location: address,
          status: 'CONFIRMED',
        }

        const createdEvent = createEvent(event)
        if (createdEvent.error) {
          console.log('ICS creation error:', createdEvent.error)

          break locationsLoop
        }

        const { value } = createdEvent
        if (!process.env.GITHUB_ACTIONS) {
          writeFileSync('event.ics', value)
        }
        if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
          await notify(Buffer.from(value, 'utf8'), 'event.ics',
            `Confirmation pour le ${date.format('DD/MM/YYYY')} - ${hour}h`, {
              domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
              topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
            })
        }

        break locationsLoop
      } catch (e) {
        const reason = String(e?.message || e).split('\n')[0]
        console.log(`${dayjs().format()} - Erreur sur ${logLocation} (tentative ${attempt}/${MAX_ATTEMPTS_PER_LOCATION}) : ${reason}`)
        try {
          await page.screenshot({ path: `img/failure-location${i + 1}-attempt${attempt}.png`, fullPage: true })
        } catch {}
        if (submitted) {
          // the booking was already sent to the site, never retry to avoid a double booking
          console.log(`${dayjs().format()} - La réservation a été envoyée avant l'erreur, vérifiez votre compte tennis.paris.fr`)
          break locationsLoop
        }
        // best effort: cancel any pending booking left open on the site before retrying
        try {
          const cancel = page.locator('#btnCancelBooking')
          if (await cancel.count()) await cancel.first().click({ timeout: 5000 })
        } catch {}
        if (attempt === MAX_ATTEMPTS_PER_LOCATION) {
          console.log(`${dayjs().format()} - Abandon de ${logLocation}, passage à la suivante`)
        }
      }
      }
    }
  } catch (e) {
    console.log(e)
    const screenshot = await page.screenshot({ path: 'img/failure.png' })

    if (config.ntfy?.enable === true || process.env.NTFY_TOPIC) {
      await notify(screenshot, 'failure.png', 'Erreur lors de l\'execution du programme.', {
        domain: config?.ntfy?.domain || process.env.NTFY_DOMAIN,
        topic: config?.ntfy?.topic || process.env.NTFY_TOPIC,
      })
    }
  }

  await browser.close()
}

bookTennis()

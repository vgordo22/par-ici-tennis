import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc.js'
import timezone from 'dayjs/plugin/timezone.js'

dayjs.extend(utc)
dayjs.extend(timezone)

const wait8AM = async () => {
  const now = dayjs().tz('Europe/Paris')
  // WAIT_TARGET lets the workflow start the script a bit before 8:00 (login is done before the race)
  const [h, m, sec] = (process.env.WAIT_TARGET || '08:00:00').split(':').map(Number)
  let next8AM = now.hour(h).minute(m).second(sec || 0).millisecond(0)

  if (now.isAfter(next8AM)) {
    return
  }

  const waitMs = next8AM.diff(now)
  console.log(`Waiting until 8 AM Paris time (${next8AM.format()}) - sleeping for ${waitMs} ms`)

  return new Promise(resolve => setTimeout(resolve, waitMs))
}

wait8AM()

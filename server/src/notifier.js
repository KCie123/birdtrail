import cron from 'node-cron'
import twilio from 'twilio'
import {
  listSubscriptions,
  updateSubscriptionLastObservation,
} from './db.js'
import { fetchRecentObservations } from './ebird.js'

export function startNotifier({
  ebirdApiKey,
  twilioAccountSid,
  twilioAuthToken,
  twilioFromNumber,
  pollIntervalCron = '*/15 * * * *',
  minimumNotificationMinutes = 30,
}) {
  if (!ebirdApiKey) {
    throw new Error('EBIRD_API_KEY is required to start the notifier')
  }

  if (!twilioAccountSid || !twilioAuthToken || !twilioFromNumber) {
    console.warn(
      '[notifier] Twilio credentials missing; SMS sending is disabled.',
    )
  }

  const twilioClient =
    twilioAccountSid && twilioAuthToken
      ? twilio(twilioAccountSid, twilioAuthToken)
      : null

  const execute = async () => {
    const subscriptions = listSubscriptions()
    if (!subscriptions.length) {
      return
    }

    for (const subscription of subscriptions) {
      try {
        const observations = await fetchRecentObservations({
          speciesCode: subscription.speciesCode,
          latitude: subscription.latitude,
          longitude: subscription.longitude,
          radiusMiles: subscription.radiusMiles,
          lookBackDays: subscription.lookBackDays,
          apiKey: ebirdApiKey,
        })

        if (!Array.isArray(observations) || !observations.length) {
          continue
        }

        const latest = observations[0]

        if (
          subscription.lastObservationId &&
          subscription.lastObservationId === latest.subId
        ) {
          continue
        }

        const newSightings = observations.filter((observation) => {
          if (subscription.lastObservationId && observation.subId === subscription.lastObservationId) {
            return false
          }
          if (subscription.lastNotifiedAt) {
            const obsTime = Date.parse(observation.obsDt)
            if (Number.isFinite(obsTime) && obsTime <= Date.parse(subscription.lastNotifiedAt)) {
              return false
            }
          }
          return true
        })

        if (!newSightings.length) {
          continue
        }

        if (subscription.lastNotifiedAt && minimumNotificationMinutes > 0) {
          const lastNotified = Date.parse(subscription.lastNotifiedAt)
          if (Number.isFinite(lastNotified)) {
            const earliestObservation = Date.parse(newSightings[0].obsDt)
            const minutesSinceLast = (earliestObservation - lastNotified) / (1000 * 60)
            if (Number.isFinite(minutesSinceLast) && minutesSinceLast < minimumNotificationMinutes) {
              continue
            }
          }
        }

        if (twilioClient && twilioFromNumber) {
          const primary = newSightings[0]
          const extras = newSightings.length - 1

          const message = [
            `BirdTrail alert: ${subscription.speciesCommonName}`,
            `Latest at ${primary.locName} (${primary.obsDt}).`,
            extras > 0 ? `${extras} more sightings nearby in the last check.` : '',
            `Search radius ${subscription.radiusMiles}mi around ${subscription.locationLabel}.`,
            `Reply STOP to unsubscribe.`,
          ]
            .filter(Boolean)
            .join(' ')

          await twilioClient.messages.create({
            body: message,
            from: twilioFromNumber,
            to: subscription.phone,
          })
        }

        updateSubscriptionLastObservation(subscription.id, newSightings[0].subId)
      } catch (error) {
        console.error(
          `[notifier] Failed to process subscription ${subscription.id}:`,
          error,
        )
      }
    }
  }

  cron.schedule(pollIntervalCron, () => {
    execute().catch((error) => {
      console.error('[notifier] Unexpected error:', error)
    })
  })

  // Run once on startup
  execute().catch((error) => {
    console.error('[notifier] Startup execution failed:', error)
  })
}



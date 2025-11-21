import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { z } from 'zod'
import {
  createSubscription,
  deleteSubscription,
  listSubscriptions,
} from './db.js'
import { startNotifier } from './notifier.js'

const app = express()

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',').map((origin) => origin.trim()) ||
      ['http://localhost:5173'],
  }),
)
app.use(express.json())

const subscriptionSchema = z.object({
  phone: z
    .string()
    .min(5)
    .max(20)
    .regex(/^\+?[0-9\s\-().]+$/, 'Invalid phone number'),
  speciesCode: z.string().min(2),
  speciesCommonName: z.string().min(2),
  locationLabel: z.string().min(2),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMiles: z.number().int().positive().max(200),
  lookBackDays: z.number().int().positive().max(30).default(3),
})

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.get('/api/subscriptions', (_req, res) => {
  res.json(listSubscriptions())
})

app.post('/api/subscriptions', (req, res) => {
  const parseResult = subscriptionSchema.safeParse(req.body)

  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Invalid subscription payload',
      details: parseResult.error.flatten(),
    })
  }

  const subscription = createSubscription(parseResult.data)
  res.status(201).json(subscription)
})

app.delete('/api/subscriptions/:id', (req, res) => {
  const id = Number.parseInt(req.params.id, 10)
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: 'Invalid id parameter' })
  }
  deleteSubscription(id)
  res.status(204).send()
})

const port = Number.parseInt(process.env.PORT ?? '4000', 10)

app.listen(port, () => {
  console.log(`BirdTrail backend listening on http://localhost:${port}`)
})

startNotifier({
  ebirdApiKey: process.env.EBIRD_API_KEY ?? '',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID ?? '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN ?? '',
  twilioFromNumber: process.env.TWILIO_FROM_NUMBER ?? '',
  pollIntervalCron: process.env.NOTIFIER_CRON ?? '*/15 * * * *',
  minimumNotificationMinutes: Number.parseInt(
    process.env.MIN_NOTIFICATION_MINUTES ?? '60',
    10,
  ),
})



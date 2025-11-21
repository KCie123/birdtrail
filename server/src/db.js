import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = join(process.cwd(), 'data')
mkdirSync(dataDir, { recursive: true })

const db = new Database(join(dataDir, 'subscriptions.db'))

db.pragma('journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT NOT NULL,
    speciesCode TEXT NOT NULL,
    speciesCommonName TEXT NOT NULL,
    locationLabel TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    radiusMiles INTEGER NOT NULL,
    lookBackDays INTEGER NOT NULL,
    createdAt TEXT NOT NULL,
    lastObservationId TEXT,
    lastNotifiedAt TEXT
  );
`)

export function createSubscription(input) {
  const statement = db.prepare(`
    INSERT INTO subscriptions (
      phone,
      speciesCode,
      speciesCommonName,
      locationLabel,
      latitude,
      longitude,
      radiusMiles,
      lookBackDays,
      createdAt,
      lastObservationId,
      lastNotifiedAt
    ) VALUES (
      @phone,
      @speciesCode,
      @speciesCommonName,
      @locationLabel,
      @latitude,
      @longitude,
      @radiusMiles,
      @lookBackDays,
      @createdAt,
      @lastObservationId,
      @lastNotifiedAt
    )
  `)

  const result = statement.run({
    ...input,
    createdAt: new Date().toISOString(),
    lastObservationId: null,
    lastNotifiedAt: null,
  })

  return getSubscriptionById(result.lastInsertRowid)
}

export function getSubscriptionById(id) {
  const statement = db.prepare(`SELECT * FROM subscriptions WHERE id = ?`)
  return statement.get(id)
}

export function listSubscriptions() {
  return db.prepare(`SELECT * FROM subscriptions ORDER BY createdAt DESC`).all()
}

export function deleteSubscription(id) {
  return db.prepare(`DELETE FROM subscriptions WHERE id = ?`).run(id)
}

export function updateSubscriptionLastObservation(id, observationId) {
  const statement = db.prepare(`
    UPDATE subscriptions
    SET lastObservationId = @observationId,
        lastNotifiedAt = @lastNotifiedAt
    WHERE id = @id
  `)

  statement.run({
    id,
    observationId,
    lastNotifiedAt: new Date().toISOString(),
  })
}

export default db



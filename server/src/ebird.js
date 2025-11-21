const EBIRD_API_BASE = 'https://api.ebird.org/v2'

export async function fetchRecentObservations({
  speciesCode,
  latitude,
  longitude,
  radiusMiles,
  lookBackDays,
  apiKey,
}) {
  if (!apiKey) {
    throw new Error('Missing eBird API key for backend')
  }

  const url = new URL(
    `${EBIRD_API_BASE}/data/obs/geo/recent/${encodeURIComponent(speciesCode)}`,
  )
  url.searchParams.set('lat', latitude.toString())
  url.searchParams.set('lng', longitude.toString())
  url.searchParams.set('dist', radiusMiles.toString())
  url.searchParams.set('back', lookBackDays.toString())
  url.searchParams.set('maxResults', '10')

  const response = await fetch(url.toString(), {
    headers: {
      'X-eBirdApiToken': apiKey,
    },
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `eBird API returned ${response.status} ${response.statusText}: ${body}`,
    )
  }

  return response.json()
}



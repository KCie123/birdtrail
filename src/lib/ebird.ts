const EBIRD_API_BASE = 'https://api.ebird.org/v2'

export interface LocationLookupResult {
  latitude: number
  longitude: number
  city?: string
  state?: string
  postalCode?: string
  label: string
}

export interface SpeciesMatch {
  speciesCode: string
  comName: string
  sciName: string
  category?: string
  familyComName?: string
}

export interface Observation {
  speciesCode: string
  comName: string
  sciName: string
  locName: string
  lat: number
  lng: number
  obsDt: string
  howMany?: number
  distance?: number
  obsValid: boolean
  obsReviewed: boolean
  locationPrivate: boolean
  subId: string
}

const ZIP_API_BASE = 'https://api.zippopotam.us/us'
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org/search'
const NOMINATIM_CONTACT =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_OSM_CONTACT) || ''

interface TaxonomyEntry {
  speciesCode: string
  comName: string
  sciName: string
  category?: string
  familyComName?: string
}

interface SpeciesCatalogEntry extends SpeciesMatch {
  comNameLower: string
  sciNameLower: string
}

let speciesCatalog: SpeciesCatalogEntry[] | null = null
let speciesCatalogPromise: Promise<SpeciesCatalogEntry[]> | null = null

export async function lookupZip(zip: string): Promise<LocationLookupResult> {
  const response = await fetch(`${ZIP_API_BASE}/${zip}`)

  if (!response.ok) {
    throw new Error('We could not locate that ZIP code.')
  }

  const data = await response.json()

  const firstPlace = data?.places?.[0]
  if (!firstPlace) {
    throw new Error('No places were returned for that ZIP code.')
  }

  const city = firstPlace['place name']
  const state = firstPlace['state abbreviation']

  return {
    latitude: Number(firstPlace.latitude),
    longitude: Number(firstPlace.longitude),
    city,
    state,
    postalCode: zip,
    label: [city, state].filter(Boolean).join(', '),
  }
}

export async function lookupCityOrAddress(
  query: string,
  limit = 5,
): Promise<LocationLookupResult[]> {
  const url = new URL(NOMINATIM_BASE)
  url.searchParams.set('format', 'json')
  url.searchParams.set('limit', limit.toString())
  url.searchParams.set('addressdetails', '1')
  url.searchParams.set('q', query)
  if (NOMINATIM_CONTACT) {
    url.searchParams.set('email', NOMINATIM_CONTACT)
  }

  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en',
    },
  })

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('The geocoding service rate-limited the request. Please try again shortly.')
    }
    throw new Error('We could not look up that location right now.')
  }

  const results = ((await response.json()) as Array<{
    lat: string
    lon: string
    display_name?: string
    address?: Record<string, string>
  }>)?.filter((item) => item?.lat && item?.lon)

  if (!results?.length) {
    return []
  }

  return results.map((item) => {
    const address = item.address ?? {}
    const city =
      address.city ||
      address.town ||
      address.village ||
      address.hamlet ||
      address.county
    const state = address.state || address.region || address.state_district
    const postalCode = address.postcode
    const label =
      item.display_name?.split(',').slice(0, 3).join(', ').trim() ||
      [city, state].filter(Boolean).join(', ') ||
      query

    return {
      latitude: Number.parseFloat(item.lat),
      longitude: Number.parseFloat(item.lon),
      city,
      state,
      postalCode,
      label,
    }
  })
}

export async function resolveLocation(
  input: string,
): Promise<LocationLookupResult> {
  const normalized = input.trim()
  if (!normalized) {
    throw new Error('Please enter a location to search.')
  }

  const results = await searchLocations(normalized)
  const first = results[0]

  if (!first) {
    throw new Error('We could not locate that place. Try refining the name or adding the state.')
  }

  return first
}

export async function searchLocations(
  input: string,
  options: { limit?: number } = {},
): Promise<LocationLookupResult[]> {
  const normalized = input.trim()
  if (!normalized) {
    return []
  }

  const limit = options.limit ?? 5

  if (/^\d{5}$/.test(normalized)) {
    try {
      const zipResult = await lookupZip(normalized)
      return [zipResult]
    } catch (error) {
      console.error(error)
      return []
    }
  }

  if (normalized.length < 3) {
    return []
  }

  try {
    const cityResults = await lookupCityOrAddress(normalized, limit)
    return cityResults.slice(0, limit)
  } catch (error) {
    console.error(error)
    throw error instanceof Error
      ? error
      : new Error('We could not look up that location right now.')
  }
}

export async function searchSpecies(
  query: string,
  apiKey: string,
  maxResults = 5,
): Promise<SpeciesMatch[]> {
  if (!apiKey) {
    throw new Error('Missing eBird API key')
  }

  const catalog = await loadSpeciesCatalog(apiKey)
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)

  const ranked = catalog
    .map((entry) => {
      if (tokens.length === 0) {
        return { entry, score: Number.MAX_SAFE_INTEGER / 2 }
      }

      let score = 0
      for (const token of tokens) {
        const comIndex = entry.comNameLower.indexOf(token)
        const sciIndex = entry.sciNameLower.indexOf(token)

        if (comIndex === -1 && sciIndex === -1) {
          return null
        }

        if (comIndex !== -1) {
          score += comIndex
          if (
            entry.comNameLower.startsWith(token) ||
            entry.comNameLower.includes(` ${token}`)
          ) {
            score -= 15
          }
        } else if (sciIndex !== -1) {
          score += sciIndex + 50
        }
      }

      if (entry.category && entry.category !== 'species') {
        score += 20
      }

      return { entry, score }
    })
    .filter((match): match is { entry: SpeciesCatalogEntry; score: number } => match !== null)
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.entry.comNameLower.localeCompare(b.entry.comNameLower, undefined, {
          sensitivity: 'base',
        }),
    )

  const desiredCount =
    tokens.length === 0 ? maxResults : Math.min(Math.max(maxResults, 15), 40)

  const limited = ranked.slice(0, desiredCount)

  return limited.map(({ entry }) => ({
    speciesCode: entry.speciesCode,
    comName: entry.comName,
    sciName: entry.sciName,
    category: entry.category,
    familyComName: entry.familyComName,
  }))
}

export interface ObservationSearchParams {
  speciesCode: string
  latitude: number
  longitude: number
  radiusMiles?: number
  lookBackDays?: number
}

export async function fetchRecentObservations(
  { speciesCode, latitude, longitude, radiusMiles = 50, lookBackDays = 7 }: ObservationSearchParams,
  apiKey: string,
): Promise<Observation[]> {
  if (!apiKey) {
    throw new Error('Missing eBird API key')
  }

  const url = new URL(
    `${EBIRD_API_BASE}/data/obs/geo/recent/${encodeURIComponent(speciesCode)}`,
  )
  url.searchParams.set('lat', latitude.toString())
  url.searchParams.set('lng', longitude.toString())
  url.searchParams.set('dist', radiusMiles.toString())
  url.searchParams.set('back', lookBackDays.toString())

  const response = await fetch(url, {
    headers: {
      'X-eBirdApiToken': apiKey,
    },
  })

  if (!response.ok) {
    if (response.status === 404) {
      return []
    }

    throw new Error('Unable to load recent sightings from eBird')
  }

  const observations = (await response.json()) as Observation[]

  return observations.sort((a, b) => {
    if (a.distance === undefined || b.distance === undefined) {
      return new Date(b.obsDt).getTime() - new Date(a.obsDt).getTime()
    }

    return a.distance - b.distance
  })
}

async function loadSpeciesCatalog(apiKey: string): Promise<SpeciesCatalogEntry[]> {
  if (!apiKey) {
    throw new Error('Missing eBird API key')
  }

  if (speciesCatalog) {
    return speciesCatalog
  }

  if (speciesCatalogPromise) {
    return speciesCatalogPromise
  }

  speciesCatalogPromise = (async () => {
    const response = await fetch(
      `${EBIRD_API_BASE}/ref/taxonomy/ebird?fmt=json`,
      {
        headers: {
          Accept: 'application/json',
          'X-eBirdApiToken': apiKey,
        },
      },
    )

    if (!response.ok) {
      throw new Error('Unable to load the eBird species catalog')
    }

    const data = (await response.json()) as TaxonomyEntry[]

    if (!Array.isArray(data)) {
      throw new Error('Received an unexpected response from the eBird taxonomy API')
    }

    speciesCatalog = data
      .filter((entry) => {
        const category = entry.category ?? ''
        return category === 'species' || category === 'issf'
      })
      .map((entry) => ({
        speciesCode: entry.speciesCode,
        comName: entry.comName,
        sciName: entry.sciName,
        category: entry.category,
        familyComName: entry.familyComName,
        comNameLower: entry.comName.toLowerCase(),
        sciNameLower: entry.sciName.toLowerCase(),
      }))

    if (!speciesCatalog.length) {
      throw new Error('The eBird species catalog returned no results')
    }

    return speciesCatalog
  })()

  try {
    return await speciesCatalogPromise
  } finally {
    speciesCatalogPromise = null
  }
}


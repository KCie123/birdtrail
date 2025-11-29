import { useEffect, useMemo, useRef, useState } from 'react'
import { FiAlertCircle, FiArrowRight, FiExternalLink, FiMapPin } from 'react-icons/fi'
import {
  fetchRecentObservations,
  resolveLocation,
  searchLocations,
  searchSpecies,
  type LocationLookupResult,
  type Observation,
  type SpeciesMatch,
} from './lib/ebird'

type SearchState = 'idle' | 'searching' | 'ready' | 'error'

interface SearchSummary {
  locationLabel: string
  speciesCommonName: string
  speciesScientificName: string
  radiusMiles: number
  observationsFound: number
}

const DEFAULT_RADIUS_MILES = 50
const DEFAULT_LOOKBACK_DAYS = 3
const RADIUS_OPTIONS = [10, 25, 50]
const SEARCH_COOLDOWN_MS = 4000
const MIN_BIRD_COUNT_OPTIONS = [
  { label: 'Any reported count', value: 1 },
  { label: 'Multiple birds reported', value: 2 },
]

const formatLocationLabel = (location: LocationLookupResult) => {
  const cityState = [location.city, location.state].filter(Boolean).join(', ')
  if (cityState) {
    return cityState
  }

  if (location.postalCode) {
    return location.postalCode
  }

  return location.label.trim()
}

function formatRelativeTime(isoDate: string) {
  const formatter = new Intl.RelativeTimeFormat(undefined, {
    numeric: 'auto',
  })

  const observationDate = new Date(isoDate)
  const diffMs = observationDate.getTime() - Date.now()
  const diffMinutes = Math.round(diffMs / (1000 * 60))

  if (Math.abs(diffMinutes) < 60) {
    return formatter.format(Math.round(diffMinutes), 'minute')
  }

  const diffHours = Math.round(diffMinutes / 60)
  if (Math.abs(diffHours) < 24) {
    return formatter.format(diffHours, 'hour')
  }

  const diffDays = Math.round(diffHours / 24)
  return formatter.format(diffDays, 'day')
}

function formatDistance(distance?: number) {
  if (distance === undefined || Number.isNaN(distance)) {
    return '—'
  }

  if (distance < 1) {
    return `${Math.round(distance * 10) / 10} mi`
  }

  return `${distance.toFixed(1)} mi`
}

function formatDate(isoDate: string) {
  const date = new Date(isoDate)
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

function formatFetchTimestamp(isoDate: string) {
  const date = new Date(isoDate)
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  }).format(date)
}

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180
}

function haversineDistanceMiles(lat1: number, lon1: number, lat2: number, lon2: number) {
  const EARTH_RADIUS_MILES = 3958.8
  const dLat = toRadians(lat2 - lat1)
  const dLon = toRadians(lon2 - lon1)
  const rLat1 = toRadians(lat1)
  const rLat2 = toRadians(lat2)

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2)

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))

  return EARTH_RADIUS_MILES * c
}

function approximateDriveTimeMinutes(distanceMiles: number | null | undefined) {
  if (!distanceMiles || Number.isNaN(distanceMiles) || distanceMiles <= 0) {
    return null
  }

  let averageMph = 28
  if (distanceMiles > 40) {
    averageMph = 50
  } else if (distanceMiles > 25) {
    averageMph = 42
  } else if (distanceMiles > 15) {
    averageMph = 35
  } else if (distanceMiles > 7) {
    averageMph = 30
  }

  return Math.max(Math.round((distanceMiles / averageMph) * 60), 1)
}

function App() {
  const apiKey = import.meta.env.VITE_EBIRD_API_KEY ?? ''
  const mapboxToken = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? ''
  const hasApiKey = Boolean(apiKey)

  const [locationInput, setLocationInput] = useState('')
  const [locationSelection, setLocationSelection] = useState<LocationLookupResult | null>(null)
  const [locationSuggestions, setLocationSuggestions] = useState<LocationLookupResult[]>([])
  const [locationLoading, setLocationLoading] = useState(false)
  const [locationError, setLocationError] = useState<string | null>(null)
  const [speciesQuery, setSpeciesQuery] = useState('')
  const [speciesSelection, setSpeciesSelection] = useState<SpeciesMatch | null>(null)
  const [speciesSuggestions, setSpeciesSuggestions] = useState<SpeciesMatch[]>([])
  const [speciesLoading, setSpeciesLoading] = useState(false)
  const [speciesError, setSpeciesError] = useState<string | null>(null)
  const [observations, setObservations] = useState<Observation[]>([])
  const [searchState, setSearchState] = useState<SearchState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [searchSummary, setSearchSummary] = useState<SearchSummary | null>(null)
  const [radiusMiles, setRadiusMiles] = useState(DEFAULT_RADIUS_MILES)
  const [minBirdCount, setMinBirdCount] = useState<number>(MIN_BIRD_COUNT_OPTIONS[0].value)
  const [travelEstimateMinutes, setTravelEstimateMinutes] = useState<number | null>(null)
  const [travelEstimateSource, setTravelEstimateSource] = useState<
    'mapbox' | 'osrm' | 'approx' | null
  >(null)
  const [isCooldown, setIsCooldown] = useState(false)
  const [cooldownSeconds, setCooldownSeconds] = useState(0)
  const cooldownTimeoutRef = useRef<number | null>(null)
  const cooldownIntervalRef = useRef<number | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null)

  const startCooldown = () => {
    setIsCooldown(true)
    setCooldownSeconds(Math.ceil(SEARCH_COOLDOWN_MS / 1000))

    if (cooldownTimeoutRef.current) {
      window.clearTimeout(cooldownTimeoutRef.current)
    }
    if (cooldownIntervalRef.current) {
      window.clearInterval(cooldownIntervalRef.current)
    }

    cooldownTimeoutRef.current = window.setTimeout(() => {
      setIsCooldown(false)
      setCooldownSeconds(0)
      cooldownTimeoutRef.current = null
      if (cooldownIntervalRef.current) {
        window.clearInterval(cooldownIntervalRef.current)
        cooldownIntervalRef.current = null
      }
    }, SEARCH_COOLDOWN_MS)

    cooldownIntervalRef.current = window.setInterval(() => {
      setCooldownSeconds((prev) => {
        if (prev <= 1) {
          if (cooldownIntervalRef.current) {
            window.clearInterval(cooldownIntervalRef.current)
            cooldownIntervalRef.current = null
          }
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }

  useEffect(() => {
    return () => {
      if (cooldownTimeoutRef.current) {
        window.clearTimeout(cooldownTimeoutRef.current)
      }
      if (cooldownIntervalRef.current) {
        window.clearInterval(cooldownIntervalRef.current)
      }
    }
  }, [])

  const trimmedLocation = locationInput.trim()
  const isLocationValid =
    /^\d{5}$/.test(trimmedLocation) ||
    trimmedLocation.length >= 3 ||
    Boolean(locationSelection)
  const isFormValid = isLocationValid && speciesQuery.trim().length > 0

  useEffect(() => {
    const query = locationInput.trim()

    setLocationError(null)

    if (!query) {
      setLocationSuggestions([])
      setLocationSelection(null)
      setLocationLoading(false)
      return
    }

    const normalizedQuery = query.toLowerCase()

    if (locationSelection) {
      const equivalentValues = [
        locationSelection.label,
        locationSelection.postalCode,
        locationSelection.city && locationSelection.state
          ? `${locationSelection.city}, ${locationSelection.state}`
          : locationSelection.city,
      ]
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase())

      const matchesSelection = equivalentValues.includes(normalizedQuery)

      if (matchesSelection) {
        setLocationSuggestions([])
        setLocationLoading(false)
        return
      }

      if (
        query !== locationSelection.label &&
        query !== locationSelection.postalCode
      ) {
        setLocationSelection(null)
        setLocationSuggestions([])
        setLocationLoading(false)
        return
      }
    }

    if (/^\d{5}$/.test(query) && query.length === 5) {
      let isCurrent = true
      setLocationLoading(true)
      ;(async () => {
        try {
          const results = await searchLocations(query, { limit: 1 })
          if (isCurrent) {
            setLocationSuggestions(results)
            setLocationError(results.length ? null : 'No matching ZIP code found.')
          }
        } catch (error) {
          if (isCurrent) {
            console.error(error)
            setLocationSuggestions([])
            setLocationError(
              error instanceof Error
                ? error.message
                : 'We could not look up that ZIP code right now.',
            )
          }
        } finally {
          if (isCurrent) {
            setLocationLoading(false)
          }
        }
      })()

      return () => {
        isCurrent = false
      }
    }

    if (query.length < 3) {
      setLocationSuggestions([])
      setLocationLoading(false)
      setLocationError('Type at least 3 characters to search for a place.')
      return
    }

    let isCurrent = true
    setLocationLoading(true)

    const debounce = window.setTimeout(async () => {
      try {
        const results = await searchLocations(query, { limit: 6 })
        if (isCurrent) {
          setLocationSuggestions(results)
          setLocationError(results.length ? null : 'No matching places found.')
        }
      } catch (error) {
        if (isCurrent) {
          console.error(error)
          setLocationSuggestions([])
          setLocationError(
            error instanceof Error
              ? error.message
              : 'We could not look up that location right now.',
          )
        }
      } finally {
        if (isCurrent) {
          setLocationLoading(false)
        }
      }
    }, 250)

    return () => {
      isCurrent = false
      window.clearTimeout(debounce)
    }
  }, [locationInput, locationSelection])

  useEffect(() => {
    if (!speciesQuery || !hasApiKey) {
      setSpeciesSuggestions([])
      setSpeciesLoading(false)
      setSpeciesError(null)
      return
    }

    if (speciesSelection && speciesSelection.comName === speciesQuery.trim()) {
      setSpeciesSuggestions([])
      return
    }

    let isCurrent = true
    setSpeciesLoading(true)
    setSpeciesError(null)

    const debounce = window.setTimeout(async () => {
      try {
        const results = await searchSpecies(speciesQuery.trim(), apiKey, 15)
        if (isCurrent) {
          setSpeciesSuggestions(results)
        }
      } catch (error) {
        if (isCurrent) {
          console.error(error)
          setSpeciesSuggestions([])
          setSpeciesError(
            error instanceof Error
              ? error.message
              : 'We could not load species suggestions right now.',
          )
        }
      } finally {
        if (isCurrent) {
          setSpeciesLoading(false)
        }
      }
    }, 200)

    return () => {
      isCurrent = false
      window.clearTimeout(debounce)
    }
  }, [speciesQuery, speciesSelection, apiKey, hasApiKey])

  const handleSuggestionSelection = (match: SpeciesMatch) => {
    setSpeciesSelection(match)
    setSpeciesQuery(match.comName)
    setSpeciesSuggestions([])
  }

  const handleLocationSuggestionSelection = (location: LocationLookupResult) => {
    const formattedLabel = formatLocationLabel(location)
    const normalizedLocation: LocationLookupResult = {
      ...location,
      label: formattedLabel,
    }

    setLocationSelection(normalizedLocation)
    setLocationInput(formattedLabel)
    setLocationSuggestions([])
    setLocationError(null)
    setLocationLoading(false)
  }

  const handleSearch = async () => {
    if (!isFormValid || !hasApiKey) {
      setErrorMessage(
        hasApiKey ? 'Please enter a valid location and species' : null,
      )
      return
    }

    if (isCooldown) {
      setErrorMessage('Please wait a moment between searches to avoid spamming the eBird API.')
      return
    }

    startCooldown()
    setSearchState('searching')
    setErrorMessage(null)
    try {
      const resolvedLocation =
        locationSelection ?? (await resolveLocation(locationInput.trim()))

      const normalizedLocation: LocationLookupResult = {
        ...resolvedLocation,
        label: formatLocationLabel(resolvedLocation),
      }

      setLocationSelection(normalizedLocation)
      setLocationInput(normalizedLocation.label)
      setLocationSuggestions([])
      setLocationError(null)
      setLocationLoading(false)

      let match = speciesSelection
      if (!match || match.comName.toLowerCase() !== speciesQuery.trim().toLowerCase()) {
        const candidates = await searchSpecies(speciesQuery.trim(), apiKey, 1)
        match = candidates[0]
      }

      if (!match) {
        throw new Error('We could not find that species in the eBird taxonomy.')
      }

      setSpeciesSelection(match)

      const sightings = await fetchRecentObservations(
        {
          speciesCode: match.speciesCode,
          latitude: normalizedLocation.latitude,
          longitude: normalizedLocation.longitude,
          radiusMiles,
          lookBackDays: DEFAULT_LOOKBACK_DAYS,
        },
        apiKey,
      )

      const filteredSightings = sightings.filter((observation) => {
        const reportedCount = observation.howMany ?? 1
        return reportedCount >= minBirdCount
      })

      setObservations(filteredSightings)
      setLastFetchedAt(new Date().toISOString())

      setSearchSummary({
        locationLabel: normalizedLocation.label,
        speciesCommonName: match.comName,
        speciesScientificName: match.sciName,
        radiusMiles,
        observationsFound: filteredSightings.length,
      })

      setSearchState('ready')
    } catch (error) {
      console.error(error)
      setErrorMessage(
        error instanceof Error
          ? /failed to fetch/i.test(error.message)
            ? 'We could not reach the eBird API. Check your internet connection and API key.'
            : error.message
          : 'Something unexpected happened. Please try again.',
      )
      setSearchState('error')
    }
  }

  const handleFormSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    await handleSearch()
  }

  const topObservation = useMemo(
    () => (observations.length > 0 ? observations[0] : null),
    [observations],
  )

  const directionsUrl = useMemo(() => {
    if (!topObservation || !locationSelection) {
      return null
    }

    const origin = `${locationSelection.latitude},${locationSelection.longitude}`
    const destination = `${topObservation.lat},${topObservation.lng}`

    const url = new URL('https://www.google.com/maps/dir/')
    url.searchParams.set('api', '1')
    url.searchParams.set('origin', origin)
    url.searchParams.set('destination', destination)
    url.searchParams.set('travelmode', 'driving')

    return url.toString()
  }, [topObservation, locationSelection])

  useEffect(() => {
    if (!topObservation || !locationSelection) {
      setTravelEstimateMinutes(null)
      setTravelEstimateSource(null)
      return
    }

    let isActive = true
    const controller = new AbortController()

    const fallbackDistance =
      topObservation.distance ??
      haversineDistanceMiles(
        locationSelection.latitude,
        locationSelection.longitude,
        topObservation.lat,
        topObservation.lng,
      )
    const fallbackMinutes = approximateDriveTimeMinutes(fallbackDistance)

    const applyApproximation = () => {
      if (!isActive) {
        return
      }

      if (fallbackMinutes !== null) {
        setTravelEstimateMinutes(fallbackMinutes)
        setTravelEstimateSource('approx')
      } else {
        setTravelEstimateMinutes(null)
        setTravelEstimateSource(null)
      }
    }

    const fetchOsrmEstimate = async () => {
      try {
        const url = new URL(
          `https://router.project-osrm.org/route/v1/driving/${locationSelection.longitude},${locationSelection.latitude};${topObservation.lng},${topObservation.lat}`,
        )
        url.searchParams.set('overview', 'false')
        url.searchParams.set('alternatives', 'false')
        url.searchParams.set('steps', 'false')

        const response = await fetch(url.toString(), {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
          },
        })

        if (!response.ok) {
          throw new Error('Unable to retrieve driving estimate')
        }

        const data = await response.json()
        const seconds: unknown = data?.routes?.[0]?.duration

        if (typeof seconds === 'number' && Number.isFinite(seconds)) {
          const minutes = Math.max(Math.round(seconds / 60), 1)
          if (isActive) {
            setTravelEstimateMinutes(minutes)
            setTravelEstimateSource('osrm')
          }
          return true
        }

        throw new Error('Driving duration missing')
      } catch (error) {
        if (!isActive || (error instanceof DOMException && error.name === 'AbortError')) {
          return false
        }
        console.error('Unable to compute OSRM driving estimate', error)
        return false
      }
    }

    const fetchMapboxEstimate = async (token: string) => {
      try {
        const url = new URL(
          `https://api.mapbox.com/directions/v5/mapbox/driving/${locationSelection.longitude},${locationSelection.latitude};${topObservation.lng},${topObservation.lat}`,
        )
        url.searchParams.set('access_token', token)
        url.searchParams.set('overview', 'false')
        url.searchParams.set('alternatives', 'false')
        url.searchParams.set('annotations', 'duration')

        const response = await fetch(url.toString(), {
          signal: controller.signal,
          headers: {
            Accept: 'application/json',
          },
        })

        if (!response.ok) {
          throw new Error(`Mapbox request failed with status ${response.status}`)
        }

        const data = await response.json()
        const seconds: unknown = data?.routes?.[0]?.duration

        if (typeof seconds === 'number' && Number.isFinite(seconds)) {
          const minutes = Math.max(Math.round(seconds / 60), 1)
          if (isActive) {
            setTravelEstimateMinutes(minutes)
            setTravelEstimateSource('mapbox')
          }
          return true
        }

        throw new Error('Mapbox response missing duration')
      } catch (error) {
        if (!isActive || (error instanceof DOMException && error.name === 'AbortError')) {
          return false
        }
        console.error('Unable to compute Mapbox driving estimate', error)
        return false
      }
    }

    const run = async () => {
      if (mapboxToken) {
        const mapboxSuccess = await fetchMapboxEstimate(mapboxToken)
        if (mapboxSuccess) {
          return
        }
      }

      const osrmSuccess = await fetchOsrmEstimate()
      if (osrmSuccess) {
        return
      }

      applyApproximation()
    }

    run()

    return () => {
      isActive = false
      controller.abort()
    }
  }, [topObservation, locationSelection, mapboxToken])

  const renderClosestSightingPanel = (extraClasses = '') => {
    if (!topObservation) {
      return null
    }

    return (
      <div
        className={`rounded-2xl border border-emerald-400/40 bg-emerald-500/10 p-6 text-emerald-100 ${extraClasses}`}
      >
        <h2 className="text-lg font-semibold">Closest sighting right now</h2>
        <p className="mt-2 text-sm text-emerald-50/80">
          {topObservation.locName} • {formatDistance(topObservation.distance)}
        </p>
        {travelEstimateMinutes !== null && locationSelection && (
          <p className="mt-1 text-xs uppercase tracking-wide text-emerald-200/70">
            ≈ {travelEstimateMinutes} min drive from {locationSelection.label}
            {travelEstimateSource === 'mapbox' && (
              <span className="ml-2 text-[0.65rem] uppercase tracking-wider text-emerald-100/70">
                mapbox
              </span>
            )}
            {travelEstimateSource === 'osrm' && (
              <span className="ml-2 text-[0.65rem] uppercase tracking-wider text-emerald-100/70">
                osrm
              </span>
            )}
            {travelEstimateSource === 'approx' && (
              <span className="ml-2 text-[0.65rem] uppercase tracking-wider text-emerald-200/60">
                estimate
              </span>
            )}
          </p>
        )}
        <p className="mt-2 text-sm">
          Last seen {formatRelativeTime(topObservation.obsDt)} ({formatDate(topObservation.obsDt)}).
        </p>
        <p className="mt-4 text-xs uppercase tracking-wide text-emerald-200/70">Sub checklist ID</p>
        <p className="font-mono text-sm">{topObservation.subId}</p>
        {directionsUrl && (
          <a
            href={directionsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-emerald-400/20 px-4 py-2 text-sm font-semibold text-emerald-50 transition hover:bg-emerald-400/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-200"
          >
            <FiExternalLink className="text-base" />
            Get directions
          </a>
        )}
      </div>
    )
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-100">
      <div className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute left-1/2 top-[-10rem] h-[30rem] w-[30rem] -translate-x-1/2 rounded-full bg-sky-500/40 blur-3xl md:left-[20%] md:top-[-12rem]" />
        <div className="absolute bottom-[-15rem] right-[-10rem] h-[35rem] w-[35rem] rounded-full bg-emerald-500/30 blur-3xl" />
      </div>

      <main className="relative mx-auto flex max-w-7xl flex-col gap-10 px-4 pb-24 pt-16 lg:flex-row lg:items-start lg:gap-16">
        <section className="flex-1 space-y-10">
          <header className="space-y-6">
            <span className="inline-flex items-center rounded-full bg-slate-900/60 px-4 py-1 text-sm font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30">
              Powered by eBird data
            </span>
            <div className="space-y-4">
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
                Find the closest recent sightings of your favorite birds
              </h1>
              <p className="max-w-2xl text-lg text-slate-300">
                Enter a US ZIP code and the species you are curious about. We will look up the
                latest eBird observations nearby.
              </p>
            </div>
          </header>

          {!hasApiKey && (
            <div className="flex items-start gap-3 rounded-2xl border border-amber-400/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
              <FiAlertCircle className="mt-1 text-xl" />
              <div>
                <p className="font-medium">Add your eBird API key</p>
                <p className="text-amber-100/80">
                  Create a <code className="rounded bg-amber-400/10 px-1 py-0.5">.env</code> file
                  with <code>VITE_EBIRD_API_KEY=your-token</code> and restart the dev server to
                  search live data.
                </p>
              </div>
            </div>
          )}

          <form
            onSubmit={handleFormSubmit}
            className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6 shadow-[0_40px_60px_-50px_rgba(14,165,233,0.45)] backdrop-blur"
          >
            <div className="grid gap-6 items-start md:grid-cols-2 lg:grid-cols-[2.2fr_3.2fr_1fr_1fr]">
              <label className="group flex flex-col gap-2 md:col-span-1 lg:col-span-1">
                <span className="text-sm font-medium text-slate-300">Location</span>
                <div className="relative">
                  <input
                    value={locationInput}
                    onChange={(event) => setLocationInput(event.target.value)}
                    placeholder="e.g. 10001 or Seattle, WA"
                    className="w-full rounded-xl border border-slate-700/60 bg-slate-900/80 px-4 py-3 pr-12 text-base text-slate-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-500/50"
                    required
                    autoComplete="off"
                  />
                  <FiMapPin className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-lg text-slate-500 transition group-focus-within:text-sky-400" />

                  {trimmedLocation.length > 0 &&
                    (locationSuggestions.length > 0 || locationLoading || locationError) && (
                      <div className="absolute left-0 top-full z-30 mt-2 max-h-72 w-full overflow-hidden rounded-xl border border-slate-700/80 bg-slate-900/95 shadow-lg backdrop-blur">
                        <div className="max-h-72 overflow-y-auto">
                          {locationLoading && (
                            <p className="px-4 py-3 text-sm text-slate-400">Looking up places…</p>
                          )}

                          {locationError && !locationLoading && (
                            <p className="px-4 py-3 text-sm text-rose-200">{locationError}</p>
                          )}

                          {!locationLoading &&
                            !locationError &&
                            locationSuggestions.map((location) => (
                              <button
                                key={`${location.latitude}-${location.longitude}-${location.label}`}
                                type="button"
                                onClick={() => handleLocationSuggestionSelection(location)}
                                className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition hover:bg-slate-800/80"
                              >
                                <span className="font-medium text-slate-100">
                                  {formatLocationLabel(location)}
                                </span>
                                <span className="text-xs uppercase tracking-wide text-slate-400">
                                  {[location.city, location.state, location.postalCode]
                                    .filter(Boolean)
                                    .join(' • ')}
                                </span>
                              </button>
                            ))}
                        </div>
                      </div>
                    )}
                </div>
                <span className="text-xs text-slate-500">
                  Enter a ZIP code or city to anchor the search.
                </span>
              </label>

              <div className="flex flex-col gap-2 md:col-span-1 lg:col-span-1">
                <label className="text-sm font-medium text-slate-300">Species</label>
                <div className="relative">
                <input
                  value={speciesQuery}
                  onChange={(event) => {
                    const nextValue = event.target.value
                    setSpeciesQuery(nextValue)
                    if (speciesSelection?.comName !== nextValue.trim()) {
                      setSpeciesSelection(null)
                    }
                  }}
                    placeholder="e.g. Snowy Owl"
                    className="w-full rounded-xl border border-slate-700/60 bg-slate-900/80 px-4 py-3 text-base text-slate-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-500/50"
                    required
                    autoComplete="off"
                  />
                  <button
                    type="submit"
                    className="absolute right-1 top-1 flex h-10 w-10 items-center justify-center rounded-lg bg-sky-500 text-slate-950 transition hover:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-300"
                    disabled={!isFormValid || searchState === 'searching' || !hasApiKey}
                  >
                    <FiArrowRight className="text-xl" />
                  </button>

                  {speciesQuery.trim().length > 0 &&
                    (speciesSuggestions.length > 0 || speciesLoading || speciesError) && (
                      <div className="absolute z-20 mt-2 max-h-72 w-full overflow-hidden rounded-xl border border-slate-700/80 bg-slate-900/95 shadow-lg backdrop-blur">
                        <div className="max-h-72 overflow-y-auto">
                          {speciesLoading && (
                            <p className="px-4 py-3 text-sm text-slate-400">Loading species…</p>
                          )}

                          {speciesError && !speciesLoading && (
                            <p className="px-4 py-3 text-sm text-rose-200">{speciesError}</p>
                          )}

                          {!speciesLoading && !speciesError && speciesSuggestions.length === 0 && (
                            <p className="px-4 py-3 text-sm text-slate-400">
                              No species found. Try another name.
                            </p>
                          )}

                          {!speciesLoading &&
                            !speciesError &&
                            speciesSuggestions.map((match) => (
                              <button
                                key={match.speciesCode}
                                type="button"
                                onClick={() => handleSuggestionSelection(match)}
                                className="flex w-full flex-col items-start gap-1 px-4 py-3 text-left transition hover:bg-slate-800/80"
                              >
                                <span className="font-medium text-slate-100">{match.comName}</span>
                                <span className="text-xs uppercase tracking-wide text-slate-400">
                                  {match.sciName}
                                </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                </div>
              </div>

              <div className="flex flex-col gap-2 md:col-span-1 lg:col-span-1">
                <label className="text-sm font-medium text-slate-300">Minimum bird count</label>
                <select
                  value={minBirdCount}
                  onChange={(event) => setMinBirdCount(Number(event.target.value))}
                  className="rounded-xl border border-slate-700/60 bg-slate-900/80 px-4 py-3 text-base text-slate-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-500/50"
                >
                  {MIN_BIRD_COUNT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-slate-500">
                  Filter sightings by the reported group size when available.
                </span>
              </div>

              <div className="flex flex-col gap-2 md:col-span-1 lg:col-span-1">
                <label className="text-sm font-medium text-slate-300">Search radius</label>
                <select
                  value={radiusMiles}
                  onChange={(event) => setRadiusMiles(Number(event.target.value))}
                  className="rounded-xl border border-slate-700/60 bg-slate-900/80 px-4 py-3 text-base text-slate-100 outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-500/50"
                >
                  {RADIUS_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option} miles
                    </option>
                  ))}
                </select>
                <span className="text-xs text-slate-500">
                  Larger radii may return more sightings but could be farther away.
                </span>
              </div>
            </div>

            <button
              type="submit"
              className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-sky-500 px-4 py-3 text-base font-semibold text-slate-900 transition hover:bg-sky-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-200 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!isFormValid || searchState === 'searching' || !hasApiKey || isCooldown}
            >
              {searchState === 'searching'
                ? 'Searching sightings…'
                : isCooldown
                  ? `Please wait${cooldownSeconds ? ` (${cooldownSeconds}s)` : ''}`
                  : 'Find recent sightings'}
            </button>

            {errorMessage && (
              <p className="mt-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                {errorMessage}
              </p>
            )}

            {renderClosestSightingPanel('mt-6 lg:hidden')}
          </form>

          <section className="space-y-4">
            {searchSummary && (
              <div className="space-y-2 text-sm text-slate-300">
                <p>
                  Showing observations for{' '}
                  <span className="font-semibold text-sky-300">{searchSummary.speciesCommonName}</span>{' '}
                  <span className="italic text-slate-500">
                    ({searchSummary.speciesScientificName})
                  </span>{' '}
                  near{' '}
                  <span className="font-semibold text-sky-300">{searchSummary.locationLabel}</span> in
                  the last {DEFAULT_LOOKBACK_DAYS} days within {searchSummary.radiusMiles} miles.
                </p>
                <p>
                  {minBirdCount > 1
                    ? 'Only checklists reporting multiple birds are shown.'
                    : 'Showing all reported counts.'}
                </p>
                {lastFetchedAt && (
                  <p className="text-xs text-slate-500">
                    Data fetched from eBird at {formatFetchTimestamp(lastFetchedAt)}.
                  </p>
                )}
                <p className="text-xs uppercase tracking-wide text-slate-500">
                  {searchSummary.observationsFound} sightings found
                </p>
              </div>
            )}

            {searchState === 'ready' && observations.length === 0 && (
              <div className="rounded-2xl border border-slate-800/70 bg-slate-900/60 p-8 text-center text-slate-300">
                <h2 className="text-xl font-semibold text-slate-100">No recent sightings nearby</h2>
                <p className="mt-2">
                  Try expanding the search radius or looking back further in time to broaden the results.
                </p>
              </div>
            )}

            {observations.length > 0 && (
              <div className="grid gap-4 md:grid-cols-2">
                {observations.map((observation) => (
                  <article
                    key={observation.subId}
                    className="group rounded-2xl border border-slate-800/70 bg-slate-900/70 p-5 transition hover:border-sky-400/60 hover:shadow-[0_30px_60px_-50px_rgba(56,189,248,0.6)]"
                  >
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-100">{observation.locName}</h3>
                        <p className="text-xs uppercase tracking-wide text-slate-500">
                          {formatDate(observation.obsDt)} • {formatRelativeTime(observation.obsDt)}
                        </p>
                      </div>
                      <span className="rounded-full bg-sky-500/20 px-3 py-1 text-xs font-medium text-sky-200">
                        {formatDistance(observation.distance)}
                      </span>
                    </div>
                    <dl className="mt-4 space-y-2 text-sm text-slate-300">
                      <div className="flex justify-between">
                        <dt className="text-slate-400">Reported count</dt>
                        <dd className="font-medium text-slate-100">
                          {observation.howMany ?? 'Not specified'}
                        </dd>
                      </div>
                      <div className="flex justify-between">
                        <dt className="text-slate-400">Coordinates</dt>
                        <dd className="font-mono text-xs text-slate-400">
                          {observation.lat.toFixed(3)}, {observation.lng.toFixed(3)}
                        </dd>
                      </div>
                    </dl>
                  </article>
                ))}
              </div>
            )}
          </section>
        </section>

        <aside className="flex w-full flex-col gap-6 rounded-3xl border border-slate-800/70 bg-slate-900/60 p-6 backdrop-blur lg:w-[22rem] lg:flex-none">
          <div className="rounded-2xl border border-sky-500/30 bg-sky-500/10 p-6 text-slate-100">
            <h2 className="text-lg font-semibold text-sky-100">Plan your outing</h2>
            <p className="mt-2 text-sm text-slate-200">
              Use the map links, recent checklist IDs, and your own notes to keep track of birds you are
              chasing. Want automated alerts? Connect BirdTrail to a backend of your choice or subscribe
              to eBird&rsquo;s daily county emails.
            </p>
          </div>

          {renderClosestSightingPanel('hidden lg:block')}
        </aside>
      </main>
    </div>
  )
}

export default App



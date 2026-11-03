import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import {
  getDepartures,
  getJourneyDetails,
  getStations,
  type Departure,
  type JourneyDetails,
  type Station,
} from './api'
import './App.css'

const DEFAULT_TIME_RANGE = '24:00'
const MAX_TIME_RANGE_MINUTES = 48 * 60
const MAX_DEPARTURES = 20
const API_MAX_OBSERVATIONS = 100
const DETAIL_CONCURRENCY = 4

type FieldErrors = Partial<Record<'stationId' | 'date' | 'timeRange' | 'numberOfDepartures', string>>
type DetailState =
  | { status: 'loading' }
  | { status: 'loaded'; journey: JourneyDetails; warnings: string[] }
  | { status: 'error'; message: string }

interface SearchQuery {
  stationId: string
  date: string
  timeRangeSeconds: number
  pageSize: number
}

function osloToday(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Oslo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]))
  return `${values.year}-${values.month}-${values.day}`
}

function isValidDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return false
  const [, yearText, monthText, dayText] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  if (year < 1 || year > 9999) return false
  const parsed = new Date(0)
  parsed.setUTCHours(0, 0, 0, 0)
  parsed.setUTCFullYear(year, month - 1, day)
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

function validateForm(
  stationId: string,
  stations: Station[],
  date: string,
  timeRange: string,
  numberOfDepartures: string,
): FieldErrors {
  const errors: FieldErrors = {}
  if (!stations.some((station) => station.id === stationId)) {
    errors.stationId = 'Velg en stasjon fra listen.'
  }
  if (!isValidDate(date)) {
    errors.date = 'Velg en gyldig dato.'
  }

  const durationMinutes = parseDurationMinutes(timeRange)
  if (durationMinutes === null) {
    errors.timeRange = 'Skriv tidsvindu som HH:MM, fra 00:00 til 48:00.'
  }

  const count = Number(numberOfDepartures)
  if (numberOfDepartures.trim() === '' || !Number.isInteger(count) || count < 1 || count > MAX_DEPARTURES) {
    errors.numberOfDepartures = `Avganger per side må være et heltall mellom 1 og ${MAX_DEPARTURES}.`
  }
  return errors
}

function formatTimeRangeInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 4)
  return digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits
}

function parseDurationMinutes(value: string): number | null {
  const match = /^(\d{2}):([0-5]\d)$/.exec(value)
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const totalMinutes = hours * 60 + minutes
  if (totalMinutes > MAX_TIME_RANGE_MINUTES) return null
  return totalMinutes
}

function formatTime(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('nb-NO', {
    timeZone: 'Europe/Oslo',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function formatDate(value: string): string {
  if (!isValidDate(value)) return value
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(0)
  parsed.setUTCHours(12, 0, 0, 0)
  parsed.setUTCFullYear(year, month - 1, day)
  return new Intl.DateTimeFormat('nb-NO', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Oslo',
  }).format(parsed)
}

function App() {
  const [stations, setStations] = useState<Station[]>([])
  const [stationId, setStationId] = useState('')
  const [date, setDate] = useState(osloToday)
  const [timeRange, setTimeRange] = useState(DEFAULT_TIME_RANGE)
  const [numberOfDepartures, setNumberOfDepartures] = useState(String(MAX_DEPARTURES))
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [departures, setDepartures] = useState<Departure[]>([])
  const [activeQuery, setActiveQuery] = useState<SearchQuery | null>(null)
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [limitReached, setLimitReached] = useState(false)
  const [detailsTotal, setDetailsTotal] = useState(0)
  const [details, setDetails] = useState<Record<string, DetailState>>({})
  const [requestError, setRequestError] = useState('')
  const [departureWarnings, setDepartureWarnings] = useState<string[]>([])
  const [hasSearched, setHasSearched] = useState(false)
  const [stationsLoading, setStationsLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [detailsLoaded, setDetailsLoaded] = useState(0)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const requestId = useRef(0)
  const activeRequest = useRef<AbortController | null>(null)
  const detailsRef = useRef<Record<string, DetailState>>({})
  const resultsRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    detailsRef.current = details
  }, [details])

  useEffect(() => {
    const controller = new AbortController()
    activeRequest.current = controller
    getStations(controller.signal)
      .then((result) => {
        setStations(result)
        if (result.length > 0) setStationId(result[0].id)
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setRequestError(errorMessage(error))
      })
      .finally(() => {
        if (!controller.signal.aborted) setStationsLoading(false)
      })
    return () => {
      controller.abort()
      activeRequest.current?.abort()
      requestId.current += 1
    }
  }, [])

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const errors = validateForm(stationId, stations, date, timeRange, numberOfDepartures)
    setFieldErrors(errors)
    setRequestError('')
    if (Object.keys(errors).length > 0) return

    const query: SearchQuery = {
      stationId,
      date,
      timeRangeSeconds: (parseDurationMinutes(timeRange) ?? 0) * 60,
      pageSize: Math.min(Number(numberOfDepartures), MAX_DEPARTURES),
    }
    setActiveQuery(query)
    setDepartures([])
    setDetails({})
    setDepartureWarnings([])
    setHasSearched(false)
    setHasMore(false)
    setLimitReached(false)
    setPage(1)
    void loadPage(query, 1, true)
  }

  // API-et har ingen offset, så vi henter nok avganger til å fylle siden og se om det finnes flere.
  async function fetchPage(query: SearchQuery, targetPage: number, signal: AbortSignal) {
    const needed = targetPage * query.pageSize
    let limit = Math.min(API_MAX_OBSERVATIONS, needed + 1)
    for (;;) {
      const result = await getDepartures(
        {
          stationId: query.stationId,
          date: query.date,
          timeRange: query.timeRangeSeconds,
          numberOfDepartures: limit,
        },
        signal,
      )
      const exhausted = result.observations < limit
      const enough = result.departures.length > needed
      if (enough || exhausted || limit >= API_MAX_OBSERVATIONS) {
        return {
          departures: result.departures.slice(needed - query.pageSize, needed),
          hasMore: enough,
          limitReached: !exhausted && !enough,
          warnings: result.warnings,
        }
      }
      limit = Math.min(API_MAX_OBSERVATIONS, limit + query.pageSize)
    }
  }

  async function loadPage(query: SearchQuery, targetPage: number, reset = false) {
    const currentRequest = ++requestId.current
    activeRequest.current?.abort()
    const controller = new AbortController()
    activeRequest.current = controller
    setSearching(true)
    setDetailsLoading(false)
    setRequestError('')

    try {
      const result = await fetchPage(query, targetPage, controller.signal)
      if (currentRequest !== requestId.current) return
      if (result.departures.length === 0 && targetPage > 1) {
        setHasMore(false)
        return
      }
      setDepartures(result.departures)
      setPage(targetPage)
      setHasMore(result.hasMore)
      setLimitReached(result.limitReached)
      setDepartureWarnings(result.warnings)
      setHasSearched(true)
      setSearching(false)
      await loadDetails(result.departures, currentRequest, controller.signal, reset)
    } catch (error) {
      if (currentRequest === requestId.current) setRequestError(errorMessage(error))
    } finally {
      if (currentRequest === requestId.current) setSearching(false)
    }
  }

  async function loadDetails(list: Departure[], currentRequest: number, signal: AbortSignal, reset: boolean) {
    const cache = reset ? {} : detailsRef.current
    const pending = list.filter(({ id }) => cache[id]?.status !== 'loaded')
    if (pending.length === 0) return

    setDetailsLoading(true)
    setDetailsLoaded(0)
    setDetailsTotal(pending.length)
    setDetails((current) => ({
      ...current,
      ...Object.fromEntries(pending.map(({ id }) => [id, { status: 'loading' } as DetailState])),
    }))

    let nextIndex = 0
    let completed = 0
    const worker = async () => {
      while (nextIndex < pending.length) {
        const departure = pending[nextIndex++]
        try {
          const response = await getJourneyDetails(departure.id, signal)
          if (currentRequest !== requestId.current) return
          setDetails((current) => ({
            ...current,
            [departure.id]: { status: 'loaded', journey: response.journey, warnings: response.warnings },
          }))
        } catch (error) {
          if (currentRequest !== requestId.current) return
          setDetails((current) => ({
            ...current,
            [departure.id]: { status: 'error', message: errorMessage(error) },
          }))
        } finally {
          completed += 1
          if (currentRequest === requestId.current) setDetailsLoaded(completed)
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, pending.length) }, worker))
    if (currentRequest === requestId.current) setDetailsLoading(false)
  }

  function goToPage(targetPage: number) {
    if (!activeQuery || targetPage < 1 || searching) return
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    void loadPage(activeQuery, targetPage)
  }

  const displayedStationId = activeQuery?.stationId ?? stationId
  const displayedDate = activeQuery?.date ?? date
  const selectedStation = stations.find((station) => station.id === displayedStationId)

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="Buss for tog – startsiden">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" fill="none">
              <rect x="5" y="4" width="22" height="24" rx="8" fill="currentColor" />
              <path d="M9 10h14v8H9zM10 23h2m8 0h2" stroke="#142c2c" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </span>
          <span>Buss for tog</span>
        </a>
        <span className="topbar-tag"><span className="status-dot" /> Reiseoversikt</span>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">RUTER · AVGANGER · ERSTATNING</p>
            <h1>Finn reisen.<br /><span>Følg hele ruta.</span></h1>
            <p className="hero-description">
              Se avganger, stopp og tider – og finn ut når bussen kjører for toget.
            </p>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="sun-disc" />
            <div className="route-line"><span /><span /><span /></div>
            <div className="route-bus">
              <svg viewBox="0 0 140 76" fill="none">
                <path d="M12 16a8 8 0 0 1 8-8h88a20 20 0 0 1 20 20v30H12V16Z" fill="#e1f06a" />
                <path d="M23 18h36v22H23zM67 18h25v22H67zM100 18h17a10 10 0 0 1 10 10v12h-27z" fill="#284344" />
                <path d="M12 48h116v10H12z" fill="#b9d23f" />
                <circle cx="37" cy="60" r="9" fill="#152d2d" /><circle cx="103" cy="60" r="9" fill="#152d2d" />
                <circle cx="37" cy="60" r="3" fill="#e9eddb" /><circle cx="103" cy="60" r="3" fill="#e9eddb" />
              </svg>
            </div>
            <div className="hero-label">DIN REISE, HELE VEIEN</div>
          </div>
        </section>

        <section className="search-panel" aria-labelledby="search-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">PLANLEGG REISEN</p>
              <h2 id="search-title">Hvor skal du reise?</h2>
            </div>
            <span className="step-badge"><span>01</span> Søk avganger</span>
          </div>

          <form onSubmit={handleSearch} noValidate>
            <div className="form-grid">
              <div className="field field-station">
                <label htmlFor="station">Stasjon</label>
                <div className="input-wrap">
                  <span className="input-icon" aria-hidden="true">⌖</span>
                  <select
                    id="station"
                    value={stationId}
                    onChange={(event) => {
                      setStationId(event.target.value)
                      setFieldErrors((current) => ({ ...current, stationId: undefined }))
                    }}
                    disabled={stationsLoading || stations.length === 0}
                    aria-invalid={Boolean(fieldErrors.stationId)}
                    aria-describedby={fieldErrors.stationId ? 'station-error' : undefined}
                  >
                    {stationsLoading && <option value="">Henter stasjoner …</option>}
                    {!stationsLoading && stations.length === 0 && <option value="">Ingen stasjoner</option>}
                    {stations.map((station) => (
                      <option key={station.id} value={station.id}>{station.name}</option>
                    ))}
                  </select>
                </div>
                {fieldErrors.stationId && <p className="field-error" id="station-error">{fieldErrors.stationId}</p>}
              </div>

              <div className="field">
                <label htmlFor="date">Reisedato</label>
                <div className="input-wrap">
                  <span className="input-icon" aria-hidden="true">▦</span>
                  <input
                    id="date"
                    type="date"
                    min="0001-01-01"
                    max="9999-12-31"
                    value={date}
                    onChange={(event) => {
                      setDate(event.target.value)
                      setFieldErrors((current) => ({ ...current, date: undefined }))
                    }}
                    aria-invalid={Boolean(fieldErrors.date)}
                    aria-describedby={fieldErrors.date ? 'date-error' : undefined}
                  />
                </div>
                {fieldErrors.date && <p className="field-error" id="date-error">{fieldErrors.date}</p>}
              </div>

              <div className="field">
                <label htmlFor="time-range">Tidsvindu <span className="label-unit">(timer:minutter)</span></label>
                <div className="input-wrap">
                  <span className="input-icon" aria-hidden="true">◷</span>
                  <input
                    id="time-range"
                    type="text"
                    inputMode="numeric"
                    maxLength={5}
                    placeholder="HH:MM"
                    autoComplete="off"
                    value={timeRange}
                    onChange={(event) => {
                      setTimeRange(formatTimeRangeInput(event.target.value))
                      setFieldErrors((current) => ({ ...current, timeRange: undefined }))
                    }}
                    aria-invalid={Boolean(fieldErrors.timeRange)}
                    aria-describedby={fieldErrors.timeRange ? 'time-range-error' : 'time-range-hint'}
                  />
                </div>
                {fieldErrors.timeRange
                  ? <p className="field-error" id="time-range-error">{fieldErrors.timeRange}</p>
                  : <p className="field-hint" id="time-range-hint">Format HH:MM · fra 00:00 til 48:00</p>}
              </div>

              <div className="field field-count">
                <label htmlFor="departure-count">Avganger per side</label>
                <div className="input-wrap">
                  <span className="input-icon" aria-hidden="true">≋</span>
                  <input
                    id="departure-count"
                    type="text"
                    maxLength={2}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    autoComplete="off"
                    value={numberOfDepartures}
                    onChange={(event) => {
                      setNumberOfDepartures(event.target.value.replace(/\D/g, '').slice(0, 2))
                      setFieldErrors((current) => ({ ...current, numberOfDepartures: undefined }))
                    }}
                    aria-invalid={Boolean(fieldErrors.numberOfDepartures)}
                    aria-describedby={fieldErrors.numberOfDepartures ? 'count-error' : 'count-hint'}
                  />
                </div>
                {fieldErrors.numberOfDepartures
                  ? <p className="field-error" id="count-error">{fieldErrors.numberOfDepartures}</p>
                  : <p className="field-hint" id="count-hint">Velg mellom 1 og {MAX_DEPARTURES}</p>}
              </div>

              <button className="search-button" type="submit" disabled={stationsLoading || stations.length === 0 || searching}>
                {searching ? <span className="spinner" aria-hidden="true" /> : <span aria-hidden="true">⌕</span>}
                {searching ? 'Søker …' : 'Finn avganger'}
                {!searching && <span className="button-arrow" aria-hidden="true">→</span>}
              </button>
            </div>
          </form>

          {requestError && (
            <div className="alert alert-error" role="alert">
              <span className="alert-symbol" aria-hidden="true">!</span>
              <div><strong>Kunne ikke hente data</strong><p>{requestError}</p></div>
              <button type="button" className="alert-dismiss" onClick={() => setRequestError('')} aria-label="Lukk feilmelding">×</button>
            </div>
          )}
        </section>

        <section className="results-section" aria-labelledby="results-title" ref={resultsRef}>
          <div className="results-heading">
            <div>
              <p className="eyebrow">AVGANGER OG RUTER</p>
              <h2 id="results-title">{selectedStation?.name ?? 'Dine avganger'}</h2>
              <p className="results-subtitle">{formatDate(displayedDate)}{selectedStation ? ` · ${selectedStation.shortName}` : ''}</p>
            </div>
            {departures.length > 0 && (
              <div className="result-count">
                <strong>{departures.length}</strong>
                <span>{departures.length === 1 ? 'avgang' : 'avganger'} · side {page}</span>
              </div>
            )}
          </div>

          {departureWarnings.map((warning, index) => (
            <div className="alert alert-warning" role="status" key={`${warning}-${index}`}>
              <span className="alert-symbol" aria-hidden="true">!</span><p>{warning}</p>
            </div>
          ))}

          {detailsLoading && (
            <div className="detail-progress" role="status" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              Henter rutedetaljer {detailsLoaded} av {detailsTotal} …
            </div>
          )}

          {departures.length > 0 && (
            <div className="departure-list">
              {departures.map((departure, index) => (
                <DepartureCard
                  key={departure.id}
                  departure={departure}
                  selectedStationId={displayedStationId}
                  index={(page - 1) * (activeQuery?.pageSize ?? 0) + index}
                  detail={details[departure.id]}
                />
              ))}
            </div>
          )}

          {departures.length > 0 && (page > 1 || hasMore) && (
            <nav className="pagination" aria-label="Bla mellom sider med avganger">
              <button type="button" onClick={() => goToPage(page - 1)} disabled={page <= 1 || searching}>
                <span aria-hidden="true">←</span> Forrige
              </button>
              <span className="pagination-status" aria-live="polite">
                {searching ? 'Henter …' : `Side ${page}`}
              </span>
              <button type="button" onClick={() => goToPage(page + 1)} disabled={!hasMore || searching}>
                Neste <span aria-hidden="true">→</span>
              </button>
            </nav>
          )}

          {departures.length > 0 && !hasMore && limitReached && (
            <p className="pagination-note" role="status">
              API-et gir maks {API_MAX_OBSERVATIONS} avganger per søk, så det kan finnes flere. Prøv en annen dato eller et kortere tidsvindu.
            </p>
          )}

          {!searching && departures.length === 0 && !requestError && (
            <div className="empty-state">
              <div className="empty-icon" aria-hidden="true">↗</div>
              <h3>
                {stations.length === 0
                  ? 'Stasjonene kunne ikke lastes'
                  : hasSearched
                    ? 'Ingen avganger funnet'
                    : 'Klar for å finne reisen?'}
              </h3>
              <p>
                {stations.length === 0
                  ? 'Kontroller at API-et kjører, og last siden på nytt.'
                  : hasSearched
                    ? 'Det finnes ingen avganger i tidsvinduet. Prøv en annen dato eller et lengre tidsvindu.'
                  : 'Velg stasjon og dato, og søk for å se avganger og rutedetaljer.'}
              </p>
            </div>
          )}
        </section>
      </main>

      <footer className="footer">
        <span><span className="footer-mark">●</span> Buss for tog</span>
        <span>Viser reisedata fra BussForTog API</span>
      </footer>
    </div>
  )
}

function DepartureCard({
  departure,
  selectedStationId,
  index,
  detail,
}: {
  departure: Departure
  selectedStationId: string
  index: number
  detail: DetailState | undefined
}) {
  const journey = detail?.status === 'loaded' ? detail.journey : undefined
  const isReplacement = journey?.vehicleType?.toLowerCase() === 'bus'
    && (journey.replacements?.length ?? 0) > 0
  const selectedCall = journey?.calls?.find((call) => call.quayId === selectedStationId)
    ?? journey?.calls?.[0]
  const departureTime = formatTime(selectedCall?.departure ?? selectedCall?.arrival ?? null)
  const destination = selectedCall?.destination || journey?.calls?.[journey.calls.length - 1]?.name
  const origin = journey?.calls?.[0]?.name
  const [open, setOpen] = useState(false)
  const title = journey?.lineNumber || `Avgang ${String(index + 1).padStart(2, '0')}`
  const detailWarnings = detail?.status === 'loaded' ? detail.warnings : []
  const closeButton = (
    <button
      type="button"
      className="close-button"
      onClick={() => setOpen(false)}
      aria-label={`Lukk detaljer for ${title}`}
    >×</button>
  )

  return (
    <article className="departure-card">
      <div className="departure-time">
        {detail?.status === 'loading' || !detail ? <span className="time-skeleton" /> : departureTime}
        <span className="time-date">{departure.operatingDay ? formatDate(departure.operatingDay) : 'Avgangstid'}</span>
      </div>
      <div className="departure-main">
        <div className="departure-topline">
          <h3>{title}</h3>
          {isReplacement && <span className="replacement-badge"><span>↗</span> Buss for tog</span>}
          {journey?.vehicleType && !isReplacement && (
            <span className={`vehicle-badge ${journey.vehicleType.toLowerCase() === 'train' ? 'vehicle-train' : ''}`}>
              {journey.vehicleType === 'train' ? 'Tog' : 'Buss'}
            </span>
          )}
        </div>
        <p className="departure-route">
          {origin && <span><small>Fra</small> {origin}</span>}
          {origin && destination && <span aria-hidden="true" className="route-arrow">→</span>}
          {destination && <span><small>Til</small> {destination}</span>}
          {!origin && !destination && 'Rutedetaljer fra valgt stasjon'}
        </p>
        <p className="departure-id">{departure.id}</p>
        {detail?.status === 'error' && (
          <p className="detail-error-message" role="status">{detail.message}</p>
        )}
      </div>
      <div className="departure-action">
        {detail?.status === 'loading' && <span className="inline-loading"><span className="spinner" /> Henter</span>}
        {detail?.status === 'error' && <span className="detail-error" title={detail.message}>Detaljer utilgjengelig</span>}
        <details
          className="journey-disclosure"
          open={open}
          onToggle={(event) => setOpen(event.currentTarget.open)}
          onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false) }}
        >
          <summary aria-label={`Vis detaljer for ${title}`}>Detaljer <span aria-hidden="true">⌄</span></summary>
          {journey && <JourneyPanel journey={journey} warnings={detailWarnings} onClose={closeButton} />}
          {detail?.status === 'error' && <p className="inline-error">{closeButton}{detail.message}</p>}
          {detail?.status === 'loading' && <p className="detail-loading-text">{closeButton}Henter rutedetaljer …</p>}
        </details>
      </div>
    </article>
  )
}

function JourneyPanel({
  journey,
  warnings,
  onClose,
}: {
  journey: JourneyDetails
  warnings: string[]
  onClose: ReactNode
}) {
  return (
    <div className="journey-panel">
      {onClose}
      {warnings.map((warning, index) => (
        <p className="partial-warning" key={`${warning}-${index}`}>Delvis informasjon: {warning}</p>
      ))}
      <div className="journey-meta">
        <span>{journey.operator || 'Operatør ikke oppgitt'}</span>
        <span>Driftsdato: {journey.operatingDay ? formatDate(journey.operatingDay) : '—'}</span>
        <span>Type: {journey.vehicleType || 'Ukjent'}</span>
      </div>
      {journey.replacements.length > 0 && (
        <p className="replacement-note">
          Erstatter tog {journey.replacements.join(', ')}
        </p>
      )}
      <h4>Stopp på ruta</h4>
      <ol className="stop-list">
        {journey.calls.map((call, index) => (
          <li key={`${call.quayId || call.name}-${index}`}>
            <span className="stop-marker" aria-hidden="true" />
            <div className="stop-name">
              <strong>{call.name || 'Stopp'}</strong>
              {call.publicCode && <span>{call.publicCode}</span>}
              {call.destination && <small>{call.destination}</small>}
              <span className="activity-label">
                {call.canBoard ? 'Påstigning' : ''}
                {call.canBoard && call.canAlight ? ' · ' : ''}
                {call.canAlight ? 'Avstigning' : ''}
              </span>
            </div>
            <div className="stop-times">
              <span><small>Plan</small>{formatTime(call.arrival)} / {formatTime(call.departure)}</span>
              {(call.expectedArrival || call.expectedDeparture) && (
                <span><small>Forventet</small>{formatTime(call.expectedArrival)} / {formatTime(call.expectedDeparture)}</span>
              )}
              {(call.actualArrival || call.actualDeparture) && (
                <span><small>Faktisk</small>{formatTime(call.actualArrival)} / {formatTime(call.actualDeparture)}</span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'Noe gikk galt. Prøv igjen.'
}

export default App

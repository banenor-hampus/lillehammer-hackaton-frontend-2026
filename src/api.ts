export interface Station {
  id: string
  shortName: string
  name: string
  isSynthetic: boolean
}

export interface Departure {
  id: string
  operatingDay: string | null
}

export interface JourneyCall {
  order: number
  name: string | null
  quayId: string | null
  publicCode: string | null
  destination: string | null
  arrival: string | null
  expectedArrival: string | null
  departure: string | null
  expectedDeparture: string | null
  actualArrival: string | null
  actualDeparture: string | null
  canBoard: boolean | null
  canAlight: boolean | null
}

export interface JourneyDetails {
  id: string
  operatingDay: string | null
  operator: string | null
  lineNumber: string | null
  vehicleType: string | null
  replacements: string[]
  calls: JourneyCall[]
}

export interface DeparturesRequest {
  stationId: string
  date: string
  timeRange: number
  numberOfDepartures: number
}

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? `${window.location.protocol}//${window.location.hostname}:5087`).replace(/\/+$/, '')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function errorMessages(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.errors)) return []
  return value.errors.flatMap((item) => {
    if (isRecord(item) && typeof item.message === 'string') return [item.message]
    return []
  })
}

async function requestJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      headers: { Accept: 'application/json' },
      signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new Error(`Fikk ikke kontakt med API-et på ${API_BASE_URL}. Kontroller at backend kjører.`)
  }

  const responseText = await response.text()
  let body: unknown
  try {
    body = responseText ? JSON.parse(responseText) as unknown : null
  } catch {
    throw new Error(`API-et svarte med ugyldig JSON (HTTP ${response.status}).`)
  }

  if (!response.ok) {
    const messages = errorMessages(body)
    const apiMessage = isRecord(body) && typeof body.message === 'string' ? body.message : null
    const message = messages[0] ?? apiMessage
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After')
      throw new Error(`API-et begrenser forespørsler midlertidig.${retryAfter ? ` Prøv igjen om ${retryAfter} sekunder.` : ''}${message ? ` ${message}` : ''}`)
    }
    if (response.status === 503) {
      throw new Error(message ? `Datakilden er midlertidig utilgjengelig: ${message}` : 'Datakilden er midlertidig utilgjengelig (HTTP 503).')
    }
    throw new Error(message ? `${message} (HTTP ${response.status})` : `Forespørselen feilet (HTTP ${response.status}).`)
  }
  return body
}

export async function getStations(signal?: AbortSignal): Promise<Station[]> {
  const result = await requestJson('/api/stasjoner', signal)
  if (!Array.isArray(result)) throw new Error('API-et returnerte en uventet stasjonsliste.')

  const stations = result.flatMap((item): Station[] => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.name !== 'string') return []
    return [{
      id: item.id,
      shortName: typeof item.shortName === 'string' ? item.shortName : item.name,
      name: item.name,
      isSynthetic: item.isSynthetic === true,
    }]
  })
  if (stations.length === 0) throw new Error('API-et returnerte ingen gyldige stasjoner.')
  return stations
}

export async function getDepartures(
  request: DeparturesRequest,
  signal?: AbortSignal,
): Promise<{ departures: Departure[]; observations: number; warnings: string[] }> {
  const query = new URLSearchParams({
    stationId: request.stationId,
    date: request.date,
    timeRange: String(request.timeRange),
    numberOfDepartures: String(request.numberOfDepartures),
  })
  const result = await requestJson(`/api/avganger?${query}`, signal)
  const warnings = errorMessages(result)
  if (!isRecord(result) || !isRecord(result.data) || !Array.isArray(result.data.quays)) {
    if (warnings.length > 0) throw new Error(warnings.join(' '))
    throw new Error('API-et returnerte et uventet format for avgangslisten.')
  }

  const uniqueDepartures = new Map<string, Departure>()
  let observations = 0
  for (const quay of result.data.quays) {
    if (!isRecord(quay) || !Array.isArray(quay.estimatedCalls)) continue
    for (const call of quay.estimatedCalls) {
      if (!isRecord(call) || !isRecord(call.datedServiceJourney)) continue
      const { id, operatingDay } = call.datedServiceJourney
      if (typeof id !== 'string' || id.length === 0) continue
      observations += 1
      if (!uniqueDepartures.has(id)) {
        uniqueDepartures.set(id, {
          id,
          operatingDay: asString(operatingDay),
        })
      }
    }
  }
  return { departures: [...uniqueDepartures.values()], observations, warnings }
}

export async function getJourneyDetails(
  id: string,
  signal?: AbortSignal,
): Promise<{ journey: JourneyDetails; warnings: string[] }> {
  const query = new URLSearchParams({ id })
  const result = await requestJson(`/api/rutedetaljer?${query}`, signal)
  const warnings = errorMessages(result)
  if (!isRecord(result) || !isRecord(result.data) || !isRecord(result.data.datedServiceJourney)) {
    if (warnings.length > 0) throw new Error(warnings.join(' '))
    throw new Error('API-et returnerte uventet format for rutedetaljene.')
  }

  const source = result.data.datedServiceJourney
  const serviceJourney = isRecord(source.serviceJourney) ? source.serviceJourney : {}
  const operator = isRecord(serviceJourney.operator) ? serviceJourney.operator : {}
  const line = isRecord(serviceJourney.line) ? serviceJourney.line : {}
  const replacements = Array.isArray(source.replacementForRelation)
    ? source.replacementForRelation.flatMap((relation) => {
      if (!isRecord(relation) || !isRecord(relation.datedServiceJourney)) return []
      const replacementJourney = relation.datedServiceJourney
      if (!isRecord(replacementJourney.serviceJourney)) return []
      const code = asString(replacementJourney.serviceJourney.TRAIN_REPLACEMENT)
      return code ? [code] : []
    })
    : []
  const calls = Array.isArray(source.estimatedCalls)
    ? source.estimatedCalls.flatMap((item, index): JourneyCall[] => {
      if (!isRecord(item)) return []
      const quay = isRecord(item.quay) ? item.quay : {}
      const destinationDisplay = isRecord(item.destinationDisplay) ? item.destinationDisplay : {}
      return [{
        order: asNumber(item.ORDER, index),
        name: asString(quay.name),
        quayId: asString(quay.id),
        publicCode: asString(quay.publicCode),
        destination: asString(destinationDisplay.FRONTTEXT),
        arrival: asString(item.STA),
        expectedArrival: asString(item.ETA),
        departure: asString(item.STD),
        expectedDeparture: asString(item.ETD),
        actualArrival: asString(item.ATA),
        actualDeparture: asString(item.ATD),
        canBoard: asBoolean(item.Boarding_Activity),
        canAlight: asBoolean(item.Alightning_Activity),
      }]
    })
    : []

  return {
    journey: {
      id: asString(source.ID) ?? id,
      operatingDay: asString(source.ORIGIN_DATE),
      operator: asString(operator.COMPANY),
      lineNumber: asString(line.LINE_NO),
      vehicleType: asString(serviceJourney.VEHICLE_TYPE),
      replacements,
      calls: calls.sort((first, second) => first.order - second.order),
    },
    warnings,
  }
}

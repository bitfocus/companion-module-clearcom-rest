import io, { Socket } from 'socket.io-client'
import { makeLogger } from './logger.js'
import { InstanceStatus } from '@companion-module/base'
import ModuleInstance from './main.js'
import { DeviceRecord, DeviceInfo, EndpointUpdatedEvent } from './types.js'

// ─── Logger ───────────────────────────────────────────────────────────────────

let _instance: ModuleInstance | null = null
const log = makeLogger('network', () => _instance?.config)

// ─── Request queue ────────────────────────────────────────────────────────────
// All HTTP requests are serialised — the Arcadia rejects concurrent writes.

let requestQueue: Promise<unknown> = Promise.resolve()

async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
	const result = requestQueue.then(async () => fn())
	// Reset to a simple settled promise so the chain doesn't accumulate
	requestQueue = result.then(
		() => undefined,
		() => undefined,
	)
	return result
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

/** Thrown for non-2xx responses. Already logged by handleErrorResponse — callers should not re-log. */
export class DeviceRequestError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'DeviceRequestError'
	}
}

async function handleErrorResponse(response: Response, method: string, url: string): Promise<never> {
	const shortUrl = url.replace(/.*\/api/, '/api')
	const statusLine = `${method} ${shortUrl} rejected: ${response.status} ${response.statusText}`
	let detail: string | undefined
	try {
		const body = (await response.json()) as Record<string, unknown>
		detail = (body['message'] ?? body['error'] ?? body['msg']) as string | undefined
	} catch {
		// not JSON — ignore
	}
	log.debug(statusLine)
	if (detail) log.error(detail)
	throw new DeviceRequestError(detail ?? statusLine)
}

function buildHeaders(instance: ModuleInstance): Record<string, string> {
	const headers: Record<string, string> = { Accept: 'application/json' }
	if (instance.bearerToken) headers['Authorization'] = `Bearer ${instance.bearerToken}`
	return headers
}

async function executeRequest<R>(
	method: 'GET' | 'POST' | 'PUT',
	url: string,
	instance: ModuleInstance,
	body?: unknown,
): Promise<R> {
	return enqueue(async () => {
		const shortUrl = url.replace(/.*\/api/, '/api')
		log.info(`→ ${method} ${shortUrl}`)
		log.debug(`→ ${method} ${shortUrl}${body !== undefined ? ` ${JSON.stringify(body)}` : ''}`)
		const init: RequestInit = {
			method,
			headers:
				body !== undefined ? { ...buildHeaders(instance), 'Content-Type': 'application/json' } : buildHeaders(instance),
		}
		if (body !== undefined) init.body = JSON.stringify(body)
		const response = await fetch(url, init)
		if (response.status === 401) {
			void reLogin(instance)
			throw new Error(`${method} ${url} failed: 401 Unauthorized`)
		}
		if (!response.ok) await handleErrorResponse(response, method, url)
		resetKeepalive(instance)
		const result = (await response.json()) as R
		log.debug(`← ${method} ${shortUrl} ${JSON.stringify(result)}`)
		return result
	})
}

export async function getRequest<R>(url: string, instance: ModuleInstance): Promise<R> {
	return executeRequest<R>('GET', url, instance)
}

export async function postRequest<R>(url: string, instance: ModuleInstance, body: unknown = {}): Promise<R> {
	return executeRequest<R>('POST', url, instance, body)
}

export async function putRequest<R>(url: string, instance: ModuleInstance, body: unknown = {}): Promise<R> {
	return executeRequest<R>('PUT', url, instance, body)
}

// ─── Keepalive / token refresh ────────────────────────────────────────────────

let keepaliveTimer: ReturnType<typeof setTimeout> | null = null
const KEEPALIVE_MS = 30_000

export function resetKeepalive(instance: ModuleInstance): void {
	if (keepaliveTimer) clearTimeout(keepaliveTimer)
	keepaliveTimer = setTimeout(() => {
		void refreshToken(instance)
	}, KEEPALIVE_MS)
}

function getTokenVersion(token: string): number | undefined {
	const payload = token.split('.')[1]
	if (!payload) {
		log.warn('getTokenVersion: malformed JWT — no payload segment')
		return undefined
	}
	try {
		const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { ver?: number }
		if (decoded.ver === undefined) {
			log.warn('getTokenVersion: JWT payload has no ver field')
			return undefined
		}
		return decoded.ver
	} catch (err) {
		log.warn(`getTokenVersion: failed to parse JWT payload: ${String(err)}`)
		return undefined
	}
}

async function refreshToken(instance: ModuleInstance): Promise<void> {
	try {
		const ver = getTokenVersion(instance.bearerToken)
		if (ver === undefined) {
			log.warn('refreshToken: cannot determine token version — skipping refresh')
			return
		}
		const response = await postRequest<{ jwt: string }>(`http://${instance.config.host}/auth/refresh`, instance, {
			jwtversion: ver,
		})
		instance.bearerToken = response.jwt
		log.debug('Token refreshed')
		resetKeepalive(instance)
	} catch {
		// Refresh failed — device may have rebooted. Re-login with credentials.
		log.warn('Token refresh failed — attempting full re-login')
		void reLogin(instance)
	}
}

let relogging = false
let connectionGeneration = 0

async function reLogin(instance: ModuleInstance): Promise<void> {
	if (relogging) return
	relogging = true
	try {
		const response = await postRequest<{ jwt: string }>(`http://${instance.config.host}/auth/local/login`, instance, {
			logemail: 'admin',
			logpassword: instance.secrets.password,
		})
		instance.bearerToken = response.jwt
		log.info('Re-login successful — reconnecting socket')
		disconnectSocket()
		connectSocket(instance)
	} catch (error) {
		log.warn(`Re-login failed: ${String(error)} — retrying in 30s`)
		resetKeepalive(instance)
	} finally {
		relogging = false
	}
}

// ─── Fetch functions ──────────────────────────────────────────────────────────
// Each fetch populates its store with DeviceRecord entries.
// After updating, feedback checks are triggered where applicable.

// Shared helper: fetch a list of DeviceRecords, optionally scoped to gids.
// If clearFirst is true the store is cleared before populating (full refresh).
async function fetchRecords(
	instance: ModuleInstance,
	url: string,
	process: (records: DeviceRecord[]) => void,
	triggerStores: string[],
): Promise<void> {
	const response = await getRequest<DeviceRecord[]>(url, instance)
	process(response)
	for (const store of triggerStores) instance.triggerFeedbacksForStore(store)
}

export async function fetchDevice(instance: ModuleInstance): Promise<void> {
	try {
		const response = await getRequest<DeviceInfo>(`http://${instance.config.host}/api/1/devices/1`, instance)
		instance.deviceInfo = response
		instance.updateVariables()
		log.info(
			`Device: ${response.deviceType_name} "${response.device_label}" fw=${response.versionSW ?? response.device_versionSW}`,
		)
	} catch (error) {
		log.error(`fetchDevice failed: ${String(error)}`)
	}
}

export async function fetchPorts(instance: ModuleInstance): Promise<void> {
	try {
		await fetchRecords(
			instance,
			`http://${instance.config.host}/api/1/devices/interfaces/ports`,
			(records) => {
				instance.ports.clear()
				for (const port of records) instance.ports.set(port['port_id'] as number, port)
				log.info(
					`Ports loaded: ${[...instance.ports.values()].map((p) => `${p['port_id'] as string}:${p['port_label'] as string}(${(p['port_config_type'] as string | undefined) ?? '?'})`).join(', ')}`,
				)
			},
			['ports'],
		)
	} catch (error) {
		log.error(`fetchPorts failed: ${String(error)}`)
	}
}

export async function fetchPortsGids(instance: ModuleInstance, gids: string[]): Promise<void> {
	if (gids.length === 0) return
	try {
		await fetchRecords(
			instance,
			`http://${instance.config.host}/api/1/devices/interfaces/ports?gids=${gids.join(',')}`,
			(records) => {
				for (const port of records) instance.ports.set(port['port_id'] as number, port)
			},
			['ports'],
		)
	} catch (error) {
		log.error(`fetchPortsGids failed: ${String(error)}`)
	}
}

function processEndpoints(instance: ModuleInstance, records: DeviceRecord[]): void {
	for (const ep of records) {
		const id = ep['id'] as number
		if (ep['isGateway']) {
			instance.gateways.set(id, ep)
		} else {
			instance.endpoints.set(id, ep)
			const live = ep['liveStatus'] as DeviceRecord | undefined
			if (live && Object.keys(live).length > 0) instance.endpointStatus.set(id, live)
		}
	}
}

export async function fetchEndpoints(instance: ModuleInstance): Promise<void> {
	try {
		await fetchRecords(
			instance,
			`http://${instance.config.host}/api/1/devices/endpoints`,
			(records) => {
				instance.endpoints.clear()
				instance.gateways.clear()
				processEndpoints(instance, records)
			},
			['endpoints', 'endpointStatus'],
		)
	} catch (error) {
		log.error(`fetchEndpoints failed: ${String(error)}`)
	}
}

export async function fetchEndpointsGids(instance: ModuleInstance, gids: string[]): Promise<void> {
	if (gids.length === 0) return
	try {
		await fetchRecords(
			instance,
			`http://${instance.config.host}/api/1/devices/endpoints?gids=${gids.join(',')}`,
			(records) => {
				processEndpoints(instance, records)
			},
			['endpoints', 'endpointStatus'],
		)
	} catch (error) {
		log.error(`fetchEndpointsGids failed: ${String(error)}`)
	}
}

export async function fetchRolesets(instance: ModuleInstance): Promise<void> {
	try {
		await fetchRecords(
			instance,
			`http://${instance.config.host}/api/2/rolesets`,
			(records) => {
				instance.rolesets.clear()
				for (const rs of records) instance.rolesets.set(rs['id'] as number, rs)
				log.info(`Rolesets loaded: ${[...instance.rolesets.values()].map((r) => `${r['id']}:${r['name']}`).join(', ')}`)
			},
			['rolesets'],
		)
	} catch (error) {
		log.error(`fetchRolesets failed: ${String(error)}`)
	}
}

export async function fetchRolesetsGids(instance: ModuleInstance, gids: string[]): Promise<void> {
	if (gids.length === 0) return
	try {
		await fetchRecords(
			instance,
			`http://${instance.config.host}/api/2/rolesets?gids=${gids.join(',')}`,
			(records) => {
				for (const rs of records) instance.rolesets.set(rs['id'] as number, rs)
			},
			['rolesets'],
		)
	} catch (error) {
		log.error(`fetchRolesetsGids failed: ${String(error)}`)
	}
}

export async function fetchKeysets(instance: ModuleInstance): Promise<void> {
	try {
		await fetchRecords(
			instance,
			`http://${instance.config.host}/api/2/keysets`,
			(records) => {
				instance.keysets.clear()
				for (const ks of records) instance.keysets.set(ks['id'] as number, ks)
				log.info(`Keysets loaded: ${[...instance.keysets.keys()].join(', ')}`)
			},
			['keysets'],
		)
	} catch (error) {
		log.error(`fetchKeysets failed: ${String(error)}`)
	}
}

export async function fetchKeysetsGids(instance: ModuleInstance, gids: string[]): Promise<void> {
	if (gids.length === 0) return
	try {
		await fetchRecords(
			instance,
			`http://${instance.config.host}/api/2/keysets?gids=${gids.join(',')}`,
			(records) => {
				for (const ks of records) instance.keysets.set(ks['id'] as number, ks)
			},
			['keysets'],
		)
	} catch (error) {
		log.error(`fetchKeysetsGids failed: ${String(error)}`)
	}
}

export async function fetchConnections(instance: ModuleInstance): Promise<void> {
	try {
		await fetchRecords(
			instance,
			`http://${instance.config.host}/api/1/connections/liveStatus`,
			(records) => {
				instance.connections.clear()
				for (const conn of records) instance.connections.set(conn['id'] as number, conn)
				log.info(
					`Connections loaded: ${[...instance.connections.values()].map((c) => `${c['id'] as string}:${c['label'] as string}`).join(', ')}`,
				)
			},
			['connections'],
		)
	} catch (error) {
		log.error(`fetchConnections failed: ${String(error)}`)
	}
}

// ─── Endpoint live status handler ─────────────────────────────────────────────

function handleEndpointUpdated(instance: ModuleInstance, event: EndpointUpdatedEvent): void {
	const { endpointId } = event
	log.debug(`EndpointUpdated ${endpointId} [${event.path}]`)

	const existing = instance.endpointStatus.get(endpointId) ?? {}

	if (event.path === 'liveStatus') {
		const value = event.value as DeviceRecord
		const isEmpty = Object.keys(value).length === 0
		const isOffline = !isEmpty && value['status'] !== 'online'

		if (isEmpty || isOffline) {
			const dpId = (existing['association'] as DeviceRecord | undefined)?.['dpId'] as number | undefined
			const offlineRole = dpId !== undefined ? instance.rolesets.get(dpId) : undefined
			instance.endpointStatus.delete(endpointId)
			log.info(`Beltpack ${endpointId} role=${offlineRole?.['name'] as string | undefined} offline`)
		} else {
			const merged: DeviceRecord = { ...existing, ...value }
			instance.endpointStatus.set(endpointId, merged)
			const role = instance.rolesets.get((merged['association'] as DeviceRecord | undefined)?.['dpId'] as number)
			log.debug(
				`Beltpack ${endpointId}: status=${merged['status'] as string} role=${role?.['name'] as string | undefined} ` +
					`battery=${merged['batteryLevel'] as string}% rssi=${merged['rssi'] as string} ` +
					`linkQuality=${merged['linkQuality'] as string}`,
			)
		}
		instance.triggerFeedbacksForStore('endpointStatus')
		return
	}

	if (event.path === 'liveStatus.keyState') {
		if (Object.keys(existing).length > 0) {
			instance.endpointStatus.set(endpointId, { ...existing, keyState: event.value as DeviceRecord })
			instance.triggerFeedbacksForStore('endpointStatus')
		}
		return
	}
}

// ─── Initial fetch ────────────────────────────────────────────────────────────

async function fetchNullingStatus(instance: ModuleInstance): Promise<void> {
	const twoPorts = [...instance.ports.values()].filter((p) => p['port_config_type'] === '2W')
	for (const port of twoPorts) {
		try {
			const result = await getRequest<{ nulling: string }>(
				`http://${instance.config.host}${port['res'] as string}/nulling`,
				instance,
			)
			instance.nullingStatus.set(port['port_id'] as number, result.nulling)
		} catch {
			// port may not support nulling — skip silently
		}
	}
	instance.triggerFeedbacksForStore('nulling')
}

async function initialFetch(instance: ModuleInstance, gen: number): Promise<void> {
	const check = (): boolean => gen === connectionGeneration
	try {
		if (!check()) return
		await fetchDevice(instance)
		if (!check()) return
		await fetchRolesets(instance)
		if (!check()) return
		await fetchConnections(instance)
		if (!check()) return
		await fetchPorts(instance)
		if (!check()) return
		await fetchKeysets(instance)
		if (!check()) return
		await fetchEndpoints(instance)
		if (!check()) return
		await fetchNullingStatus(instance)
		if (!check()) return
		instance.rebuildIfChanged()
		instance.triggerFeedbacksForStore('endpoints')
		instance.triggerFeedbacksForStore('endpointStatus')
		log.info('Initial fetch complete')
	} catch (error) {
		if (check()) log.error(`Initial fetch failed: ${String(error)}`)
	}
}

// ─── Socket ───────────────────────────────────────────────────────────────────

async function fetchAndRebuild(instance: ModuleInstance, fetch: Promise<void>): Promise<void> {
	await fetch
	instance.rebuildIfChanged()
}

let socket: Socket | null = null

const HANDLED_EVENTS = new Set([
	'connect',
	'disconnect',
	'connect_error',
	'DiscoveryInit',
	'live:connections',
	'live:roles',
	'live:rolesets',
	'live:endpoints',
	'live:devices',
	'live:ports',
	'init',
	'EndpointUpdated',
])

export function connectSocket(instance: ModuleInstance): void {
	_instance = instance
	if (socket?.connected) return

	socket = io(`http://${instance.config.host}`, {
		transports: ['polling'],
		path: '/socket.io',
		extraHeaders: { Authorization: `Bearer ${instance.bearerToken}` },
	})

	socket.on('connect', () => {
		log.info('Socket connected')
		instance.updateStatus(InstanceStatus.Ok)
		resetKeepalive(instance)
		const gen = ++connectionGeneration
		void initialFetch(instance, gen)
	})

	socket.on('disconnect', (reason: string) => {
		log.warn(`Socket disconnected: ${reason}`)
		instance.updateStatus(InstanceStatus.Disconnected)
	})

	socket.on('connect_error', (err: Error) => {
		log.error(`Socket connect error: ${err.message}`)
		instance.updateStatus(InstanceStatus.ConnectionFailure, err.message)
	})

	socket.on('DiscoveryInit', () => {
		log.debug('DiscoveryInit — system ready')
	})

	socket.on('live:connections', (_data: unknown) => {
		log.debug('live:connections — refreshing')
		void fetchAndRebuild(instance, fetchConnections(instance))
	})

	socket.on('live:roles', (_data: unknown) => {
		log.debug('live:roles — refreshing keysets')
		void fetchAndRebuild(
			instance,
			Promise.all([fetchKeysets(instance), fetchRolesets(instance)]).then(() => undefined),
		)
	})

	socket.on('live:rolesets', (data: unknown) => {
		const rolesets = (data as Record<string, unknown>)?.['rolesets'] as { gid: string }[] | undefined
		const gids = rolesets?.map((r) => r.gid) ?? []
		void fetchAndRebuild(instance, fetchRolesetsGids(instance, gids))
	})

	socket.on('live:ports', (data: unknown) => {
		const gids = (data as Record<string, unknown>)?.['gids'] as string[] | undefined
		if (gids && gids.length > 0) {
			void fetchAndRebuild(instance, fetchPortsGids(instance, gids))
		} else {
			log.debug('live:ports — refreshing all')
			void fetchAndRebuild(instance, fetchPorts(instance))
		}
	})

	socket.on('live:endpoints', (data: unknown) => {
		const gids = (data as Record<string, unknown>)?.['gids'] as string[] | undefined
		if (gids && gids.length > 0) {
			void fetchAndRebuild(instance, fetchEndpointsGids(instance, gids))
		} else {
			void fetchAndRebuild(instance, fetchEndpoints(instance))
		}
	})

	socket.on('live:devices', (_data: unknown) => {
		log.debug('live:devices — refreshing device info')
		void fetchDevice(instance)
	})

	socket.on('init', (data: unknown) => {
		log.debug(`init: ${JSON.stringify(data)}`)
	})

	socket.on('EndpointUpdated', (events: EndpointUpdatedEvent[]) => {
		let needsChoiceRebuild = false
		for (const event of events) {
			handleEndpointUpdated(instance, event)
			// liveStatus events carry data inline — no fetch needed
			// Other paths (settings, association changes) require a targeted refetch
			if (!event.path.startsWith('liveStatus')) {
				const ep = instance.endpoints.get(event.endpointId)
				const gid = ep?.['gid'] as string | undefined
				if (gid) {
					void fetchEndpointsGids(instance, [gid])
				} else {
					void fetchEndpoints(instance)
				}
				needsChoiceRebuild = true
			}
		}
		if (needsChoiceRebuild) {
			instance.rebuildIfChanged()
		}
	})

	// Log all socket events at appropriate levels
	const originalOnevent = (socket as unknown as { onevent: (packet: { data: unknown[] }) => void }).onevent.bind(socket)
	;(socket as unknown as { onevent: (packet: { data: unknown[] }) => void }).onevent = (packet) => {
		const [event, ...args] = packet.data
		if (HANDLED_EVENTS.has(event as string)) {
			log.info(`← Socket [${event}]`)
			log.debug(`← Socket [${event}] ${JSON.stringify(args)}`)
		} else {
			log.info(`← Socket [${event}] (unhandled)`)
			log.debug(`← Socket [${event}] (unhandled) ${JSON.stringify(args)}`)
		}
		originalOnevent(packet)
	}
}

export function disconnectSocket(): void {
	_instance = null
	if (keepaliveTimer) {
		clearTimeout(keepaliveTimer)
		keepaliveTimer = null
	}
	if (socket) {
		socket.disconnect()
		socket = null
		log.info('Socket disconnected')
	}
}

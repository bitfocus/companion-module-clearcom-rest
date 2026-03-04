import io, { Socket } from 'socket.io-client'
import { InstanceStatus } from '@companion-module/base'
import ModuleInstance from './main.js'
import { DeviceRecord, DeviceInfo, EndpointUpdatedEvent } from './types.js'

// ─── Log helper ───────────────────────────────────────────────────────────────

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

function rlog(instance: ModuleInstance, level: LogLevel, msg: string): void {
	const cfg = instance.config.logLevel ?? 'info'
	if (cfg === 'none') return
	if (cfg === 'info' && level === 'debug') return
	instance.log(level, msg)
}

// ─── Request queue ────────────────────────────────────────────────────────────
// All HTTP requests are serialised — the Arcadia rejects concurrent writes.

let requestQueue: Promise<unknown> = Promise.resolve()

async function enqueue<T>(fn: () => Promise<T>): Promise<T> {
	const next = requestQueue.then(async () => fn())
	requestQueue = next.catch(() => {
		// keep queue running on error
	})
	return next
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function buildHeaders(instance: ModuleInstance): Record<string, string> {
	const headers: Record<string, string> = { Accept: 'application/json' }
	if (instance.bearerToken) headers['Authorization'] = `Bearer ${instance.bearerToken}`
	return headers
}

export async function getRequest<R>(url: string, instance: ModuleInstance): Promise<R> {
	return enqueue(async () => {
		rlog(instance, 'info', `→ GET ${url.replace(/.*\/api/, '/api')}`)
		rlog(instance, 'debug', `→ GET ${url}`)
		const response = await fetch(url, { method: 'GET', headers: buildHeaders(instance) })
		if (response.status === 401) {
			void reLogin(instance)
			throw new Error(`GET ${url} failed: 401 Unauthorized`)
		}
		if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
		resetKeepalive(instance)
		const result = (await response.json()) as R
		rlog(instance, 'debug', `← GET ${url.replace(/.*\/api/, '/api')} ${JSON.stringify(result)}`)
		return result
	})
}

export async function postRequest<R>(url: string, instance: ModuleInstance, body: unknown = {}): Promise<R> {
	return enqueue(async () => {
		rlog(instance, 'info', `→ POST ${url.replace(/.*\/api/, '/api')}`)
		rlog(instance, 'debug', `→ POST ${url.replace(/.*\/api/, '/api')} ${JSON.stringify(body)}`)
		const response = await fetch(url, {
			method: 'POST',
			headers: { ...buildHeaders(instance), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		if (response.status === 401) {
			void reLogin(instance)
			throw new Error(`POST ${url} failed: 401 Unauthorized`)
		}
		if (!response.ok) throw new Error(`POST ${url} failed: ${response.status} ${response.statusText}`)
		resetKeepalive(instance)
		const result = (await response.json()) as R
		rlog(instance, 'debug', `← POST ${url.replace(/.*\/api/, '/api')} ${JSON.stringify(result)}`)
		return result
	})
}

export async function putRequest<R>(url: string, instance: ModuleInstance, body: unknown = {}): Promise<R> {
	return enqueue(async () => {
		rlog(instance, 'info', `→ PUT ${url.replace(/.*\/api/, '/api')}`)
		rlog(instance, 'debug', `→ PUT ${url.replace(/.*\/api/, '/api')} ${JSON.stringify(body)}`)
		const response = await fetch(url, {
			method: 'PUT',
			headers: { ...buildHeaders(instance), 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
		if (response.status === 401) {
			void reLogin(instance)
			throw new Error(`PUT ${url} failed: 401 Unauthorized`)
		}
		if (!response.ok) throw new Error(`PUT ${url} failed: ${response.status} ${response.statusText}`)
		resetKeepalive(instance)
		const result = (await response.json()) as R
		rlog(instance, 'debug', `← PUT ${url.replace(/.*\/api/, '/api')} ${JSON.stringify(result)}`)
		return result
	})
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

function getTokenVersion(token: string): number {
	try {
		const payload = token.split('.')[1]
		const decoded = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as { ver?: number }
		return decoded.ver ?? 1
	} catch {
		return 1
	}
}

async function refreshToken(instance: ModuleInstance): Promise<void> {
	try {
		const response = await postRequest<{ jwt: string }>(`http://${instance.config.host}/auth/refresh`, instance, {
			jwtversion: getTokenVersion(instance.bearerToken),
		})
		instance.bearerToken = response.jwt
		rlog(instance, 'debug', 'Token refreshed')
		resetKeepalive(instance)
	} catch {
		// Refresh failed — device may have rebooted. Re-login with credentials.
		rlog(instance, 'warn', 'Token refresh failed — attempting full re-login')
		void reLogin(instance)
	}
}

let relogging = false

async function reLogin(instance: ModuleInstance): Promise<void> {
	if (relogging) return
	relogging = true
	try {
		const response = await postRequest<{ jwt: string }>(`http://${instance.config.host}/auth/local/login`, instance, {
			logemail: 'admin',
			logpassword: instance.config.password,
		})
		instance.bearerToken = response.jwt
		rlog(instance, 'info', 'Re-login successful — reconnecting socket')
		disconnectSocket(instance)
		connectSocket(instance)
		void initialFetch(instance)
	} catch (error) {
		rlog(instance, 'warn', `Re-login failed: ${String(error)} — retrying in 30s`)
		resetKeepalive(instance)
	} finally {
		relogging = false
	}
}

// ─── Fetch functions ──────────────────────────────────────────────────────────
// Each fetch populates its store with DeviceRecord entries.
// After updating, feedback checks are triggered where applicable.

export async function fetchDevice(instance: ModuleInstance): Promise<void> {
	try {
		const response = await getRequest<DeviceInfo>(`http://${instance.config.host}/api/1/devices/1`, instance)
		instance.deviceInfo = response
		instance.updateVariables()
		rlog(
			instance,
			'info',
			`Device: ${response.deviceType_name} "${response.device_label}" fw=${response.device_versionSW ?? response.versionSW ?? '?'}`,
		)
	} catch (error) {
		rlog(instance, 'error', `fetchDevice failed: ${String(error)}`)
	}
}

export async function fetchPorts(instance: ModuleInstance): Promise<void> {
	try {
		const response = await getRequest<DeviceRecord[]>(
			`http://${instance.config.host}/api/1/devices/interfaces/ports`,
			instance,
		)
		instance.ports.clear()
		for (const port of response) {
			instance.ports.set(port['port_id'] as number, port)
		}
		rlog(
			instance,
			'info',
			`Ports loaded: ${[...instance.ports.values()].map((p) => `${p['port_id'] as string}:${p['port_label'] as string}(${(p['port_config_type'] as string | undefined) ?? '?'})`).join(', ')}`,
		)
		instance.triggerFeedbacksForStore('ports')
	} catch (error) {
		rlog(instance, 'error', `fetchPorts failed: ${String(error)}`)
	}
}

export async function fetchPortsGids(instance: ModuleInstance, gids: string[]): Promise<void> {
	if (gids.length === 0) return
	try {
		const response = await getRequest<DeviceRecord[]>(
			`http://${instance.config.host}/api/1/devices/interfaces/ports?gids=${gids.join(',')}`,
			instance,
		)
		for (const port of response) {
			instance.ports.set(port['port_id'] as number, port)
		}
		instance.triggerFeedbacksForStore('ports')
	} catch (error) {
		rlog(instance, 'error', `fetchPortsGids failed: ${String(error)}`)
	}
}

export async function fetchEndpoints(instance: ModuleInstance): Promise<void> {
	try {
		const response = await getRequest<DeviceRecord[]>(
			`http://${instance.config.host}/api/1/devices/endpoints`,
			instance,
		)
		instance.endpoints.clear()
		instance.gateways.clear()
		for (const ep of response) {
			const id = ep['id'] as number
			if (ep['isGateway']) {
				instance.gateways.set(id, ep)
			} else {
				instance.endpoints.set(id, ep)
				const live = ep['liveStatus'] as DeviceRecord | undefined
				if (live && Object.keys(live).length > 0) {
					instance.endpointStatus.set(id, live)
				}
			}
		}
		instance.triggerFeedbacksForStore('endpoints')
		instance.triggerFeedbacksForStore('endpointStatus')
	} catch (error) {
		rlog(instance, 'error', `fetchEndpoints failed: ${String(error)}`)
	}
}

export async function fetchEndpointsGids(instance: ModuleInstance, gids: string[]): Promise<void> {
	if (gids.length === 0) return
	try {
		const response = await getRequest<DeviceRecord[]>(
			`http://${instance.config.host}/api/1/devices/endpoints?gids=${gids.join(',')}`,
			instance,
		)
		for (const ep of response) {
			const id = ep['id'] as number
			if (ep['isGateway']) {
				instance.gateways.set(id, ep)
			} else {
				instance.endpoints.set(id, ep)
				const live = ep['liveStatus'] as DeviceRecord | undefined
				if (live && Object.keys(live).length > 0) {
					instance.endpointStatus.set(id, live)
				}
			}
		}
		instance.triggerFeedbacksForStore('endpoints')
		instance.triggerFeedbacksForStore('endpointStatus')
	} catch (error) {
		rlog(instance, 'error', `fetchEndpointsGids failed: ${String(error)}`)
	}
}

export async function fetchRolesets(instance: ModuleInstance): Promise<void> {
	try {
		const response = await getRequest<DeviceRecord[]>(`http://${instance.config.host}/api/2/rolesets`, instance)
		instance.rolesets.clear()
		for (const rs of response) {
			instance.rolesets.set(rs['id'] as number, rs)
		}
		rlog(
			instance,
			'info',
			`Rolesets loaded: ${[...instance.rolesets.values()].map((r) => `${r['id']}:${r['name']}`).join(', ')}`,
		)
		instance.triggerFeedbacksForStore('rolesets')
	} catch (error) {
		rlog(instance, 'error', `fetchRolesets failed: ${String(error)}`)
	}
}

export async function fetchRolesetsGids(instance: ModuleInstance, gids: string[]): Promise<void> {
	if (gids.length === 0) return
	try {
		const response = await getRequest<DeviceRecord[]>(
			`http://${instance.config.host}/api/2/rolesets?gids=${gids.join(',')}`,
			instance,
		)
		for (const rs of response) {
			instance.rolesets.set(rs['id'] as number, rs)
		}
		instance.triggerFeedbacksForStore('rolesets')
	} catch (error) {
		rlog(instance, 'error', `fetchRolesetsGids failed: ${String(error)}`)
	}
}

export async function fetchKeysets(instance: ModuleInstance): Promise<void> {
	try {
		const response = await getRequest<DeviceRecord[]>(`http://${instance.config.host}/api/2/keysets`, instance)
		instance.keysets.clear()
		for (const ks of response) {
			instance.keysets.set(ks['id'] as number, ks)
		}
		rlog(instance, 'info', `Keysets loaded: ${[...instance.keysets.keys()].join(', ')}`)
		instance.triggerFeedbacksForStore('keysets')
	} catch (error) {
		rlog(instance, 'error', `fetchKeysets failed: ${String(error)}`)
	}
}

export async function fetchKeysetsGids(instance: ModuleInstance, gids: string[]): Promise<void> {
	if (gids.length === 0) return
	try {
		const response = await getRequest<DeviceRecord[]>(
			`http://${instance.config.host}/api/2/keysets?gids=${gids.join(',')}`,
			instance,
		)
		for (const ks of response) {
			instance.keysets.set(ks['id'] as number, ks)
		}
		instance.triggerFeedbacksForStore('keysets')
	} catch (error) {
		rlog(instance, 'error', `fetchKeysetsGids failed: ${String(error)}`)
	}
}

export async function fetchConnections(instance: ModuleInstance): Promise<void> {
	try {
		const response = await getRequest<DeviceRecord[]>(
			`http://${instance.config.host}/api/1/connections/liveStatus`,
			instance,
		)
		instance.connections.clear()
		for (const conn of response) {
			instance.connections.set(conn['id'] as number, conn)
		}
		rlog(
			instance,
			'info',
			`Connections loaded: ${[...instance.connections.values()].map((c) => `${c['id'] as string}:${c['label'] as string}`).join(', ')}`,
		)
		instance.triggerFeedbacksForStore('connections')
	} catch (error) {
		rlog(instance, 'error', `fetchConnections failed: ${String(error)}`)
	}
}

// ─── Endpoint live status handler ─────────────────────────────────────────────

function handleEndpointUpdated(instance: ModuleInstance, event: EndpointUpdatedEvent): void {
	const { endpointId } = event
	rlog(instance, 'debug', `EndpointUpdated ${endpointId} [${event.path}]`)

	const existing = instance.endpointStatus.get(endpointId) ?? {}

	if (event.path === 'liveStatus') {
		const value = event.value as DeviceRecord
		const isEmpty = Object.keys(value).length === 0
		const isOffline = !isEmpty && value['status'] !== 'online'

		if (isEmpty || isOffline) {
			const offlineRole = instance.rolesets.get(
				((existing['association'] as DeviceRecord | undefined)?.['dpId'] as number) ?? -1,
			)
			instance.endpointStatus.delete(endpointId)
			rlog(
				instance,
				'info',
				`Beltpack ${endpointId} role=${(offlineRole?.['name'] as string | undefined) ?? 'unknown'} offline`,
			)
		} else {
			const merged: DeviceRecord = { ...existing, ...value }
			instance.endpointStatus.set(endpointId, merged)
			const role = instance.rolesets.get((merged['association'] as DeviceRecord | undefined)?.['dpId'] as number)
			rlog(
				instance,
				'debug',
				`Beltpack ${endpointId}: status=${merged['status'] as string} role=${(role?.['name'] as string | undefined) ?? 'unknown'} ` +
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

async function initialFetch(instance: ModuleInstance): Promise<void> {
	try {
		await fetchDevice(instance)
		await fetchRolesets(instance)
		await fetchConnections(instance)
		await fetchPorts(instance)
		await fetchKeysets(instance)
		await fetchEndpoints(instance)
		instance.rebuildIfChanged()
		rlog(instance, 'info', 'Initial fetch complete')
	} catch (error) {
		rlog(instance, 'error', `Initial fetch failed: ${String(error)}`)
	}
}

// ─── Socket ───────────────────────────────────────────────────────────────────

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
	if (socket?.connected) return

	socket = io(`http://${instance.config.host}`, {
		transports: ['polling'],
		path: '/socket.io',
		extraHeaders: { Authorization: `Bearer ${instance.bearerToken}` },
	})

	socket.on('connect', () => {
		rlog(instance, 'info', 'Socket connected')
		instance.updateStatus(InstanceStatus.Ok)
		resetKeepalive(instance)
		void initialFetch(instance)
	})

	socket.on('disconnect', (reason: string) => {
		rlog(instance, 'warn', `Socket disconnected: ${reason}`)
		instance.updateStatus(InstanceStatus.Disconnected)
	})

	socket.on('connect_error', (err: Error) => {
		rlog(instance, 'error', `Socket connect error: ${err.message}`)
		instance.updateStatus(InstanceStatus.ConnectionFailure, err.message)
	})

	socket.on('DiscoveryInit', () => {
		rlog(instance, 'debug', 'DiscoveryInit — system ready')
	})

	socket.on('live:connections', (_data: unknown) => {
		rlog(instance, 'debug', 'live:connections — refreshing')
		void fetchConnections(instance)
	})

	socket.on('live:roles', (_data: unknown) => {
		rlog(instance, 'debug', 'live:roles — refreshing keysets')
		void fetchKeysets(instance)
		// Role associations may have changed — rebuild choices
		void fetchRolesets(instance).then(() => {
			instance.rebuildIfChanged()
		})
	})

	socket.on('live:rolesets', (data: unknown) => {
		const rolesets = (data as Record<string, unknown>)?.['rolesets'] as { gid: string }[] | undefined
		const gids = rolesets?.map((r) => r.gid) ?? []
		void fetchRolesetsGids(instance, gids)
	})

	socket.on('live:ports', (data: unknown) => {
		const gids = (data as Record<string, unknown>)?.['gids'] as string[] | undefined
		if (gids && gids.length > 0) {
			void fetchPortsGids(instance, gids)
		} else {
			rlog(instance, 'debug', 'live:ports — refreshing all')
			void fetchPorts(instance)
		}
	})

	socket.on('live:endpoints', (data: unknown) => {
		const gids = (data as Record<string, unknown>)?.['gids'] as string[] | undefined
		if (gids && gids.length > 0) {
			void fetchEndpointsGids(instance, gids)
		} else {
			void fetchEndpoints(instance)
		}
	})

	socket.on('live:devices', (_data: unknown) => {
		rlog(instance, 'debug', 'live:devices — refreshing device info')
		void fetchDevice(instance)
	})

	socket.on('init', (data: unknown) => {
		rlog(instance, 'debug', `init: ${JSON.stringify(data)}`)
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
			rlog(instance, 'info', `← Socket [${event}]`)
			rlog(instance, 'debug', `← Socket [${event}] ${JSON.stringify(args)}`)
		} else {
			rlog(instance, 'info', `← Socket [${event}] (unhandled)`)
			rlog(instance, 'debug', `← Socket [${event}] (unhandled) ${JSON.stringify(args)}`)
		}
		originalOnevent(packet)
	}
}

export function disconnectSocket(instance: ModuleInstance): void {
	if (keepaliveTimer) {
		clearTimeout(keepaliveTimer)
		keepaliveTimer = null
	}
	if (socket) {
		socket.disconnect()
		socket = null
		rlog(instance, 'info', 'Socket disconnected')
	}
}

import io, { Socket } from 'socket.io-client'
import { InstanceStatus } from '@companion-module/base'
import ModuleInstance from './main.js'
import { BeltpackLiveStatus, BeltpackEndpoint, Roleset, EndpointUpdatedEvent, Keyset } from './types.js'

// ─── HTTP ─────────────────────────────────────────────────────────────────────

export async function getRequest<R>(url: string, instance: ModuleInstance): Promise<R> {
	const headers: Record<string, string> = {
		Accept: 'application/json',
	}
	if (instance.bearerToken) headers['Authorization'] = `Bearer ${instance.bearerToken}`
	const response = await fetch(url, { method: 'GET', headers })
	if (!response.ok) {
		throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`)
	}
	resetKeepalive(instance)
	return response.json() as Promise<R>
}

export async function postRequest<R>(url: string, instance: ModuleInstance, body: unknown = {}): Promise<R> {
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'Content-Type': 'application/json',
	}
	if (instance.bearerToken) headers['Authorization'] = `Bearer ${instance.bearerToken}`
	const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
	if (!response.ok) {
		throw new Error(`POST ${url} failed: ${response.status} ${response.statusText}`)
	}
	resetKeepalive(instance)
	return response.json() as Promise<R>
}

export async function putRequest<R>(url: string, instance: ModuleInstance, body: unknown = {}): Promise<R> {
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'Content-Type': 'application/json',
	}
	if (instance.bearerToken) headers['Authorization'] = `Bearer ${instance.bearerToken}`
	const response = await fetch(url, { method: 'PUT', headers, body: JSON.stringify(body) })
	if (!response.ok) {
		throw new Error(`PUT ${url} failed: ${response.status} ${response.statusText}`)
	}
	resetKeepalive(instance)
	return response.json() as Promise<R>
}

// ─── Keepalive ────────────────────────────────────────────────────────────────

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
		instance.log('debug', 'Token refreshed')
	} catch (error) {
		instance.log('warn', `Token refresh failed: ${String(error)}`)
		resetKeepalive(instance) // restart timer even on failure
	}
}

// ─── Socket ───────────────────────────────────────────────────────────────────

let socket: Socket | null = null

async function initialFetch(instance: ModuleInstance): Promise<void> {
	try {
		const [endpoints, rolesets] = await Promise.all([
			getRequest<BeltpackEndpoint[]>(`http://${instance.config.host}/api/1/devices/endpoints`, instance),
			getRequest<Roleset[]>(`http://${instance.config.host}/api/2/rolesets`, instance),
		])

		for (const rs of rolesets) {
			instance.rolesets.set(rs.id, rs)
			instance.log('debug', `Roleset ${rs.id}: ${JSON.stringify(rs, null, 2)}`)
		}
		instance.updateActions()
		await fetchKeysets(instance)

		for (const ep of endpoints) {
			if (ep.type === 'FSII-BP' && Object.keys(ep.liveStatus).length > 0) {
				const status = ep.liveStatus as BeltpackLiveStatus
				if (status.status === 'online') {
					instance.beltpackStatus.set(ep.id, { ...status, device_id: ep.device_id })
					const role = instance.rolesets.get(status.association?.dpId)
					instance.log('debug', `Initial load: beltpack ${ep.id} (${ep.label}) role=${role?.name ?? 'unknown'}`)
				}
			}
		}
	} catch (error) {
		instance.log('error', `Initial fetch failed: ${String(error)}`)
	}
}

function handleEndpointUpdated(instance: ModuleInstance, event: EndpointUpdatedEvent): void {
	const { endpointId } = event
	instance.log('debug', `EndpointUpdated ${endpointId} [${event.path}]: ${JSON.stringify(event.value, null, 2)}`)

	if (event.path === 'liveStatus') {
		const isEmpty = Object.keys(event.value).length === 0
		const isOffline = !isEmpty && (event.value as BeltpackLiveStatus).status !== 'online'

		if (isEmpty || isOffline) {
			const offlineRole = instance.rolesets.get(instance.beltpackStatus.get(endpointId)?.association?.dpId ?? -1)
			instance.beltpackStatus.delete(endpointId)
			instance.log('info', `Beltpack ${endpointId} role=${offlineRole?.name ?? 'unknown'} offline`)
		} else {
			const incoming = event.value as BeltpackLiveStatus
			const existing = instance.beltpackStatus.get(endpointId)
			const merged: BeltpackLiveStatus = existing ? { ...existing, ...incoming } : incoming
			instance.beltpackStatus.set(endpointId, merged)
			const role = instance.rolesets.get(merged.association?.dpId)
			instance.log(
				'debug',
				`Beltpack ${endpointId}: status=${merged.status} role=${role?.name ?? 'unknown'} ` +
					`battery=${merged.batteryLevel}% rssi=${merged.rssi} linkQuality=${merged.linkQuality} ` +
					`remaining=${merged.longevity.hours}h${merged.longevity.minutes}m`,
			)
		}
		return
	}

	if (event.path === 'liveStatus.keyState') {
		const existing = instance.beltpackStatus.get(endpointId)
		if (existing) {
			instance.beltpackStatus.set(endpointId, { ...existing, keyState: event.value })
		}
		return
	}
}

export async function fetchKeysets(instance: ModuleInstance): Promise<void> {
	try {
		const response = await getRequest<Keyset[]>(`http://${instance.config.host}/api/2/keysets`, instance)
		instance.keysets.clear()
		for (const keyset of response) {
			instance.keysets.set(keyset.id, keyset)
		}
		instance.log('debug', `Keysets loaded: ${[...instance.keysets.keys()].join(', ')}`)
	} catch (error) {
		instance.log('error', `fetchKeysets failed: ${String(error)}`)
	}
}

export function connectArcadiaSocket(instance: ModuleInstance): void {
	if (socket?.connected) return

	socket = io(`http://${instance.config.host}`, {
		transports: ['polling'],
		path: '/socket.io',
		extraHeaders: {
			Authorization: `Bearer ${instance.bearerToken}`,
		},
	})

	socket.on('connect', () => {
		instance.log('info', 'Socket.IO connected to Arcadia')
		instance.updateStatus(InstanceStatus.Ok)
		resetKeepalive(instance)
		void initialFetch(instance)
	})

	socket.on('disconnect', (reason: string) => {
		instance.log('warn', `Socket.IO disconnected: ${reason}`)
		instance.updateStatus(InstanceStatus.Disconnected)
	})

	socket.on('DiscoveryInit', () => {
		instance.log('info', 'Arcadia DiscoveryInit — system ready')
	})

	socket.on('live:connections', (_data: { updated: boolean }) => {
		instance.log('info', 'live:connections — refreshing live status')
		void getLiveConnections(instance)
	})

	socket.on('live:roles', (_data: { updated: boolean }) => {
		instance.log('debug', 'live:roles — refreshing keysets')
		void fetchKeysets(instance)
	})

	socket.on('live:devices', (_data: { updated: boolean }) => {
		instance.log('debug', 'live:devices received')
	})

	socket.on('init', (data: unknown) => {
		instance.log('debug', `init received: ${JSON.stringify(data, null, 2)}`)
	})

	socket.on('EndpointUpdated', (events: EndpointUpdatedEvent[]) => {
		for (const event of events) {
			handleEndpointUpdated(instance, event)
		}
	})

	socket.on('connect_error', (err: Error) => {
		instance.log('error', `Socket.IO connect error: ${err.message}`)
		instance.updateStatus(InstanceStatus.ConnectionFailure, err.message)
	})

	const handledEvents = new Set([
		'connect',
		'disconnect',
		'connect_error',
		'DiscoveryInit',
		'live:connections',
		'live:roles',
		'live:devices',
		'init',
		'EndpointUpdated',
	])
	const originalOnevent = (socket as unknown as { onevent: (packet: { data: unknown[] }) => void }).onevent.bind(socket)
	;(socket as unknown as { onevent: (packet: { data: unknown[] }) => void }).onevent = (packet) => {
		const [event, ...args] = packet.data
		if (!handledEvents.has(event as string)) {
			instance.log('debug', `Unhandled Socket.IO event [${event}]: ${JSON.stringify(args, null, 2)}`)
		}
		originalOnevent(packet)
	}
}

export function disconnectArcadiaSocket(instance: ModuleInstance): void {
	if (keepaliveTimer) {
		clearTimeout(keepaliveTimer)
		keepaliveTimer = null
	}
	if (socket) {
		socket.disconnect()
		socket = null
		instance.log('info', 'Socket.IO disconnected')
	}
}

async function getLiveConnections(instance: ModuleInstance): Promise<void> {
	try {
		await getRequest<BeltpackEndpoint[]>(`http://${instance.config.host}/api/1/connections/liveStatus`, instance)
	} catch (error) {
		instance.log('error', `Failed to get live status: ${String(error)}`)
	}
}

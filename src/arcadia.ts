import ModuleInstance from './main.js'
import {
	getRequest,
	postRequest,
	putRequest,
	fetchPorts,
	fetchPortsGids,
	fetchEndpoints,
	fetchEndpointsGids,
	fetchRolesets,
	fetchRolesetsGids,
	fetchKeysets,
	fetchKeysetsGids,
} from './network.js'
import { ControlDef, DeviceRecord } from './types.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Resolve a dot-notation field path into a nested DeviceRecord
export function getField(record: DeviceRecord, field: string): unknown {
	const parts = field.split('.')
	let current: unknown = record
	for (const part of parts) {
		if (current == null || typeof current !== 'object') return undefined
		current = (current as DeviceRecord)[part]
	}
	return current
}

// Get the roleset currently assigned to an endpoint (via liveStatus.association.dpId)
export function getRoleFromEndpoint(instance: ModuleInstance, endpointId: number): DeviceRecord | null {
	const status = instance.endpointStatus.get(endpointId)
	if (!status) return null
	const association = status['association'] as DeviceRecord | undefined
	const dpId = association?.['dpId'] as number | undefined
	if (dpId === undefined) return null
	return instance.rolesets.get(dpId) ?? null
}

// Get all endpoints currently assigned to a roleset
export function getEndpointsFromRole(instance: ModuleInstance, roleId: number): DeviceRecord[] {
	return [...instance.endpointStatus.entries()]
		.filter(([_, status]) => {
			const association = status['association'] as DeviceRecord | undefined
			return (association?.['dpId'] as number | undefined) === roleId
		})
		.map(([id]) => instance.endpoints.get(id) ?? instance.gateways.get(id))
		.filter((ep): ep is DeviceRecord => ep !== undefined)
}

// Build a choice label for an endpoint: "Label (ID)" or "Label (ID) - RoleName"
export function endpointChoiceLabel(instance: ModuleInstance, ep: DeviceRecord): string {
	const id = ep['id'] as number
	const label = ep['label'] as string
	const role = getRoleFromEndpoint(instance, id)
	const roleName = role ? ` - ${(role['label'] as string | undefined) ?? (role['name'] as string)}` : ''
	return `${label} (${id})${roleName}`
}

// Build role choices: "Name (ID)"
export function roleChoices(instance: ModuleInstance): { id: string; label: string }[] {
	return [...instance.rolesets.values()].map((rs) => ({
		id: String(rs['id'] as number),
		label: `${rs['name'] as string} (${rs['id'] as number})`,
	}))
}

// Build endpoint choices: "Label (ID)" or "Label (ID) - RoleName"
export function endpointChoices(instance: ModuleInstance): { id: string; label: string }[] {
	return [...instance.endpoints.values()].map((ep) => ({
		id: String(ep['id'] as number),
		label: endpointChoiceLabel(instance, ep),
	}))
}

// Build port choices: "Label (Desc)" e.g. "Andy (2W Port A)"
export function portChoices(instance: ModuleInstance): { id: string; label: string }[] {
	return [...instance.ports.values()].map((p) => ({
		id: String(p['port_id'] as number),
		label: p['port_desc'] ? `${p['port_label'] as string} (${p['port_desc'] as string})` : String(p['port_label']),
	}))
}

// ─── Generic field write (walks ControlDef) ───────────────────────────────────

export async function executeWrite(
	instance: ModuleInstance,
	def: ControlDef,
	recordId: number,
	value: unknown,
	mode: 'absolute' | 'increment' | 'decrement' = 'absolute',
): Promise<void> {
	if (!def.write) return

	const store = instance[def.read?.store ?? 'ports']
	const record = store.get(recordId)
	if (!record) {
		instance.log('warn', `executeWrite: no record ${recordId} in ${def.read?.store}`)
		return
	}

	let resolvedValue = value

	if (mode !== 'absolute' && def.supportsIncDec && def.read) {
		// Determine effective value type — check perTypeOverride first
		const portType = record['port_config_type'] as string | undefined
		const vt = (portType ? def.perTypeOverride?.[portType] : undefined) ?? def.valueType

		const currentValue = getField(record, def.read.field)

		if (vt.kind === 'integer') {
			const cur = (currentValue as number) ?? 0
			const next = mode === 'increment' ? cur + vt.step : cur - vt.step
			resolvedValue = Math.min(vt.max, Math.max(vt.min, next))
		} else if (vt.kind === 'number-enum') {
			const idx = vt.values.indexOf(currentValue as number)
			const next = mode === 'increment' ? idx + 1 : idx - 1
			resolvedValue = vt.values[Math.min(vt.values.length - 1, Math.max(0, next))]
		}
	}

	const res = record['res'] as string
	const url = `http://${instance.config.host}${def.write.pathTemplate.replace('{res}', res)}`

	// Endpoint PUT requires gid as a required field — only inject for endpoint scope
	const gid = def.scope === 'endpoint' ? (record['gid'] as string | undefined) : undefined
	const body = gid ? { gid, [def.write.bodyKey]: resolvedValue } : { [def.write.bodyKey]: resolvedValue }

	try {
		await putRequest(url, instance, body)
		instance.log('info', `executeWrite ${def.id} record=${recordId} value=${JSON.stringify(resolvedValue)}`)
		// Refresh the store after write
		await callFetch(instance, def.write.fetchFn, record['gid'] as string | undefined)
	} catch (error) {
		instance.log('error', `executeWrite ${def.id} record=${recordId} failed: ${String(error)}`)
	}
}

async function callFetch(instance: ModuleInstance, fetchFn: string, gid?: string): Promise<void> {
	switch (fetchFn) {
		case 'fetchPorts':
			return gid ? fetchPortsGids(instance, [gid]) : fetchPorts(instance)
		case 'fetchEndpoints':
			return gid ? fetchEndpointsGids(instance, [gid]) : fetchEndpoints(instance)
		case 'fetchRolesets':
			return gid ? fetchRolesetsGids(instance, [gid]) : fetchRolesets(instance)
		case 'fetchKeysets':
			return gid ? fetchKeysetsGids(instance, [gid]) : fetchKeysets(instance)
		default:
			return Promise.resolve()
	}
}

// ─── Keyset write (bulk PUT to /api/2/keysets) ────────────────────────────────

export async function setKeyset(
	instance: ModuleInstance,
	roleIds: number[],
	def: ControlDef,
	value: unknown,
	mode: 'absolute' | 'increment' | 'decrement' = 'absolute',
): Promise<void> {
	const url = `http://${instance.config.host}/api/2/keysets`
	const body: Record<string, unknown> = {}

	for (const roleId of roleIds) {
		const roleset = instance.rolesets.get(roleId)
		if (!roleset) {
			instance.log('warn', `setKeyset: no roleset for role ${roleId}`)
			continue
		}
		const sessions = roleset['sessions'] as DeviceRecord | undefined
		const firstSession = sessions ? (Object.values(sessions)[0] as DeviceRecord | undefined) : undefined
		const keysetId = (firstSession?.['data'] as DeviceRecord | undefined)?.['settings'] as DeviceRecord | undefined
		const defaultRoleId = keysetId?.['defaultRole'] as number | undefined
		if (defaultRoleId === undefined) {
			instance.log('warn', `setKeyset: no defaultRole for role ${roleId}`)
			continue
		}

		const keyset = instance.keysets.get(defaultRoleId)
		if (!keyset) {
			instance.log('warn', `setKeyset: no cached keyset ${defaultRoleId}`)
			continue
		}

		let resolvedValue = value
		if (mode !== 'absolute' && def.supportsIncDec && def.read) {
			const currentValue = getField(keyset, def.read.field)
			const vt = def.valueType
			if (vt.kind === 'integer') {
				const cur = (currentValue as number) ?? 0
				const next = mode === 'increment' ? cur + vt.step : cur - vt.step
				resolvedValue = Math.min(vt.max, Math.max(vt.min, next))
			} else if (vt.kind === 'number-enum') {
				const idx = vt.values.indexOf(currentValue as number)
				const next = mode === 'increment' ? idx + 1 : idx - 1
				resolvedValue = vt.values[Math.min(vt.values.length - 1, Math.max(0, next))]
			}
		}

		const isTopLevel = def.write!.keysetBodyLevel === 'top'
		body[String(defaultRoleId)] = isTopLevel
			? { type: keyset['type'], [def.write!.bodyKey]: resolvedValue }
			: { type: keyset['type'], settings: { [def.write!.bodyKey]: resolvedValue } }
	}

	if (Object.keys(body).length === 0) return

	try {
		await putRequest(url, instance, body)
		instance.log('info', `setKeyset ${def.id}: ok`)
		await fetchKeysets(instance)
	} catch (error) {
		instance.log('error', `setKeyset ${def.id} failed: ${String(error)}`)
	}
}

// ─── Key assignment ───────────────────────────────────────────────────────────

type KeyEntity = { res: string; gid?: string; type: number }

function resolveKeyEntity(instance: ModuleInstance, assignTo: string): KeyEntity[] {
	if (!assignTo) return []
	const [kind, idStr] = assignTo.split(':')
	const id = Number(idStr)
	if (kind === 'conn') {
		const conn = instance.connections.get(id)
		const res = (conn?.['res'] as string | undefined) ?? `/api/1/connections/${id}`
		return [{ res, type: 0 }]
	}
	if (kind === 'role') {
		return instance.rolesets.has(id) ? [{ res: `/api/2/rolesets/${id}`, type: 3 }] : []
	}
	if (kind === 'port') {
		const port = instance.ports.get(id)
		return port ? [{ res: port['res'] as string, type: 1 }] : []
	}
	if (kind === 'special' && idStr === 'call') {
		return [{ res: '/api/1/special/call', type: 1 }]
	}
	return []
}

export async function assignKeyChannel(
	instance: ModuleInstance,
	roleIds: number[],
	keyIndex: number,
	assignTo: string, // 'conn:{id}' | 'role:{id}' | 'port:{id}' | 'special:call' | ''
	activationState: string,
	talkBtnMode: string,
): Promise<void> {
	const url = `http://${instance.config.host}/api/2/keysets`
	const body: Record<string, unknown> = {}

	for (const roleId of roleIds) {
		const roleset = instance.rolesets.get(roleId)
		if (!roleset) continue
		const sessions = roleset['sessions'] as DeviceRecord | undefined
		const firstSession = sessions ? (Object.values(sessions)[0] as DeviceRecord | undefined) : undefined
		const settingsObj = (firstSession?.['data'] as DeviceRecord | undefined)?.['settings'] as DeviceRecord | undefined
		const defaultRoleId = settingsObj?.['defaultRole'] as number | undefined
		if (defaultRoleId === undefined) continue

		const keyset = instance.keysets.get(defaultRoleId)
		if (!keyset) continue

		const currentSlots = ((keyset['settings'] as DeviceRecord)?.['keysets'] as DeviceRecord[] | undefined) ?? []
		const updatedSlots = currentSlots.map((slot) => {
			if ((slot['keysetIndex'] as number) !== keyIndex) return slot
			return {
				...slot,
				entities: resolveKeyEntity(instance, assignTo),
				activationState,
				isCallKey: assignTo === 'special:call',
				talkBtnMode,
			}
		})

		body[String(defaultRoleId)] = { type: keyset['type'], settings: { keysets: updatedSlots } }
	}

	if (Object.keys(body).length === 0) return

	try {
		await putRequest(url, instance, body)
		instance.log('info', `assignKeyChannel key=${keyIndex}: ok`)
		await fetchKeysets(instance)
	} catch (error) {
		instance.log('error', `assignKeyChannel key=${keyIndex} failed: ${String(error)}`)
	}
}

// ─── RMK ─────────────────────────────────────────────────────────────────────

export async function remoteMicKill(instance: ModuleInstance, roleId: string): Promise<void> {
	let endpointId: number | null = null

	if (roleId) {
		endpointId =
			[...instance.endpointStatus.keys()].find((id) => {
				const status = instance.endpointStatus.get(id)
				const association = status?.['association'] as DeviceRecord | undefined
				return (association?.['dpId'] as number | undefined) === Number(roleId)
			}) ?? null
		if (endpointId === null) {
			instance.log('warn', `RMK: no online beltpack for role ${roleId}`)
			return
		}
	}

	const epSegment = endpointId !== null ? `/${endpointId}` : ''
	const url = `http://${instance.config.host}/api/1/devices/1/endpoints${epSegment}/rmk`
	try {
		const response = await postRequest<{ ok: boolean }>(url, instance)
		instance.log('info', `RMK sent (role=${roleId || 'all'}): ${JSON.stringify(response)}`)
	} catch (error) {
		instance.log('error', `RMK failed (role=${roleId || 'all'}): ${String(error)}`)
	}
}

// ─── Call ─────────────────────────────────────────────────────────────────────

export async function sendCall(instance: ModuleInstance, roleId: string, active: boolean, text: string): Promise<void> {
	let endpointId: number | null = null
	let gid: string | null = null

	if (roleId) {
		const epId =
			[...instance.endpointStatus.keys()].find((id) => {
				const status = instance.endpointStatus.get(id)
				const association = status?.['association'] as DeviceRecord | undefined
				return (association?.['dpId'] as number | undefined) === Number(roleId)
			}) ?? null
		if (epId === null) {
			instance.log('warn', `Call: no online beltpack for role ${roleId}`)
			return
		}
		endpointId = epId
		gid = (instance.endpointStatus.get(epId)?.['gid'] as string) ?? null
	}

	const epSegment = endpointId !== null ? `/${endpointId}` : ''
	const url = `http://${instance.config.host}/api/1/devices/1/endpoints${epSegment}/call`
	const body: Record<string, unknown> = { active, text }
	if (gid) body['gid'] = gid

	try {
		const response = await postRequest<{ ok: boolean }>(url, instance, body)
		instance.log('info', `Call (role=${roleId || 'all'} active=${active}): ${JSON.stringify(response)}`)
	} catch (error) {
		instance.log('error', `Call failed (role=${roleId || 'all'}): ${String(error)}`)
	}
}

// ─── Nulling ──────────────────────────────────────────────────────────────────

export async function startNulling(instance: ModuleInstance, portIds: number[]): Promise<void> {
	for (const portId of portIds) {
		const port = instance.ports.get(portId)
		if (!port) continue
		const url = `http://${instance.config.host}${port['res'] as string}/nulling`
		try {
			const result = await postRequest<{ ok: boolean; nulling: string }>(url, instance, {})
			instance.nullingStatus.set(portId, result.nulling)
			instance.log('info', `startNulling port=${portId}: ${result.nulling}`)
			void pollNulling(instance, portId, url)
		} catch (error) {
			instance.log('error', `startNulling port=${portId} failed: ${String(error)}`)
		}
	}
}

async function pollNulling(instance: ModuleInstance, portId: number, url: string): Promise<void> {
	let wasActive = false
	for (;;) {
		await new Promise<void>((r) => setTimeout(r, 1000))
		try {
			const result = await getRequest<{ ok: boolean; nulling: string }>(url, instance)
			instance.nullingStatus.set(portId, result.nulling)
			instance.log('info', `nulling port=${portId}: ${result.nulling}`)
			instance.triggerFeedbacksForStore('nulling')
			if (result.nulling !== 'Idle') wasActive = true
			if (wasActive && result.nulling === 'Idle') break
		} catch {
			break
		}
	}
}

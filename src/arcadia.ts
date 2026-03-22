import ModuleInstance from './main.js'
import { makeLogger } from './logger.js'

const log = makeLogger('arcadia', () => _instance?.config)
let _instance: ModuleInstance | null = null
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
import { DEVICE_TYPE_TO_KEYSET_TYPE } from './parseSchemas.js'

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

// Walk a roleset's sessions to find the keyset ID matching the given device type.
// Returns undefined if no matching keyset is found.
export function findKeysetIdForRole(instance: ModuleInstance, roleId: number, deviceType: string): number | undefined {
	const keysetTypes = DEVICE_TYPE_TO_KEYSET_TYPE[deviceType]
	if (!keysetTypes) {
		log.warn(`findKeysetIdForRole: no keyset types mapped for deviceType=${deviceType}`)
		return undefined
	}
	const roleset = instance.rolesets.get(roleId)
	if (!roleset) return undefined
	const sessions = roleset['sessions'] as DeviceRecord | undefined
	for (const session of Object.values(sessions ?? {}) as DeviceRecord[]) {
		const candidateId = ((session['data'] as DeviceRecord | undefined)?.['settings'] as DeviceRecord | undefined)?.[
			'defaultRole'
		] as number | undefined
		if (candidateId === undefined) continue
		const ksType = instance.keysets.get(candidateId)?.['type'] as string | undefined
		if (ksType && keysetTypes.includes(ksType)) return candidateId
	}
	return undefined
}

// Get the roleset currently assigned to an endpoint (via liveStatus.association.dpId)
export function getRoleFromEndpoint(instance: ModuleInstance, endpointId: number): DeviceRecord | null {
	_instance = instance
	const status = instance.endpointStatus.get(endpointId)
	if (!status) return null
	const association = status['association'] as DeviceRecord | undefined
	const dpId = association?.['dpId'] as number | undefined
	if (dpId === undefined) return null
	return instance.rolesets.get(dpId) ?? null
}

// Build a choice label for an endpoint: "Label (ID)" or "Label (ID) - RoleName"
export function endpointChoiceLabel(instance: ModuleInstance, ep: DeviceRecord): string {
	const id = ep['id'] as number
	const label = ep['label'] as string
	const role = getRoleFromEndpoint(instance, id)
	const roleName = role ? ` - ${role['label'] as string}` : ''
	return `${label} (${id})${roleName}`
}

// Build role choices: "Name (ID)"
export function roleChoices(instance: ModuleInstance): { id: string; label: string }[] {
	_instance = instance
	return [...instance.rolesets.values()].map((rs) => ({
		id: String(rs['id'] as number),
		label: `${rs['name'] as string} (${rs['id'] as number})`,
	}))
}

// Build endpoint choices: "Label (ID)" or "Label (ID) - RoleName"
export function endpointChoices(instance: ModuleInstance): { id: string; label: string }[] {
	_instance = instance
	return [...instance.endpoints.values()].map((ep) => ({
		id: String(ep['id'] as number),
		label: endpointChoiceLabel(instance, ep),
	}))
}

// Build port choices: "Label (Desc)" e.g. "Andy (2W Port A)"
export function portChoices(instance: ModuleInstance): { id: string; label: string }[] {
	_instance = instance
	return [...instance.ports.values()].map((p) => ({
		id: String(p['port_id'] as number),
		label: p['port_desc'] ? `${p['port_label'] as string} (${p['port_desc'] as string})` : String(p['port_label']),
	}))
}

// ─── Generic field write (walks ControlDef) ───────────────────────────────────

// Resolve a value for inc/dec mode given the current value and value type.
function resolveIncDec(
	current: unknown,
	vt: import('./types.js').SettingValueType,
	mode: 'increment' | 'decrement',
): unknown {
	if (vt.kind === 'integer') {
		const cur = (current as number) ?? 0
		const next = mode === 'increment' ? cur + vt.step : cur - vt.step
		return Math.min(vt.max, Math.max(vt.min, next))
	}
	if (vt.kind === 'number-enum') {
		const idx = vt.values.indexOf(current as number)
		const next = mode === 'increment' ? idx + 1 : idx - 1
		return vt.values[Math.min(vt.values.length - 1, Math.max(0, next))]
	}
	return current
}

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
		log.warn(`executeWrite: no record ${recordId} in ${def.read?.store}`)
		return
	}

	let resolvedValue = value

	if (mode !== 'absolute' && def.supportsIncDec && def.read) {
		const portType = record['port_config_type'] as string | undefined
		const vt = (portType ? def.perTypeOverride?.[portType] : undefined) ?? def.valueType
		resolvedValue = resolveIncDec(getField(record, def.read.field), vt, mode)
	}

	const res = record['res'] as string
	const url = `http://${instance.config.host}${def.write.pathTemplate.replace('{res}', res)}`

	// Endpoint PUT requires gid as a required field — only inject for endpoint scope
	const gid = def.scope === 'endpoint' ? (record['gid'] as string | undefined) : undefined
	const body = gid ? { gid, [def.write.bodyKey]: resolvedValue } : { [def.write.bodyKey]: resolvedValue }

	try {
		await putRequest(url, instance, body)
		log.info(`executeWrite ${def.id} record=${recordId} value=${JSON.stringify(resolvedValue)}`)
		await callFetch(instance, def.write.fetchFn, record['gid'] as string | undefined)
	} catch (error) {
		log.error(`executeWrite ${def.id} record=${recordId} failed: ${String(error)}`)
	}
}

async function callFetch(instance: ModuleInstance, fetchFn: string, gid?: string): Promise<void> {
	switch (fetchFn) {
		case 'fetchPorts':
			await (gid ? fetchPortsGids(instance, [gid]) : fetchPorts(instance))
			break
		case 'fetchEndpoints':
			await (gid ? fetchEndpointsGids(instance, [gid]) : fetchEndpoints(instance))
			break
		case 'fetchRolesets':
			await (gid ? fetchRolesetsGids(instance, [gid]) : fetchRolesets(instance))
			break
		case 'fetchKeysets':
			await (gid ? fetchKeysetsGids(instance, [gid]) : fetchKeysets(instance))
			break
	}
	instance.rebuildIfChanged()
}

// ─── Shared keyset write scaffolding ─────────────────────────────────────────

// Iterates roleIds, resolves each to a keyset, calls buildEntry to get the body
// entry, then PUTs the collected body to /api/2/keysets and refreshes the store.
async function putKeysets(
	instance: ModuleInstance,
	roleIds: number[],
	deviceType: string,
	logTag: string,
	buildEntry: (keyset: DeviceRecord, keysetId: number) => Record<string, unknown> | null,
): Promise<void> {
	const url = `http://${instance.config.host}/api/2/keysets`
	const body: Record<string, unknown> = {}

	for (const roleId of roleIds) {
		const keysetId = findKeysetIdForRole(instance, roleId, deviceType)
		if (keysetId === undefined) {
			log.warn(`${logTag}: no matching keyset for role ${roleId} deviceType=${deviceType}`)
			continue
		}
		const keyset = instance.keysets.get(keysetId)
		if (!keyset) {
			log.warn(`${logTag}: no cached keyset ${keysetId}`)
			continue
		}
		const entry = buildEntry(keyset, keysetId)
		if (entry) body[String(keysetId)] = entry
	}

	if (Object.keys(body).length === 0) return

	try {
		await putRequest(url, instance, body)
		log.info(`${logTag}: ok`)
		await fetchKeysets(instance)
		instance.rebuildIfChanged()
	} catch (error) {
		log.error(`${logTag} failed: ${String(error)}`)
	}
}

// Find the endpoint ID currently online for a given role ID.
// Returns null if no online beltpack is assigned to that role.
function findEndpointForRole(instance: ModuleInstance, roleId: number): number | null {
	return (
		[...instance.endpointStatus.keys()].find((id) => {
			const association = instance.endpointStatus.get(id)?.['association'] as DeviceRecord | undefined
			return (association?.['dpId'] as number | undefined) === roleId
		}) ?? null
	)
}

// ─── Keyset write (bulk PUT to /api/2/keysets) ────────────────────────────────

export async function setKeyset(
	instance: ModuleInstance,
	roleIds: number[],
	def: ControlDef,
	value: unknown,
	mode: 'absolute' | 'increment' | 'decrement' = 'absolute',
	deviceType?: string,
): Promise<void> {
	if (deviceType === undefined) {
		log.warn(`setKeyset ${def.id}: deviceType is undefined — refusing to write to avoid targeting wrong keyset`)
		return
	}
	if (!DEVICE_TYPE_TO_KEYSET_TYPE[deviceType]) {
		log.warn(`setKeyset ${def.id}: no keyset types mapped for deviceType=${deviceType}`)
		return
	}

	await putKeysets(instance, roleIds, deviceType, `setKeyset ${def.id}`, (keyset) => {
		let resolvedValue = value
		if (mode !== 'absolute' && def.supportsIncDec && def.read) {
			resolvedValue = resolveIncDec(getField(keyset, def.read.field), def.valueType, mode)
		}
		const isTopLevel = def.write!.keysetBodyLevel === 'top'
		return isTopLevel
			? { type: keyset['type'], [def.write!.bodyKey]: resolvedValue }
			: { type: keyset['type'], settings: { [def.write!.bodyKey]: resolvedValue } }
	})
}

// ─── Key assignment ───────────────────────────────────────────────────────────

type KeyEntity = { res: string; gid?: string; type: number }

function resolveKeyEntity(instance: ModuleInstance, assignTo: string): KeyEntity[] {
	if (!assignTo) return []
	const [kind, idStr] = assignTo.split(':')
	const id = Number(idStr)
	if (kind === 'conn') {
		const conn = instance.connections.get(id)
		if (!conn) return []
		return [{ res: conn['res'] as string, type: 0 }]
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
	assignTo: string,
	activationState: string,
	talkBtnMode: string,
	deviceType: string,
): Promise<void> {
	await putKeysets(instance, roleIds, deviceType, `assignKeyChannel key=${keyIndex}`, (keyset) => {
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
		return { type: keyset['type'], settings: { keysets: updatedSlots } }
	})
}

// ─── RMK ─────────────────────────────────────────────────────────────────────

export async function remoteMicKill(instance: ModuleInstance, roleId: string): Promise<void> {
	_instance = instance
	let endpointId: number | null = null

	if (roleId) {
		endpointId = findEndpointForRole(instance, Number(roleId))
		if (endpointId === null) {
			log.warn(`RMK: no online beltpack for role ${roleId}`)
			return
		}
	}

	const epSegment = endpointId !== null ? `/${endpointId}` : ''
	const url = `http://${instance.config.host}/api/1/devices/1/endpoints${epSegment}/rmk`
	try {
		const response = await postRequest<{ ok: boolean }>(url, instance)
		log.info(`RMK sent (role=${roleId || 'all'}): ${JSON.stringify(response)}`)
	} catch (error) {
		log.error(`RMK failed (role=${roleId || 'all'}): ${String(error)}`)
	}
}

// ─── Call ─────────────────────────────────────────────────────────────────────

export async function sendCall(instance: ModuleInstance, roleId: string, active: boolean, text: string): Promise<void> {
	_instance = instance
	let endpointId: number | null = null
	let gid: string | null = null

	if (roleId) {
		endpointId = findEndpointForRole(instance, Number(roleId))
		if (endpointId === null) {
			log.warn(`Call: no online beltpack for role ${roleId}`)
			return
		}
		gid = (instance.endpointStatus.get(endpointId)?.['gid'] as string) ?? null
	}

	const epSegment = endpointId !== null ? `/${endpointId}` : ''
	const url = `http://${instance.config.host}/api/1/devices/1/endpoints${epSegment}/call`
	const body: Record<string, unknown> = { active, text }
	if (gid) body['gid'] = gid

	try {
		const response = await postRequest<{ ok: boolean }>(url, instance, body)
		log.info(`Call (role=${roleId || 'all'} active=${active}): ${JSON.stringify(response)}`)
	} catch (error) {
		log.error(`Call failed (role=${roleId || 'all'}): ${String(error)}`)
	}
}

// ─── Nulling ──────────────────────────────────────────────────────────────────

export async function startNulling(instance: ModuleInstance, portIds: number[]): Promise<void> {
	_instance = instance
	for (const portId of portIds) {
		const port = instance.ports.get(portId)
		if (!port) continue
		const url = `http://${instance.config.host}${port['res'] as string}/nulling`
		try {
			const result = await postRequest<{ ok: boolean; nulling: string }>(url, instance, {})
			instance.nullingStatus.set(portId, result.nulling)
			log.info(`startNulling port=${portId}: ${result.nulling}`)
			void pollNulling(instance, portId, url)
		} catch (error) {
			log.error(`startNulling port=${portId} failed: ${String(error)}`)
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
			log.info(`nulling port=${portId}: ${result.nulling}`)
			instance.triggerFeedbacksForStore('nulling')
			if (result.nulling !== 'Idle') wasActive = true
			if (wasActive && result.nulling === 'Idle') break
		} catch {
			break
		}
	}
}

// ─── Endpoint association ─────────────────────────────────────────────────────

export async function changeEndpointAssociation(
	instance: ModuleInstance,
	endpointId: number,
	rolesetGid: string | null,
): Promise<void> {
	const ep = instance.endpoints.get(endpointId)
	if (!ep) return
	const url = `http://${instance.config.host}${ep['res'] as string}/changeassociation`
	await postRequest(url, instance, { gid: ep['gid'], association: { gid: rolesetGid } })
	const gid = ep['gid'] as string | undefined
	if (gid) {
		await fetchEndpointsGids(instance, [gid])
	} else {
		await fetchEndpoints(instance)
	}
	// Force rebuild regardless of fingerprint — association change in liveStatus
	// may not be reflected yet in endpointStatus at this point.
	instance.forceRebuild()
}

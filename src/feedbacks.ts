import {
	CompanionAdvancedFeedbackDefinition,
	CompanionFeedbackButtonStyleResult,
	JsonValue,
} from '@companion-module/base'
import ModuleInstance from './main.js'
import { getField, roleChoices, endpointChoices, portChoices } from './arcadia.js'
import { ControlDef, DeviceRecord } from './types.js'
import { drawMeter, MeterStyle } from './indicators.js'

// ─── Trigger helpers ──────────────────────────────────────────────────────────

function subscribe(instance: ModuleInstance, feedbackId: string, store: string): void {
	instance.feedbackTriggers.set(feedbackId, store as import('./types.js').FeedbackStore)
}

function unsubscribeFn(instance: ModuleInstance) {
	return (feedback: { feedbackId: string }): void => {
		instance.feedbackTriggers.delete(feedback.feedbackId)
	}
}

// ─── Navigate roleset → keyset ────────────────────────────────────────────────

function getKeysetForRole(instance: ModuleInstance, roleId: number): DeviceRecord | null {
	const roleset = instance.rolesets.get(roleId)
	if (!roleset) return null
	const sessions = roleset['sessions'] as DeviceRecord | undefined
	const first = sessions ? (Object.values(sessions)[0] as DeviceRecord | undefined) : undefined
	const settings = (first?.['data'] as DeviceRecord | undefined)?.['settings'] as DeviceRecord | undefined
	const keysetId = settings?.['defaultRole'] as number | undefined
	if (keysetId === undefined) return null
	return instance.keysets.get(keysetId) ?? null
}

// Get the endpointStatus for a role (via association.dpId)
function getStatusForRole(instance: ModuleInstance, roleId: number): DeviceRecord | null {
	for (const [, status] of instance.endpointStatus) {
		const assoc = status['association'] as DeviceRecord | undefined
		if ((assoc?.['dpId'] as number | undefined) === roleId) return status
	}
	return null
}

// ─── Schema-driven feedbacks ──────────────────────────────────────────────────

type FeedbackDef = Record<string, unknown>

function buildDefsFor(
	instance: ModuleInstance,
	def: ControlDef,
	rChoices: ReturnType<typeof roleChoices>,
	epChoices: ReturnType<typeof endpointChoices>,
	pChoices: ReturnType<typeof portChoices>,
): FeedbackDef | null {
	if (!def.read) return null

	const isPort = def.scope === 'port'
	const isEndpoint = def.scope === 'endpoint'
	const isKeyset = def.read.store === ('keysets' as string)
	const isLiveStatus = def.read.store === 'endpointStatus'
	const store = def.read.store

	const subjectOption = isPort
		? { type: 'dropdown', id: 'subjectId', label: 'Port', default: pChoices[0]?.id ?? '', choices: pChoices }
		: isEndpoint
			? { type: 'dropdown', id: 'subjectId', label: 'Endpoint', default: epChoices[0]?.id ?? '', choices: epChoices }
			: { type: 'dropdown', id: 'subjectId', label: 'Role', default: rChoices[0]?.id ?? '', choices: rChoices }

	const typePrefix = def.deviceTypes.length === 1 ? `[${def.deviceTypes[0]}] ` : ''
	const scopePrefix = isPort ? '[Port] ' : isEndpoint || isLiveStatus ? '[Beltpack] ' : '[Role] '
	const name = `${typePrefix}${scopePrefix}${def.label}`

	const getValue = (subjectId: number): unknown => {
		if (isPort) {
			const record = instance.ports.get(subjectId)
			return record ? getField(record, def.read!.field) : null
		}
		if (isLiveStatus) {
			const status = instance.endpointStatus.get(subjectId)
			return status ? getField(status, def.read!.field) : null
		}
		if (isKeyset) {
			const keyset = getKeysetForRole(instance, subjectId)
			return keyset ? getField(keyset, def.read!.field) : null
		}
		if (isEndpoint) {
			const record = instance.endpoints.get(subjectId)
			return record ? getField(record, def.read!.field) : null
		}
		// rolesets
		const record = instance.rolesets.get(subjectId)
		return record ? getField(record, def.read!.field) : null
	}

	if (def.valueType.kind === 'boolean') {
		return {
			type: 'boolean',
			name,
			description: def.description,
			defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 } satisfies Partial<CompanionFeedbackButtonStyleResult>,
			options: [subjectOption],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, store)
				const val = getValue(Number(feedback.options['subjectId']))
				// status field: 'online' string → boolean
				return val === true || val === 'online'
			},
		}
	}

	return {
		type: 'value',
		name,
		description: def.description,
		options: [subjectOption],
		unsubscribe: unsubscribeFn(instance),
		callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
			subscribe(instance, feedback.feedbackId, store)
			return (getValue(Number(feedback.options['subjectId'])) ?? null) as JsonValue
		},
	}
}

function buildDefsFeedbacks(instance: ModuleInstance): Record<string, FeedbackDef> {
	const feedbacks: Record<string, FeedbackDef> = {}
	const rChoices = roleChoices(instance)
	const epChoices = endpointChoices(instance)
	const pChoices = portChoices(instance)

	const selectedTypes = instance.config.endpointTypes ?? []

	for (const def of instance.controlDefs) {
		if (!def.read) continue
		if (def.deviceTypes.length > 0 && selectedTypes.length > 0) {
			if (!def.deviceTypes.some((dt) => selectedTypes.includes(dt))) continue
		}

		const fb = buildDefsFor(instance, def, rChoices, epChoices, pChoices)
		if (fb) feedbacks[def.id.replace(/\./g, '_')] = fb
	}

	return feedbacks
}

// ─── Manual feedbacks ─────────────────────────────────────────────────────────

function buildManualFeedbacks(instance: ModuleInstance): Record<string, FeedbackDef> {
	const rChoices = roleChoices(instance)
	const epChoices = endpointChoices(instance)

	const roleOption = {
		type: 'dropdown',
		id: 'roleId',
		label: 'Role',
		default: rChoices[0]?.id ?? '',
		choices: rChoices,
	}
	const epOption = {
		type: 'dropdown',
		id: 'endpointId',
		label: 'Beltpack',
		default: epChoices[0]?.id ?? '',
		choices: epChoices,
	}

	// Key count across all configured device types
	const selectedTypes = instance.config.endpointTypes ?? []
	const filteredCaps = Object.entries(instance.keyAssignCapabilities).filter(
		([dt]) => selectedTypes.length === 0 || selectedTypes.includes(dt),
	)
	const maxKeys = Math.max(1, ...filteredCaps.map(([, c]) => c.keyCount))
	const keyChoices = Array.from({ length: maxKeys }, (_, i) => ({ id: String(i), label: `Key ${i + 1}` }))
	const keyOption = { type: 'dropdown', id: 'keyIndex', label: 'Key', default: '0', choices: keyChoices }

	const getKeyState = (roleId: number, keyIndex: string) => {
		const status = getStatusForRole(instance, roleId)
		return (status?.['keyState'] as DeviceRecord | undefined)?.[keyIndex] as DeviceRecord | undefined
	}

	const getKeyAssign = (roleId: number, keyIndex: number): string | null => {
		const keyset = getKeysetForRole(instance, roleId)
		if (!keyset) return null
		const slots = ((keyset['settings'] as DeviceRecord | undefined)?.['keysets'] ?? []) as DeviceRecord[]
		const slot = slots.find((s) => (s['keysetIndex'] as number) === keyIndex)
		if (!slot) return null
		const entities = (slot['entities'] as DeviceRecord[] | undefined) ?? []
		const entity = entities[0]
		if (!entity) return '(empty)'
		const res = entity['res'] as string
		if (res === '/api/1/special/call') return 'Special: Call'
		const id = Number(res.split('/').pop())
		if (entity['type'] === 3) return (instance.rolesets.get(id)?.['name'] as string | undefined) ?? res
		if (entity['type'] === 0) return (instance.connections.get(id)?.['label'] as string | undefined) ?? res
		if (entity['type'] === 1) return (instance.ports.get(id)?.['port_label'] as string | undefined) ?? res
		return res
	}

	const feedbacks: Record<string, FeedbackDef> = {
		// ── Key state ────────────────────────────────────────────────────────
		key_state: {
			type: 'value',
			name: '[Key] State',
			options: [roleOption, keyOption],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpointStatus')
				const k = getKeyState(Number(feedback.options['roleId']), feedback.options['keyIndex'] as string)
				return (k?.['currentState'] ?? null) as JsonValue
			},
		},

		key_volume: {
			type: 'value',
			name: '[Key] Volume',
			options: [roleOption, keyOption],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpointStatus')
				const k = getKeyState(Number(feedback.options['roleId']), feedback.options['keyIndex'] as string)
				return (k?.['volume'] ?? null) as JsonValue
			},
		},

		key_assign: {
			type: 'value',
			name: '[Key] Assignment',
			options: [roleOption, keyOption],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'keysets')
				return getKeyAssign(Number(feedback.options['roleId']), Number(feedback.options['keyIndex']))
			},
		},

		// ── Beltpack assigned role ────────────────────────────────────────────
		beltpack_role: {
			type: 'value',
			name: '[Beltpack] Assigned Role',
			options: [epOption],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpointStatus')
				const status = instance.endpointStatus.get(Number(feedback.options['endpointId']))
				const dpId = (status?.['association'] as DeviceRecord | undefined)?.['dpId'] as number | undefined
				return dpId !== undefined ? (dpId as JsonValue) : null
			},
		},

		// ── Gateway (antenna) ─────────────────────────────────────────────────
		gateway_online: {
			type: 'boolean',
			name: '[Antenna] Online',
			defaultStyle: { bgcolor: 0x00ff00, color: 0x000000 } satisfies Partial<CompanionFeedbackButtonStyleResult>,
			options: [
				{
					type: 'dropdown',
					id: 'endpointId',
					label: 'Antenna',
					default: [...instance.gateways.keys()][0]?.toString() ?? '',
					choices: [...instance.gateways.values()].map((g) => ({ id: String(g['id']), label: String(g['label']) })),
				},
			],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpoints')
				const gw = instance.gateways.get(Number(feedback.options['endpointId']))
				const status = (gw?.['liveStatus'] as DeviceRecord | undefined)?.['status'] ?? gw?.['status']
				return status === 'online'
			},
		},

		gateway_status: {
			type: 'value',
			name: '[Antenna] Status',
			options: [
				{
					type: 'dropdown',
					id: 'endpointId',
					label: 'Antenna',
					default: [...instance.gateways.keys()][0]?.toString() ?? '',
					choices: [...instance.gateways.values()].map((g) => ({ id: String(g['id']), label: String(g['label']) })),
				},
			],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'endpoints')
				const gw = instance.gateways.get(Number(feedback.options['endpointId']))
				return ((gw?.['liveStatus'] as DeviceRecord | undefined)?.['status'] ?? gw?.['status'] ?? null) as JsonValue
			},
		},

		// ── Active calls ──────────────────────────────────────────────────────
		active_calls: {
			type: 'value',
			name: 'Active Calls',
			options: [],
			unsubscribe: unsubscribeFn(instance),
			callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
				subscribe(instance, feedback.feedbackId, 'connections')
				const calling: string[] = []
				const seen = new Set<number>()
				for (const conn of instance.connections.values()) {
					const events = conn['events'] as DeviceRecord | undefined
					if (events?.['call']) calling.push(`${conn['label']} (${conn['id']})`)
					const participants = (conn['participants'] as DeviceRecord[] | undefined) ?? []
					for (const p of participants) {
						const pId = p['id'] as number
						const pEvents = p['events'] as DeviceRecord | undefined
						if (pEvents?.['call'] && !seen.has(pId)) {
							calling.push(`${p['label']} (${pId})`)
							seen.add(pId)
						}
					}
				}
				return calling as unknown as JsonValue
			},
		},

		// ── 2W Nulling status ─────────────────────────────────────────────────
		...([...instance.ports.values()].some((p) => p['port_config_type'] === '2W')
			? {
					port_2w_nulling_status: {
						type: 'value',
						name: '[2W] Nulling Status',
						options: [
							{
								type: 'dropdown',
								id: 'portId',
								label: 'Port',
								default:
									portChoices(instance).find((p) => {
										const port = [...instance.ports.values()].find((pr) => String(pr['port_id']) === p.id)
										return port?.['port_config_type'] === '2W'
									})?.id ?? '',
								choices: portChoices(instance).filter((p) => {
									const port = instance.ports.get(Number(p.id))
									return port?.['port_config_type'] === '2W'
								}),
							},
						],
						unsubscribe: unsubscribeFn(instance),
						callback: (feedback: { feedbackId: string; options: Record<string, unknown> }) => {
							subscribe(instance, feedback.feedbackId, 'nulling')
							return (instance.nullingStatus.get(Number(feedback.options['portId'])) ?? null) as JsonValue
						},
					},
				}
			: {}),
	}

	return feedbacks
}

// ─── Meter feedback ───────────────────────────────────────────────────────────

function buildMeterFeedback(): Record<string, CompanionAdvancedFeedbackDefinition> {
	return {
		meter: {
			type: 'advanced',
			name: '[Meter]',
			options: [
				{
					type: 'dropdown',
					id: 'style',
					label: 'Style',
					default: 'bar-horizontal',
					choices: [
						{ id: 'bar-horizontal', label: 'Bar (horizontal)' },
						{ id: 'bar-vertical', label: 'Bar (vertical)' },
						{ id: 'circle', label: 'Circle' },
					],
				},
				{ type: 'number', id: 'thickness', label: 'Thickness', default: 8, min: 1, max: 36 },
				{ type: 'number', id: 'x', label: 'X Position', default: 0, min: -60, max: 60 },
				{ type: 'number', id: 'y', label: 'Y Position', default: 0, min: -60, max: 60 },
				{ type: 'number', id: 'scale', label: 'Scale', default: 1, min: 0.2, max: 1, step: 0.01, range: true },
				{ type: 'number', id: 'min', label: 'Min', default: 0, min: -999, max: 999 },
				{ type: 'number', id: 'max', label: 'Max', default: 100, min: -999, max: 999 },
				{
					type: 'number',
					id: 'yellowStart',
					label: 'Yellow From',
					default: 50,
					min: -999,
					max: 999,
					tooltip: 'Make Yellow > Red to reverse the colors',
				},
				{
					type: 'number',
					id: 'redStart',
					label: 'Red From',
					default: 75,
					min: -999,
					max: 999,
					tooltip: 'Make Yellow > Red to reverse the colors',
				},
				{ type: 'textinput', id: 'value', label: 'Value', default: '0' },
			],
			callback: (feedback) =>
				drawMeter({
					style: feedback.options['style'] as MeterStyle,
					thickness: Number(feedback.options['thickness']),
					x: Number(feedback.options['x']),
					y: Number(feedback.options['y']),
					min: Number(feedback.options['min']),
					max: Number(feedback.options['max']),
					yellowStart: Number(feedback.options['yellowStart']),
					redStart: Number(feedback.options['redStart']),
					scale: Number(feedback.options['scale']),
					value: Number(feedback.options['value']),
					width: feedback.image?.width,
					height: feedback.image?.height,
				}),
		},
	}
}

// ─── Public entry point ───────────────────────────────────────────────────────

export function UpdateFeedbacks(instance: ModuleInstance): void {
	instance.setFeedbackDefinitions({
		...buildDefsFeedbacks(instance),
		...buildManualFeedbacks(instance),
		...buildMeterFeedback(),
	} as unknown as Parameters<typeof instance.setFeedbackDefinitions>[0])
}
